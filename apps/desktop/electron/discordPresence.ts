// Discord Rich Presence over Discord's local IPC socket — implemented directly (no dependency) so the
// VMP-signed build stays clean. Discord exposes a named pipe (Windows) / unix socket (mac/Linux) at
// `discord-ipc-{0..9}`; we connect, handshake with the app's client id, then push SET_ACTIVITY frames.
//
// Everything degrades gracefully: if Discord isn't running the connect just fails and we retry later,
// so the rest of the app never blocks or errors on its account.

import { createConnection, type Socket } from "node:net";

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const RECONNECT_DELAY_MS = 15_000;
const CONNECT_TIMEOUT_MS = 2_000;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 512 * 1024;

/** A music-listening activity to show on the user's Discord profile. */
export interface DiscordActivity {
  /** Top line — the track title. */
  details?: string;
  /** Second line — usually "by <artists>". */
  state?: string;
  /** Epoch ms the track started playing; Discord renders an elapsed timer. Omit when paused. */
  startTimestamp?: number;
  /** Uploaded asset key for the large art (Discord doesn't render raw URLs over IPC). */
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  /** Up to 2 link buttons (e.g. "Open in SoundCloud"). */
  buttons?: Array<{ label: string; url: string }>;
}

/** Candidate socket paths Discord may be listening on, in priority order. */
function candidatePipePaths(): string[] {
  if (process.platform === "win32") {
    return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  }
  const base = (
    process.env.XDG_RUNTIME_DIR ||
    process.env.TMPDIR ||
    process.env.TMP ||
    process.env.TEMP ||
    "/tmp"
  ).replace(/\/$/, "");
  // Plain, plus the Flatpak/Snap sandbox locations Discord uses on Linux.
  const prefixes = ["", "app/com.discordapp.Discord/", "snap.discord/"];
  const paths: string[] = [];
  for (const prefix of prefixes) {
    for (let i = 0; i < 10; i += 1) {
      paths.push(`${base}/${prefix}discord-ipc-${i}`);
    }
  }
  return paths;
}

function makeNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clamp(text: string | undefined, max = 128): string | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export class DiscordPresenceClient {
  private socket?: Socket;
  private connected = false;
  private connecting = false;
  private destroyed = false;
  private clientId = "";
  private buffer = Buffer.alloc(0);
  private desired: DiscordActivity | null = null;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /** Begin connecting with the given Discord application (client) id. No-op without an id. */
  start(clientId: string): void {
    this.clientId = (clientId ?? "").trim();
    this.destroyed = false;
    if (!this.clientId) {
      return;
    }
    void this.connect();
  }

  /** Set (or with null, clear) the activity. Buffered until connected and re-sent on reconnect. */
  setActivity(activity: DiscordActivity | null): void {
    this.desired = activity;
    if (this.connected) {
      this.sendActivity();
    } else {
      void this.connect();
    }
  }

  /** Tear down for good (app quit). Closing the socket clears the presence on Discord's side. */
  stop(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.cleanupSocket();
  }

  private async connect(): Promise<void> {
    if (this.connected || this.connecting || this.destroyed || !this.clientId) {
      return;
    }
    this.connecting = true;
    for (const path of candidatePipePaths()) {
      if (this.destroyed) {
        break;
      }
      const ok = await this.tryPath(path);
      if (ok) {
        this.connecting = false;
        return;
      }
    }
    this.connecting = false;
    this.scheduleReconnect();
  }

  private tryPath(path: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      const socket = createConnection(path);
      const timer = setTimeout(() => {
        socket.destroy();
        finish(false);
      }, CONNECT_TIMEOUT_MS);

      socket.on("connect", () => {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.write(OP_HANDSHAKE, { v: 1, client_id: this.clientId });
      });

      socket.on("data", (chunk) => {
        const data = typeof chunk === "string" ? Buffer.from(chunk, "binary") : chunk;
        this.buffer = Buffer.concat([this.buffer, data]);
        if (this.buffer.length > MAX_BUFFER_BYTES) {
          socket.destroy();
          return;
        }
        const valid = this.drainFrames((op, payload) => {
          if (op === OP_PING) {
            this.write(OP_PONG, payload);
            return;
          }
          if (op === OP_CLOSE) {
            socket.destroy();
            return;
          }
          if (op === OP_FRAME && payload?.evt === "READY") {
            this.connected = true;
            this.sendActivity();
            finish(true);
          }
        });
        if (!valid) {
          socket.destroy();
        }
      });

      const onGone = () => {
        if (this.socket === socket) {
          this.onDisconnect();
        }
        finish(false);
      };
      socket.on("error", onGone);
      socket.on("close", onGone);
    });
  }

  private drainFrames(handle: (op: number, payload: { evt?: string } | undefined) => void): boolean {
    while (this.buffer.length >= 8) {
      const op = this.buffer.readUInt32LE(0);
      const length = this.buffer.readUInt32LE(4);
      if (length > MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        return false;
      }
      if (this.buffer.length < 8 + length) {
        break;
      }
      const body = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      let payload: { evt?: string } | undefined;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = {};
      }
      handle(op, payload);
    }
    return true;
  }

  private write(op: number, data: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    const json = Buffer.from(JSON.stringify(data), "utf8");
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(json.length, 4);
    try {
      this.socket.write(Buffer.concat([header, json]));
    } catch {
      // ignore — a dead socket triggers reconnect via the close/error handlers
    }
  }

  private sendActivity(): void {
    if (!this.connected) {
      return;
    }
    this.write(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity: this.desired ? this.toRpcActivity(this.desired) : null },
      nonce: makeNonce()
    });
  }

  private toRpcActivity(activity: DiscordActivity): Record<string, unknown> {
    const assets: Record<string, string> = {};
    if (activity.largeImageKey) {
      assets.large_image = activity.largeImageKey;
    }
    const largeText = clamp(activity.largeImageText);
    if (largeText) {
      assets.large_text = largeText;
    }
    if (activity.smallImageKey) {
      assets.small_image = activity.smallImageKey;
    }
    const smallText = clamp(activity.smallImageText);
    if (smallText) {
      assets.small_text = smallText;
    }

    const rpc: Record<string, unknown> = {};
    const details = clamp(activity.details);
    if (details) {
      rpc.details = details;
    }
    const state = clamp(activity.state);
    if (state) {
      rpc.state = state;
    }
    if (activity.startTimestamp) {
      rpc.timestamps = { start: Math.floor(activity.startTimestamp / 1_000) };
    }
    if (Object.keys(assets).length > 0) {
      rpc.assets = assets;
    }
    const buttons = (activity.buttons ?? []).filter((b) => b.label && /^https?:\/\//i.test(b.url)).slice(0, 2);
    if (buttons.length > 0) {
      rpc.buttons = buttons;
    }
    return rpc;
  }

  private onDisconnect(): void {
    const hadSocket = this.socket != null || this.connected;
    this.cleanupSocket();
    if (hadSocket && !this.destroyed) {
      this.scheduleReconnect();
    }
  }

  private cleanupSocket(): void {
    this.connected = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
      this.socket = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer || !this.clientId) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }
}
