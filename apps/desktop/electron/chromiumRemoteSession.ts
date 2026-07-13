// Reads a Chromium profile's cookies by briefly relaunching the *real* browser in headless mode
// against a private copy of the profile and reading them over the DevTools (CDP) protocol. The
// browser decrypts its own cookies, so this works even when the on-disk cookies use Windows
// App-Bound Encryption (v20), which cannot be decrypted by any external process.
//
// Nothing is injected into the user's browser and no files are placed in its install directory —
// we only spawn the browser executable with standard command-line flags. We copy just `Local State`
// plus the profile's `Cookies` DB into a throwaway `--user-data-dir`; pointing at that non-default
// directory also sidesteps Chrome 136+ ignoring `--remote-debugging-port` on the default profile.
//
// The caller must ensure the user's own browser is fully closed first (so the locked Cookies DB can
// be copied and the temp instance starts cleanly).

import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";

export interface RemoteCookie {
  name: string;
  value: string;
  domain: string;
}

export interface RemoteSessionOptions {
  /** Absolute path to the browser executable (e.g. chrome.exe / msedge.exe). */
  executablePath: string;
  /** The browser's user-data-dir, which holds `Local State` and the profile folder. */
  userDataDirectory: string;
  /** Profile folder name, e.g. "Default" or "Profile 1". */
  profileDirectory: string;
}

export interface RemoteLikeOptions extends RemoteSessionOptions {
  /** The signed-in SoundCloud OAuth token (plaintext `oauth_token`). */
  oauthToken: string;
  /** Public SoundCloud client_id used for api-v2 calls. */
  clientId: string;
  /** Numeric SoundCloud track id to like/unlike. */
  trackId: string;
  /** True to like, false to unlike. */
  liked: boolean;
  /** The user's real `datadome` cookie, injected as a fallback if the live one doesn't load. */
  dataDomeCookie?: string;
}

/**
 * The outcome of a like attempt run inside the owning browser. `stage` records how far it got so the
 * caller can tell a recoverable browser-reachability problem (eligible for an in-app fallback) from a
 * definitive SoundCloud rejection.
 */
export interface RemoteLikeResult {
  ok: boolean;
  stage: "spawn" | "endpoint" | "navigate" | "me" | "write" | "error";
  status: number;
  body?: string;
  message?: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Asks the OS for an unused loopback TCP port for the debugging endpoint. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not allocate a debugging port.")));
      }
    });
  });
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/** Builds a minimal throwaway user-data-dir containing only what's needed to read cookies. */
async function buildProfileCopy(options: RemoteSessionOptions): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "amp-cdp-"));

  // `Local State` holds the os_crypt key the browser uses to decrypt its own cookies.
  await copyFile(
    path.join(options.userDataDirectory, "Local State"),
    path.join(tempRoot, "Local State")
  ).catch(() => undefined);

  const destProfile = path.join(tempRoot, "Default");
  await mkdir(path.join(destProfile, "Network"), { recursive: true });

  // Newer Chromium keeps cookies under `Network/Cookies`; older profiles keep them at `Cookies`.
  const sourceProfile = path.join(options.userDataDirectory, options.profileDirectory);
  const layouts = [
    { from: path.join(sourceProfile, "Network", "Cookies"), to: path.join(destProfile, "Network", "Cookies") },
    { from: path.join(sourceProfile, "Cookies"), to: path.join(destProfile, "Cookies") }
  ];
  for (const { from, to } of layouts) {
    try {
      await copyFile(from, to);
    } catch {
      continue; // candidate absent — try the next layout
    }
    for (const ext of ["-wal", "-shm"]) {
      await copyFile(from + ext, to + ext).catch(() => undefined);
    }
  }
  return tempRoot;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

// A real navigation is required before reading cookies: in headless mode the cookie store is only
// loaded once the network service initializes for an actual page. `about:blank`/`data:` URLs don't
// trigger that (and a browser-level `Storage.getCookies` returns nothing), so we navigate to the
// SoundCloud origin and read the full store — which includes every domain — from that page session.
const COOKIE_LOAD_URL = "https://soundcloud.com/";

/**
 * Connects to the browser-level CDP socket, opens a SoundCloud page so the cookie store loads, reads
 * every cookie via `Network.getAllCookies`, then asks the browser to close.
 */
