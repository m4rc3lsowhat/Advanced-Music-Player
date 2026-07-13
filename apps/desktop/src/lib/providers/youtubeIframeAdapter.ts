import type {
  PlaybackAdapter,
  PlaybackAdapterEvent,
  PlaybackAdapterListener,
  PlaybackAdapterSnapshot,
  PlaybackContext,
  ProviderCollection,
  TrackCollection,
  UnifiedTrack
} from "@amp/core";
import { clampVolume } from "@amp/core";
import { gatewayRequest, getYouTubePlayerOrigin } from "../desktopBridge";

/*
 * YouTube playback via YouTube's official IFrame Player — the same approach the reliable YT desktop
 * apps use. The real player streams the audio, so there's no stream extraction to fight YouTube's
 * anti-bot rate limits (which 403'd the googlevideo media fetch in the extraction approach).
 *
 * The player page is hosted by the main process on http://127.0.0.1 (the IFrame player won't init
 * from the file:// renderer origin), and this adapter drives it through a hidden cross-origin iframe
 * via postMessage — the same bridge shape as the SoundCloud widget. Trade-offs inherent to the
 * embed: ads on non-Premium accounts, and a minority of videos disallow embedding (onError → skip).
 */

const POSITION_STALE_MS = 2000;

// YT.PlayerState numeric codes.
const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;

interface PlayerMessage {
  __ampyt?: boolean;
  type?: "ready" | "state" | "tick" | "error";
  state?: number;
  position?: number;
  duration?: number;
  code?: number;
}

const emptyCollection = (): TrackCollection => ({
  id: "",
  provider: "youtube",
  kind: "likes",
  title: "",
  items: []
});

export class YouTubeIframeAdapter implements PlaybackAdapter {
  readonly provider = "youtube" as const;
  private listeners = new Set<PlaybackAdapterListener>();
  private iframe?: HTMLIFrameElement;
  private pendingIframe?: HTMLIFrameElement;
  private frameReady?: Promise<HTMLIFrameElement>;
  private playerOrigin?: string;
  private snapshot: PlaybackAdapterSnapshot;
  private currentTrackId?: string;
  private playToken = 0;
  private frameGeneration = 0;
  private messageHandler?: (event: MessageEvent) => void;

  constructor(initialVolume?: number) {
    this.snapshot = {
      provider: "youtube",
      status: "idle",
      positionMs: 0,
      durationMs: 0,
      volume: clampVolume(initialVolume ?? 0.8)
    };
  }

