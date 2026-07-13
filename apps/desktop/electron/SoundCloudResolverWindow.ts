/*
 * ─── SOUNDCLOUD PLAYBACK — GROUND TRUTH (do NOT re-litigate; entitlement is not the issue) ───
 * NO track here requires Go+. The license 403 was never entitlement — it is DataDome anti-bot:
 * SoundCloud's license server only accepts a `license_token` minted inside a REAL browser session
 * whose DataDome client-id was JS-activated by the real browser player. Header /
 * cookie injection on a raw net.request cannot mint an accepted token.
 *
 * This module is the fix attempt: a hidden Chromium BrowserWindow that actually loads soundcloud.com,
 * so DataDome's own JS runs and establishes a native session (cookie). We capture the native
 * `x-datadome-clientid` from the SoundCloud app's own api-v2 requests, then run the /media resolve as
 * an in-page `fetch` carrying that native client-id + the page's datadome cookie + the real renderer
 * fingerprint — to mint a high-trust `license_token` the (cookie-free) license POST will accept.
 */

import { BrowserWindow, session, type Session } from "electron";

const RESOLVER_PARTITION = "persist:sc-resolver";
const SOUNDCLOUD_HOME = "https://soundcloud.com/";
const READY_TIMEOUT_MS = 15_000;
const RESOLVE_TIMEOUT_MS = 20_000;

let windowPromise: Promise<BrowserWindow> | null = null;
let captureInstalled = false;
/** The native DataDome client-id, captured from the SoundCloud app's own api-v2 requests. */
let capturedDatadomeClientId: string | undefined;

function isTrustedSoundCloudUrl(rawUrl: string, apiOnly = false): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    if (apiOnly) return url.hostname === "api-v2.soundcloud.com";
    return url.hostname === "soundcloud.com" || url.hostname.endsWith(".soundcloud.com");
  } catch {
    return false;
  }
}

function guardSoundCloudWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (!isTrustedSoundCloudUrl(url)) {
      event.preventDefault();
      log("blocked navigation outside SoundCloud");
    }
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
}

function log(message: string, ...rest: unknown[]): void {
  console.log(`[SC Resolver] ${message}`, ...rest);
}