function readCookiesOverWebSocket(webSocketUrl: string): Promise<RemoteCookie[]> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    return Promise.reject(new Error("This desktop runtime cannot read the browser session."));
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(webSocketUrl);
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 0;
    let settled = false;

    const timer = setTimeout(() => fail(new Error("Timed out while reading the browser session.")), 20_000);

    function close(): void {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    function fail(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      close();
      reject(error);
    }
    function succeed(cookies: RemoteCookie[]): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(JSON.stringify({ id: ++nextId, method: "Browser.close" }));
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        resolve(cookies);
      }, 150);
    }
    function send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
      const id = ++nextId;
      const message: Record<string, unknown> = { id, method, params: params ?? {} };
      if (sessionId) {
        message.sessionId = sessionId;
      }
      return new Promise((resolveCmd, rejectCmd) => {
        pending.set(id, { resolve: resolveCmd, reject: rejectCmd });
        socket.send(JSON.stringify(message));
      });
    }

    socket.addEventListener("message", (event) => {
      let payload: CdpResponse;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof payload.id === "number" && pending.has(payload.id)) {
        const waiter = pending.get(payload.id)!;
        pending.delete(payload.id);
        if (payload.error) {
          waiter.reject(new Error(payload.error.message ?? "DevTools command failed."));
        } else {
          waiter.resolve(payload.result);
        }
      }
    });

    socket.addEventListener("open", () => {
      void (async () => {
        try {
          const target = (await send("Target.createTarget", { url: COOKIE_LOAD_URL })) as { targetId: string };
          const attached = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as {
            sessionId: string;
          };
          await send("Network.enable", {}, attached.sessionId).catch(() => undefined);

          // The profile's persisted cookie store loads asynchronously after navigation begins, so an
          // early read returns only the 1-2 cookies set the instant the page starts — long before the
          // full store (which holds the SoundCloud oauth_token) is available. Poll, keeping the
          // largest snapshot, and stop the moment the auth cookie appears. For a profile that genuinely
          // isn't signed in, this polls until the store settles and returns whatever loaded.
          const deadline = Date.now() + 12_000;
          let best: RemoteCookie[] = [];
          while (Date.now() < deadline && !settled) {
            const result = (await send(
              "Network.getCookies",
              { urls: ["https://soundcloud.com/", "https://api-v2.soundcloud.com/"] },
              attached.sessionId
            )) as {
              cookies?: RemoteCookie[];
            };
            const cookies = result.cookies ?? [];
            if (cookies.length > best.length) {
              best = cookies;
            }
            const hasAuthCookie = cookies.some(
              (cookie) =>
                cookie.name === "oauth_token" &&
                /(^|\.)soundcloud\.com$/i.test(cookie.domain ?? "") &&
                Boolean(cookie.value) &&
                cookie.value.length > 8
            );
            if (hasAuthCookie) {
              best = cookies;
              break;
            }
            await wait(600);
          }
          succeed(best);
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Failed to read cookies over DevTools."));
        }
      })();
    });

    socket.addEventListener("error", () => fail(new Error("Could not access the browser session.")));
  });
}

// ---------------------------------------------------------------------------------------------------
// Interactive SoundCloud sign-in inside the user's REAL browser.
//
// SoundCloud's DataDome anti-bot HARD-BLOCKS logins from an embedded Electron window (it fingerprints
// as automation). The fix is to log in inside the user's actual Chrome/Edge/Brave — a real browser
// DataDome trusts (and, if challenged, serves a solvable CAPTCHA rather than a hard block). We launch
// it visibly against a DEDICATED, PERSISTENT AMP profile (a non-default --user-data-dir, so Chrome
// 136+ still honours --remote-debugging-port) and read the oauth_token from the LIVE session over
// CDP. Reading the running browser's cookies over the wire sidesteps App-Bound Encryption entirely,
// so this works on Chrome and Edge, not just Brave. The profile persists, so the next sync can read
// the refreshed token silently with no re-login.
// ---------------------------------------------------------------------------------------------------

const SOUNDCLOUD_SIGNIN_PAGE = "https://soundcloud.com/signin";