  subscribe(listener: PlaybackAdapterListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async search(query: string): Promise<UnifiedTrack[]> {
    const result = await gatewayRequest<UnifiedTrack[]>({
      provider: "youtube",
      operation: "search",
      variables: { query }
    });
    if (!result.ok || !result.data) {
      throw new Error(result.error ?? "YouTube search failed.");
    }
    return result.data;
  }

  async getCollections(): Promise<ProviderCollection[]> {
    return [];
  }
  async getCollectionTracks(): Promise<TrackCollection> {
    return emptyCollection();
  }
  async getLibrary(): Promise<TrackCollection> {
    return emptyCollection();
  }

  async play(track: UnifiedTrack, context?: PlaybackContext): Promise<void> {
    const token = ++this.playToken;
    const videoId = track.providerTrackId || track.id;
    const startSeconds = Math.max(0, context?.positionMs ?? 0) / 1000;
    this.currentTrackId = videoId;
    this.snapshot = {
      ...this.snapshot,
      status: "loading",
      positionMs: Math.round(startSeconds * 1000),
      durationMs: track.durationMs,
      activeTrackId: videoId,
      error: undefined
    };
    this.emit({ type: "state", snapshot: this.snapshot });

    await this.ensureFrame();
    // A newer play() started while the frame warmed up — abandon this one.
    if (token !== this.playToken) {
      return;
    }
    this.command({ cmd: "volume", volume: Math.round(this.snapshot.volume * 100) });
    this.command({ cmd: "load", videoId, startSeconds }); // loadVideoById autoplays
  }

  async pause(): Promise<void> {
    this.command({ cmd: "pause" });
  }

  async seek(positionMs: number): Promise<void> {
    this.command({ cmd: "seek", seconds: Math.max(0, positionMs / 1000) });
    this.snapshot = { ...this.snapshot, positionMs: Math.max(0, Math.round(positionMs)) };
    this.emit({ type: "state", snapshot: this.snapshot });
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = clampVolume(volume);
    this.snapshot = { ...this.snapshot, volume: clamped };
    this.command({ cmd: "volume", volume: Math.round(clamped * 100) });
  }

  async teardown(): Promise<void> {
    this.playToken += 1;
    this.command({ cmd: "stop" });
    this.disposeFrame();
    this.snapshot = { ...this.snapshot, status: "idle" };
  }

  /** Create (once) the hidden player iframe and resolve when its page reports the player ready. */
  private ensureFrame(): Promise<HTMLIFrameElement> {
    if (this.iframe && this.playerOrigin) {
      return Promise.resolve(this.iframe);
    }
    if (this.frameReady) {
      return this.frameReady;
    }
    const generation = ++this.frameGeneration;
    this.frameReady = (async () => {
      const origin = await getYouTubePlayerOrigin();
      if (generation !== this.frameGeneration) {
        throw new Error("YouTube player initialization was cancelled.");
      }
      if (!origin) {
        throw new Error("YouTube player is unavailable (desktop host not running).");
      }
      this.playerOrigin = origin;

      const iframe = document.createElement("iframe");
      // Off-screen but a real size — a 0×0 YouTube embed can refuse to start (same lesson as the
      // SoundCloud widget). allow=autoplay is required for the player to start without a click.
      iframe.setAttribute("aria-hidden", "true");
      iframe.setAttribute("allow", "autoplay; encrypted-media");
      iframe.style.cssText =
        "position:fixed;left:-9999px;top:-9999px;width:320px;height:180px;border:0;pointer-events:none;opacity:0;";
      iframe.src = origin;
      this.pendingIframe = iframe;

      return await new Promise<HTMLIFrameElement>((resolve, reject) => {
        let settled = false;
        let timeout: number | undefined;
        this.messageHandler = (event: MessageEvent) => {
          if (
            generation !== this.frameGeneration ||
            event.origin !== this.playerOrigin ||
            event.source !== iframe.contentWindow
          ) {
            return;
          }
          const data = event.data as PlayerMessage;
          if (!data || data.__ampyt !== true) {
            return;
          }
          if (data.type === "ready" && !settled) {
            settled = true;
            if (timeout !== undefined) {
              window.clearTimeout(timeout);
            }
            this.iframe = iframe;
            this.pendingIframe = undefined;
            resolve(iframe);
            return;
          }
          this.handlePlayerMessage(data);
        };
        window.addEventListener("message", this.messageHandler);
        iframe.onerror = () => {
          if (!settled) {
            settled = true;
            if (timeout !== undefined) {
              window.clearTimeout(timeout);
            }
            reject(new Error("Couldn't load the YouTube player."));
          }
        };
        document.body.appendChild(iframe);
        // Guard: if the player never signals ready, fail so the queue can move on.
        timeout = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("YouTube player didn't start."));
          }
        }, 15000);
      });
    })();
    const attempt = this.frameReady;
    void attempt.catch(() => this.disposeFrame(generation));
    return this.frameReady;
  }

  private disposeFrame(expectedGeneration?: number): void {
    if (expectedGeneration !== undefined && expectedGeneration !== this.frameGeneration) {
      return;
    }
    this.frameGeneration += 1;
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
      this.messageHandler = undefined;
    }
    this.iframe?.remove();
    this.pendingIframe?.remove();
    this.iframe = undefined;
    this.pendingIframe = undefined;
    this.frameReady = undefined;
    this.playerOrigin = undefined;
  }

  private handlePlayerMessage(data: PlayerMessage): void {
    if (data.type === "error") {
      const code = data.code ?? 0;
      const message =
        code === 101 || code === 150
          ? "This video can't be played outside YouTube (embedding disabled)."
          : code === 100
            ? "This video is unavailable."
            : "Couldn't play this YouTube track.";
      this.emit({
        type: "error",
        snapshot: { ...this.snapshot, status: "error", activeTrackId: this.currentTrackId, error: message }
      });
      return;
    }

    if (data.type === "tick") {
      // Only trust ticks while we believe we're playing; ignore stale/duplicate position noise.
      if (this.snapshot.status === "playing") {
        this.updatePosition(data);
      }
      return;
    }

    if (data.type === "state") {
      if (data.state === YT_ENDED) {
        this.emit({ type: "ended", snapshot: { ...this.snapshot, status: "idle" } });
        return;
      }
      if (data.state === YT_PLAYING) {
        this.snapshot = { ...this.snapshot, status: "playing" };
        this.updatePosition(data);
        return;
      }
      if (data.state === YT_PAUSED) {
        this.snapshot = { ...this.snapshot, status: "paused" };
        this.updatePosition(data);
        return;
      }
      if (data.state === YT_BUFFERING) {
        this.snapshot = { ...this.snapshot, status: "loading" };
        this.emit({ type: "state", snapshot: this.snapshot });
      }
    }
  }

  private updatePosition(data: PlayerMessage): void {
    const positionMs = Number.isFinite(data.position) ? Math.round(data.position as number) : this.snapshot.positionMs;
    const durationMs =
      Number.isFinite(data.duration) && (data.duration as number) > 0
        ? Math.round(data.duration as number)
        : this.snapshot.durationMs;
    // Ignore an obviously stale position report (e.g. a 0 tick right after load).
    void POSITION_STALE_MS;
    this.snapshot = { ...this.snapshot, positionMs, durationMs, activeTrackId: this.currentTrackId };
    this.emit({ type: "state", snapshot: this.snapshot });
  }

  private command(message: Record<string, unknown>): void {
    const target = this.iframe?.contentWindow;
    if (!target || !this.playerOrigin) {
      return;
    }
    target.postMessage({ __ampytcmd: true, ...message }, this.playerOrigin);
  }

  private emit(event: PlaybackAdapterEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