/** Sniff `x-datadome-clientid` off the SoundCloud app's own requests so we can reuse the native id. */
function installHeaderCapture(ses: Session): void {
  if (captureInstalled) return;
  captureInstalled = true;
  ses.webRequest.onBeforeSendHeaders(
    { urls: ["https://api-v2.soundcloud.com/*", "https://*.soundcloud.cloud/*"] },
    (details, callback) => {
      for (const [key, value] of Object.entries(details.requestHeaders)) {
        if (key.toLowerCase() === "x-datadome-clientid" && typeof value === "string" && value) {
          if (capturedDatadomeClientId !== value) {
            capturedDatadomeClientId = value;
            log(`captured native x-datadome-clientid (${value.slice(0, 12)}…) from ${details.method} ${details.url.split("?")[0]}`);
          }
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );
  // Observe the status of license POSTs made by SoundCloud's OWN player during a native-playback
  // probe — the decisive signal: does the official player succeed in our Electron + castLabs-CDM
  // environment (=> only the request context blocks us) or also 403 (=> the CDM/environment is rejected)?
  ses.webRequest.onCompleted(
    { urls: ["https://license.media-streaming.soundcloud.cloud/*"] },
    (details) => {
      log(`native license POST observed: ${details.method} -> ${details.statusCode}`);
    }
  );
}

async function setOAuthCookie(oauthToken: string): Promise<void> {
  const ses = session.fromPartition(RESOLVER_PARTITION);
  const oneYear = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  for (const url of ["https://soundcloud.com", "https://api-v2.soundcloud.com"]) {
    await ses.cookies
      .set({
        url,
        name: "oauth_token",
        value: oauthToken,
        domain: ".soundcloud.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
        expirationDate: oneYear
      })
      .catch(() => undefined);
  }
}

/** Wait until DataDome's JS has run (its cookie appears) AND we've captured the native client-id. */
async function waitForReady(): Promise<void> {
  const ses = session.fromPartition(RESOLVER_PARTITION);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let sawCookie = false;
  while (Date.now() < deadline) {
    if (!sawCookie) {
      const cookies = await ses.cookies.get({ name: "datadome" }).catch(() => []);
      if (cookies.length > 0) {
        sawCookie = true;
        log(`datadome cookie established (${cookies[0].value.slice(0, 12)}…)`);
      }
    }
    if (sawCookie && capturedDatadomeClientId) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  log(
    `ready-wait finished: datadomeCookie=${sawCookie} clientId=${capturedDatadomeClientId ? "captured" : "MISSING"}`
  );
}

async function ensureWindow(oauthToken?: string): Promise<BrowserWindow> {
  if (windowPromise) {
    const existing = await windowPromise.catch(() => null);
    if (existing && !existing.isDestroyed()) {
      return existing;
    }
    windowPromise = null;
  }

  windowPromise = (async () => {
    const ses = session.fromPartition(RESOLVER_PARTITION);
    installHeaderCapture(ses);
    if (oauthToken) {
      await setOAuthCookie(oauthToken);
    }
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        partition: RESOLVER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    guardSoundCloudWindow(win);
    win.webContents.setAudioMuted(true);
    log("loading soundcloud.com in hidden window…");
    await win.loadURL(SOUNDCLOUD_HOME).catch((error) => log("loadURL error", error));
    await waitForReady();
    return win;
  })();

  return windowPromise;
}

export interface InPageResponse {
  status: number;
  body: string;
  sentClientId: boolean;
}

/**
 * Run a GET against an api-v2 URL from INSIDE the soundcloud.com page context, carrying the native
 * DataDome session: the page's datadome cookie (credentials), the captured native client-id header,
 * and the real renderer fingerprint. Used for the monetized/Widevine /media resolve.
 */
export async function resolveMediaInPage(opts: {
  url: string;
  oauthToken: string;
}): Promise<InPageResponse> {
  if (!isTrustedSoundCloudUrl(opts.url, true)) {
    throw new Error("SoundCloud returned an untrusted media URL.");
  }
  const win = await ensureWindow(opts.oauthToken);
  if (!isTrustedSoundCloudUrl(win.webContents.getURL())) {
    throw new Error("SoundCloud resolver window left its trusted origin.");
  }
  const headers: Record<string, string> = { Authorization: `OAuth ${opts.oauthToken}` };
  if (capturedDatadomeClientId) {
    headers["x-datadome-clientid"] = capturedDatadomeClientId;
  }
  log(`in-page resolve (clientId=${capturedDatadomeClientId ? "present" : "MISSING"}) -> ${opts.url.split("?")[0]}`);
  const js = `
    (async () => {
      try {
        const res = await fetch(${JSON.stringify(opts.url)}, {
          method: "GET",
          headers: ${JSON.stringify(headers)},
          credentials: "include"
        });
        const body = await res.text();
        return { status: res.status, body: body, sentClientId: ${JSON.stringify(Boolean(capturedDatadomeClientId))} };
      } catch (e) {
        return { status: -1, body: String((e && e.message) || e), sentClientId: false };
      }
    })()
  `;
  const exec = win.webContents.executeJavaScript(js, true) as Promise<InPageResponse>;
  const timeout = new Promise<InPageResponse>((_, reject) =>
    setTimeout(() => reject(new Error("in-page resolve timed out")), RESOLVE_TIMEOUT_MS)
  );
  const result = await Promise.race([exec, timeout]);
  log(`in-page resolve result: status=${result.status} sentClientId=${result.sentClientId}`);
  return result;
}

let probeStarted = false;

/**
 * One-shot diagnostic: open the real SoundCloud track page in a hidden window and let SoundCloud's
 * OWN player attempt playback, so the onCompleted hook reports the status of the genuine license POST
 * in our environment. Reveals whether the castLabs CDM is accepted (200) or rejected (403) by KeyOS.
 */
export async function probeNativePlaybackOnce(
  trackUrl: string | undefined,
  oauthToken: string
): Promise<void> {
  if (probeStarted || !trackUrl || !isTrustedSoundCloudUrl(trackUrl)) return;
  probeStarted = true;
  try {
    const ses = session.fromPartition(RESOLVER_PARTITION);
    installHeaderCapture(ses);
    await setOAuthCookie(oauthToken);
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        partition: RESOLVER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    guardSoundCloudWindow(win);
    win.webContents.setAudioMuted(true);
    log(`PROBE: opening real track page ${trackUrl}`);
    await win.loadURL(trackUrl).catch((error) => log("PROBE loadURL error", error));
    await new Promise((resolve) => setTimeout(resolve, 4500));
    const clicked = await win.webContents
      .executeJavaScript(
        `(() => {
          const sels = ['.sc-button-play','button.playButton','button[title="Play"]','.playControls__play','button[aria-label="Play"]'];
          for (const s of sels) { const el = document.querySelector(s); if (el) { el.click(); return s; } }
          return 'no-play-button-found';
        })()`,
        true
      )
      .catch((error) => "click-error: " + ((error && error.message) || error));
    log(`PROBE: play click -> ${clicked}`);
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    log("PROBE: finished; closing probe window");
    if (!win.isDestroyed()) {
      win.destroy();
    }
  } catch (error) {
    log("PROBE error", error);
  }
}

/** True once a hidden resolver window exists (for diagnostics). */
export function isResolverWindowReady(): boolean {
  return windowPromise !== null;
}

/** Destroy the authenticated resolver context and remove its persistent cookies on sign-out. */
export async function clearSoundCloudResolverSession(): Promise<void> {
  const pendingWindow = windowPromise;
  windowPromise = null;
  capturedDatadomeClientId = undefined;
  probeStarted = false;

  const win = await pendingWindow?.catch(() => null);
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
  await session.fromPartition(RESOLVER_PARTITION).clearStorageData().catch(() => undefined);
}