/**
 * Terminate ONLY the browser instance whose command line references our private login profile dir —
 * never the user's real browser. With `--user-data-dir`, the spawned exe often delegates to a forked
 * browser process and the launcher we hold exits, so `child.kill()` can no-op; CDP `Browser.close`
 * is best-effort. This is the guaranteed backstop so an orphaned browser can't keep the profile's
 * SingletonLock and wedge every future sign-in. Matched on the distinctive leaf dir name only.
 */
function killBrowserHoldingProfile(loginProfileDir: string): Promise<void> {
  const leaf = path.basename(loginProfileDir); // e.g. "soundcloud-login" — unique to AMP
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${leaf}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true },
        () => resolve()
      );
    } else {
      // pkill -f matches the full command line, which includes --user-data-dir=<...>/soundcloud-login.
      execFile("pkill", ["-f", leaf], () => resolve());
    }
  });
}

export interface BrowserSignInOptions {
  /** Absolute path to a Chromium executable (chrome.exe / msedge.exe / brave.exe). */
  executablePath: string;
  /** Persistent AMP-owned user-data-dir for the SoundCloud login (NOT the user's real profile). */
  loginProfileDir: string;
  /** True to relaunch headless and read the existing session silently (no visible window). */
  silent?: boolean;
}

export interface BrowserSignInResult {
  ok: boolean;
  token?: string;
  cookies: RemoteCookie[];
  /** "ok" on success; otherwise how it ended, so the caller can message appropriately. */
  stage: "ok" | "spawn" | "endpoint" | "cancelled" | "timeout" | "error";
  message?: string;
}

/**
 * Launches the user's real browser at the SoundCloud login (or headless for a silent re-read),
 * then polls the live session over CDP until the `oauth_token` cookie appears. Never throws —
 * failures come back as a `BrowserSignInResult`. Leaves the persistent profile dir in place.
 */
export async function signInToSoundCloudViaBrowser(
  options: BrowserSignInOptions
): Promise<BrowserSignInResult> {
  await mkdir(options.loginProfileDir, { recursive: true }).catch(() => undefined);
  const port = await findFreePort();
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--disable-features=Translate,InfobarUI",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.loginProfileDir}`
  ];
  if (options.silent) {
    args.push("--headless=new", "--disable-gpu");
  }
  args.push(SOUNDCLOUD_SIGNIN_PAGE);

  let spawnError: Error | undefined;
  const child = spawn(options.executablePath, args, { windowsHide: options.silent, stdio: "ignore" });
  // A stale executablePath (browser uninstalled/moved since we listed it) errors here — capture it so
  // we fail fast instead of polling a dead port for 15s.
  child.on("error", (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
  });

  try {
    const deadline = Date.now() + 15_000;
    let webSocketUrl: string | undefined;
    while (Date.now() < deadline && !webSocketUrl && !spawnError) {
      const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
        `http://127.0.0.1:${port}/json/version`
      );
      webSocketUrl = version?.webSocketDebuggerUrl;
      if (!webSocketUrl) {
        await wait(300);
      }
    }
    if (spawnError) {
      return { ok: false, cookies: [], stage: "spawn", message: `Could not launch the browser (${spawnError.message}).` };
    }
    if (!webSocketUrl) {
      return { ok: false, cookies: [], stage: "endpoint", message: "The browser did not expose a debugging endpoint." };
    }
    // Silent re-reads settle fast (cookies already present); interactive logins get 5 minutes.
    return await pollForSoundCloudTokenOverWebSocket(webSocketUrl, options.silent ? 20_000 : 5 * 60_000);
  } finally {
    // The OS-spawned browser is often a different process than `child` (the launcher delegates and
    // exits), so child.kill() can no-op and a dropped Browser.close would orphan the window. Give
    // the CDP close a moment, then guarantee termination by killing whoever still owns our profile.
    try {
      child.kill();
    } catch {
      // backstop only
    }
    await wait(400);
    await killBrowserHoldingProfile(options.loginProfileDir).catch(() => undefined);
  }
}

/**
 * Over one browser-level CDP socket: attach to the login page target, then poll Network.getAllCookies
 * until the SoundCloud oauth_token appears. Resolves cancelled if the user closes the browser (socket
 * closes) or timed out otherwise. Closes the (dedicated) browser instance on success.
 */
function pollForSoundCloudTokenOverWebSocket(
  webSocketUrl: string,
  timeoutMs: number
): Promise<BrowserSignInResult> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    return Promise.resolve({ ok: false, cookies: [], stage: "error", message: "This runtime cannot drive the browser." });
  }

  return new Promise((resolve) => {
    const socket = new WebSocketCtor(webSocketUrl);
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 0;
    let settled = false;
    let sessionId: string | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const deadline = setTimeout(
      () => finish({ ok: false, cookies: [], stage: "timeout", message: "Sign-in timed out." }),
      timeoutMs
    );

    function finish(result: BrowserSignInResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      // Close our dedicated browser instance (safe — it's AMP's own profile, not the user's).
      try {
        socket.send(JSON.stringify({ id: ++nextId, method: "Browser.close" }));
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        resolve(result);
      }, 150);
    }

    function send(method: string, params?: Record<string, unknown>, sid?: string): Promise<Record<string, unknown>> {
      const id = ++nextId;
      const message: Record<string, unknown> = { id, method, params: params ?? {} };
      if (sid) {
        message.sessionId = sid;
      }
      return new Promise((resolveCmd, rejectCmd) => {
        pending.set(id, { resolve: resolveCmd as (value: unknown) => void, reject: rejectCmd });
        socket.send(JSON.stringify(message));
      });
    }

    socket.addEventListener("message", (event) => {
      let payload: CdpResponse;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof payload.id === "number" && pending.has(payload.id)) {
        const waiter = pending.get(payload.id)!;
        pending.delete(payload.id);
        if (payload.error) {
          waiter.reject(new Error(payload.error.message ?? "DevTools command failed."));
        } else {
          waiter.resolve(payload.result);
        }
      }
    });

    // Attach to a page target so we can read cookies. Re-resolvable: the login flow can swap the
    // tab's target (cross-process navigation, or the user lands on a fresh tab), so we re-attach
    // whenever the session is lost rather than failing.
    const attachToPage = async (): Promise<boolean> => {
      const targets = (await send("Target.getTargets")) as {
        targetInfos?: Array<{ targetId: string; type: string; url: string }>;
      };
      // Prefer a soundcloud tab; fall back to any page so we still read the shared cookie jar.
      const pages = (targets.targetInfos ?? []).filter((target) => target.type === "page");
      const page =
        pages.find((target) => {
          try {
            const hostname = new URL(target.url).hostname;
            return hostname === "soundcloud.com" || hostname.endsWith(".soundcloud.com");
          } catch {
            return false;
          }
        }) ?? pages[0];
      if (!page) {
        return false;
      }
      const attached = (await send("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true
      })) as { sessionId: string };
      sessionId = attached.sessionId;
      await send("Network.enable", {}, sessionId).catch(() => undefined);
      return true;
    };

    socket.addEventListener("open", () => {
      void (async () => {
        try {
          // Wait for the login tab to appear as the browser starts.
          for (let attempt = 0; attempt < 24 && !settled && !sessionId; attempt += 1) {
            if (await attachToPage()) {
              break;
            }
            await wait(500);
          }
          if (!sessionId) {
            finish({ ok: false, cookies: [], stage: "error", message: "Could not attach to the browser tab." });
            return;
          }

          // Cookies are shared across the profile, so reading from the login tab's session returns
          // the oauth_token the instant SoundCloud sets it — across the login's cross-origin hops.
          pollTimer = setInterval(() => {
            void (async () => {
              if (settled) {
                return;
              }
              try {
                if (!sessionId && !(await attachToPage())) {
                  return;
                }
                const result = (await send(
                  "Network.getCookies",
                  { urls: ["https://soundcloud.com/", "https://api-v2.soundcloud.com/"] },
                  sessionId
                )) as {
                  cookies?: RemoteCookie[];
                };
                const cookies = result.cookies ?? [];
                const auth = cookies.find(
                  (cookie) =>
                    cookie.name === "oauth_token" &&
                    /(^|\.)soundcloud\.com$/i.test(cookie.domain ?? "") &&
                    Boolean(cookie.value) &&
                    cookie.value.length > 8
                );
                if (auth) {
                  finish({ ok: true, token: decodeURIComponent(auth.value), cookies, stage: "ok" });
                }
              } catch {
                // The attached target likely went away (navigation) — drop it so we re-attach next tick.
                sessionId = undefined;
              }
            })();
          }, 2000);
        } catch (error) {
          finish({
            ok: false,
            cookies: [],
            stage: "error",
            message: error instanceof Error ? error.message : "Failed to drive the browser."
          });
        }
      })();
    });

    // User closed the browser before signing in → the debugging socket drops.
    socket.addEventListener("close", () => {
      finish({ ok: false, cookies: [], stage: "cancelled", message: "Sign-in was cancelled." });
    });
    socket.addEventListener("error", () => {
      finish({ ok: false, cookies: [], stage: "error", message: "Lost the browser connection." });
    });
  });
}

/**
 * Reads all cookies from a Chromium profile via a brief headless relaunch + CDP. The caller must
 * ensure the user's own browser is fully closed first. Always cleans up the temp profile copy and
 * the spawned process, even on failure.
 */
export async function readChromiumCookiesViaRemoteDebugging(
  options: RemoteSessionOptions
): Promise<RemoteCookie[]> {
  const tempRoot = await buildProfileCopy(options);
  const port = await findFreePort();
  const child = spawn(
    options.executablePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-allow-origins=*",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempRoot}`
    ],
    { windowsHide: true, stdio: "ignore" }
  );
  child.on("error", () => undefined);

  try {
    const deadline = Date.now() + 15_000;
    let webSocketUrl: string | undefined;
    while (Date.now() < deadline && !webSocketUrl) {
      const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
        `http://127.0.0.1:${port}/json/version`
      );
      webSocketUrl = version?.webSocketDebuggerUrl;
      if (!webSocketUrl) {
        await wait(300);
      }
    }
    if (!webSocketUrl) {
      throw new Error("The browser did not expose a debugging endpoint.");
    }
    return await readCookiesOverWebSocket(webSocketUrl);
  } finally {
    try {
      child.kill();
    } catch {
      // ignore
    }
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------
// Liking a track from the owning browser.
//
// SoundCloud's anti-bot (DataDome) binds its clearance cookie to the *browser fingerprint*. A like
// WRITE replayed from Electron's Chromium — even carrying the user's real cookies — looks like a
// different browser than the one DataDome cleared, so it gets CAPTCHA-challenged every time. Running
// the write inside the user's actual browser (the one that earned the clearance) sidesteps that: same
// fingerprint, same trusted cookie, no challenge. We reuse the headless relaunch from Local Connect.
// ---------------------------------------------------------------------------------------------------

/**
 * Builds the in-page script that performs the like. Runs inside a real soundcloud.com page, so the
 * cross-origin api-v2 fetches mirror what SoundCloud's own web client does (CORS + credentials).
 * Values are JSON-encoded rather than string-interpolated so a token containing quotes can't break
 * out of the expression.
 */
export function buildSoundCloudLikeScript(
  oauthToken: string,
  clientId: string,
  trackId: string,
  liked: boolean
): string {
  const method = liked ? "PUT" : "DELETE";
  return `(async () => {
    try {
      const auth = { Authorization: 'OAuth ' + ${JSON.stringify(oauthToken)} };
      const cid = ${JSON.stringify(clientId)};
      const meRes = await fetch('https://api-v2.soundcloud.com/me?client_id=' + cid, { headers: auth, credentials: 'include' });
      if (!meRes.ok) return { ok: false, stage: 'me', status: meRes.status, body: (await meRes.text()).slice(0, 300) };
      const me = await meRes.json();
      if (!me || !me.id) return { ok: false, stage: 'me', status: 0 };
      const url = 'https://api-v2.soundcloud.com/users/' + me.id + '/track_likes/' + ${JSON.stringify(trackId)} + '?client_id=' + cid;
      const res = await fetch(url, { method: ${JSON.stringify(method)}, headers: auth, credentials: 'include' });
      const body = res.ok ? '' : (await res.text()).slice(0, 300);
      return { ok: res.ok, stage: 'write', status: res.status, body };
    } catch (e) { return { ok: false, stage: 'error', status: 0, message: String(e) }; }
  })()`;
}

/**
 * Maps a raw like attempt to a user-facing message. Returns "" on success. Pure so it can be tested
 * without a browser. Callers treat the `endpoint`/`error`/`spawn` stages as recoverable (the browser
 * couldn't be driven) and may fall back to the in-app path; everything else is a SoundCloud verdict.
 */
export function describeRemoteLikeFailure(result: RemoteLikeResult): string {
  if (result.ok) {
    return "";
  }
  const captcha = /captcha-delivery|datadome|geo\.captcha/i.test(result.body ?? "");
  if (result.stage === "me" && (result.status === 401 || result.status === 403) && !captcha) {
    return "Your SoundCloud sign-in expired. Reconnect SoundCloud Local Connect to update likes.";
  }
  if (captcha || result.status === 403 || result.status === 429) {
    return "SoundCloud's anti-bot check blocked the like. Wait a moment and try again.";
  }
  if (result.stage === "spawn" || result.stage === "endpoint" || result.stage === "error" || result.stage === "navigate") {
    return result.message
      ? `Could not reach your browser to save the like (${result.message}).`
      : "Could not reach your browser to save the like.";
  }
  if (result.status > 0) {
    return `SoundCloud like failed (HTTP ${result.status}).`;
  }
  return "SoundCloud like failed.";
}

/** Drives a single like write over an already-open browser-level CDP socket. */
function runLikeOverWebSocket(webSocketUrl: string, options: RemoteLikeOptions): Promise<RemoteLikeResult> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    return Promise.resolve({
      ok: false,
      stage: "error",
      status: 0,
      message: "This desktop runtime cannot drive the browser."
    });
  }

  return new Promise((resolve) => {
    const socket = new WebSocketCtor(webSocketUrl);
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    // CDP events (no `id`) arrive on the same socket; waiters here resolve when their method fires.
    const eventWaiters: Array<{ method: string; sessionId?: string; resolve: (fired: boolean) => void }> = [];
    let nextId = 0;
    let settled = false;

    const timer = setTimeout(
      () => finish({ ok: false, stage: "error", status: 0, message: "Timed out performing the like." }),
      30_000
    );

    function finish(result: RemoteLikeResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(JSON.stringify({ id: ++nextId, method: "Browser.close" }));
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        resolve(result);
      }, 150);
    }

    function send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
      const id = ++nextId;
      const message: Record<string, unknown> = { id, method, params: params ?? {} };
      if (sessionId) {
        message.sessionId = sessionId;
      }
      return new Promise((resolveCmd, rejectCmd) => {
        pending.set(id, { resolve: resolveCmd, reject: rejectCmd });
        socket.send(JSON.stringify(message));
      });
    }

    // Resolves true when `method` fires on `sessionId`, or false on timeout — used to wait for the
    // page to actually finish loading before running the like (otherwise the fetch runs on the still
    // blank `about:blank` document, whose null origin makes the cross-origin call fail).
    function waitForEvent(method: string, sessionId: string, timeoutMs: number): Promise<boolean> {
      return new Promise((resolveEvent) => {
        const waiter = { method, sessionId, resolve: resolveEvent };
        eventWaiters.push(waiter);
        setTimeout(() => {
          const index = eventWaiters.indexOf(waiter);
          if (index >= 0) {
            eventWaiters.splice(index, 1);
            resolveEvent(false);
          }
        }, timeoutMs);
      });
    }

    socket.addEventListener("message", (event) => {
      let payload: CdpResponse & { method?: string; sessionId?: string };
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof payload.id === "number" && pending.has(payload.id)) {
        const waiter = pending.get(payload.id)!;
        pending.delete(payload.id);
        if (payload.error) {
          waiter.reject(new Error(payload.error.message ?? "DevTools command failed."));
        } else {
          waiter.resolve(payload.result);
        }
        return;
      }
      if (payload.method) {
        for (let index = eventWaiters.length - 1; index >= 0; index -= 1) {
          const waiter = eventWaiters[index];
          if (waiter.method === payload.method && (!waiter.sessionId || waiter.sessionId === payload.sessionId)) {
            eventWaiters.splice(index, 1);
            waiter.resolve(true);
          }
        }
      }
    });

    socket.addEventListener("open", () => {
      void (async () => {
        try {
          // Start blank so we can attach + subscribe to the load event BEFORE navigating — otherwise
          // a fast load can fire before we're listening and we'd evaluate against a half-loaded page.
          const target = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
          const attached = (await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as {
            sessionId: string;
          };
          const sessionId = attached.sessionId;
          await send("Page.enable", {}, sessionId).catch(() => undefined);
          await send("Network.enable", {}, sessionId).catch(() => undefined);
          // The like fetch authenticates via the OAuth header, but seed the cookie jar so the very
          // first soundcloud.com load is already signed in. The copied profile carries the real
          // datadome clearance; seed the stored one too in case the copy raced the cookie store.
          await send(
            "Network.setCookie",
            {
              name: "oauth_token",
              value: options.oauthToken,
              domain: ".soundcloud.com",
              path: "/",
              secure: true,
              httpOnly: true,
              sourceScheme: "Secure"
            },
            sessionId
          ).catch(() => undefined);
          if (options.dataDomeCookie) {
            await send(
              "Network.setCookie",
              {
                name: "datadome",
                value: options.dataDomeCookie,
                domain: ".soundcloud.com",
                path: "/",
                secure: true,
                sourceScheme: "Secure"
              },
              sessionId
            ).catch(() => undefined);
          }

          // Navigate to the real origin and wait for it to load, so the like fetch runs from a true
          // soundcloud.com page (correct origin for the cross-origin api-v2 call) with DataDome cleared.
          const loaded = waitForEvent("Page.loadEventFired", sessionId, 15_000);
          await send("Page.navigate", { url: COOKIE_LOAD_URL }, sessionId).catch(() => undefined);
          await loaded;
          // Give DataDome's inline JS and any client-side redirect a moment to settle post-load.
          await wait(1_200);
          if (settled) {
            return;
          }

          const evaluated = (await send(
            "Runtime.evaluate",
            {
              expression: buildSoundCloudLikeScript(
                options.oauthToken,
                options.clientId,
                options.trackId,
                options.liked
              ),
              awaitPromise: true,
              returnByValue: true
            },
            sessionId
          )) as { result?: { value?: RemoteLikeResult } };

          const value = evaluated?.result?.value;
          if (value && typeof value === "object") {
            finish(value);
          } else {
            finish({ ok: false, stage: "error", status: 0, message: "No result from the like request." });
          }
        } catch (error) {
          finish({
            ok: false,
            stage: "error",
            status: 0,
            message: error instanceof Error ? error.message : "Failed to like over DevTools."
          });
        }
      })();
    });

    socket.addEventListener("error", () =>
      finish({ ok: false, stage: "error", status: 0, message: "Could not access the browser session." })
    );
  });
}

/**
 * Likes (or unlikes) a SoundCloud track from inside the user's own browser via a brief headless
 * relaunch + CDP. Because the write runs in the browser DataDome already trusts, it isn't
 * CAPTCHA-challenged the way an Electron-side replay is. Always cleans up the temp profile copy and
 * the spawned process, even on failure. Never throws — failures come back as a `RemoteLikeResult`.
 */
export async function runSoundCloudLikeViaRemoteDebugging(options: RemoteLikeOptions): Promise<RemoteLikeResult> {
  let tempRoot: string;
  try {
    tempRoot = await buildProfileCopy(options);
  } catch (error) {
    return {
      ok: false,
      stage: "spawn",
      status: 0,
      message: error instanceof Error ? error.message : "Could not prepare the browser session."
    };
  }

  const port = await findFreePort();
  // Headful, not headless: DataDome lets reads through from a headless browser but fingerprints it
  // and 403s authenticated WRITES (the like). A real, on-GPU browser window passes — so we run one
  // and park it far off-screen (and minimised) so the user never sees it for the ~5s it lives.
  const child = spawn(
    options.executablePath,
    [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-features=Translate,InfobarUI",
      "--remote-allow-origins=*",
      "--window-position=-32000,-32000",
      "--window-size=480,360",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempRoot}`
    ],
    { windowsHide: true, stdio: "ignore" }
  );
  child.on("error", () => undefined);

  try {
    const deadline = Date.now() + 15_000;
    let webSocketUrl: string | undefined;
    while (Date.now() < deadline && !webSocketUrl) {
      const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
        `http://127.0.0.1:${port}/json/version`
      );
      webSocketUrl = version?.webSocketDebuggerUrl;
      if (!webSocketUrl) {
        await wait(300);
      }
    }
    if (!webSocketUrl) {
      return { ok: false, stage: "endpoint", status: 0, message: "The browser did not expose a debugging endpoint." };
    }
    return await runLikeOverWebSocket(webSocketUrl, options);
  } finally {
    try {
      child.kill();
    } catch {
      // ignore
    }
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
