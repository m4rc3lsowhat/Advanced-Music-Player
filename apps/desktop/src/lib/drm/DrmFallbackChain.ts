/*
 * ─── SOUNDCLOUD PLAYBACK — GROUND TRUTH (do NOT re-litigate; entitlement is not the issue) ───
 * NO track here requires Go+. Every liked track (incl. "DRM"/major-label ones like
 * Pop 1685274354) plays fine for THIS account in Chrome/Brave/Safari/Edge — no pay,
 * no Go+, never a problem. So a 403 in AMP is NEVER entitlement; it is a request-
 * context delta vs. a real browser (DataDome/anti-bot, cookies/session, CDM, headers).
 * The real browser request is the working reference — match it.
 */
/**
 * DRM Fallback Chain
 *
 * Orchestrates the complete DRM-to-playback pipeline for SoundCloud with a
 * strict priority order. Each step is isolated so a failure at one level
 * cleanly falls back to the next without leaking state.
 *
 * Chain (highest priority first):
 *   1. Progressive MP3 (no DRM, direct <audio>)
 *   2. Plain HLS (no DRM, hls.js)
 *   3. Widevine CENC via WidevineDrmEngine + hls.js
 *   4. SoundCloud Widget (hidden iframe, SoundCloud's own player)
 *   5. Hard error with structured diagnostics
 *
 * The fallback chain also integrates:
 *   - Subscription detection: Go+ tracks that fail DRM are flagged
 *   - Ad injection scaffold: free-tier tracks can trigger ad playback
 *   - Device identity: stable correlation ID across attempts
 */

import type Hls from "hls.js";
import { WidevineDrmEngine, type DrmLicenseConfig, type DrmInitData, type DrmEngineEvent } from "./WidevineDrmEngine";
import { deviceIdentityManager } from "./DeviceIdentity";
import { globalCertPool } from "./CdmCertificatePool";

export type FallbackStage =
  | "progressive"
  | "plain-hls"
  | "widevine-manual-eme"
  | "widevine-hlsjs-eme"
  | "widget"
  | "failed";

export interface FallbackDiagnostics {
  stage: FallbackStage;
  deviceId?: string;
  deviceFingerprint?: string;
  certPoolCount: number;
  widevineEvents: DrmEngineEvent[];
  error?: string;
}

export interface FallbackResult {
  stage: FallbackStage;
  /** The <audio> or <video> element is ready to play (progressive / HLS). */
  audioReady?: boolean;
  /** hls.js instance was created and attached (plain HLS or DRM HLS). */
  hlsInstance?: Hls;
  /** The DRM engine result (only for widevine-manual-eme stage). */
  drmResult?: Awaited<ReturnType<WidevineDrmEngine["acquireLicense"]>>;
  /** Widget iframe was injected. */
  widgetInjected?: boolean;
  diagnostics: FallbackDiagnostics;
}

export type FallbackListener = (update: { stage: FallbackStage; message: string }) => void;

const WIDEVINE_LICENSE_URL = "https://license.media-streaming.soundcloud.cloud/playback/widevine";

// Learned DRM strategy. For SoundCloud DRM tracks the native-EME stages are slow and (on this
// account) always fail — the SoundCloud widget is the path that works. We remember the last stage
// that actually succeeded for a DRM track and, when it's the widget, try it FIRST so DRM tracks
// start instantly instead of burning ~4-5s failing native EME every time. Native EME is re-probed
// at most once per RE_PROBE_INTERVAL_MS in case a future build makes it work.
const DRM_PREF_KEY = "sc.drm.pref";
const RE_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface DrmPref {
  /** The stage that last succeeded for a DRM track. */
  stage: FallbackStage;
  /** When the preference was last set by a FULL-chain probe (not a widget-first shortcut). */
  ts: number;
}

function readDrmPref(): DrmPref | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(DRM_PREF_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as DrmPref;
    if (parsed && typeof parsed.ts === "number" && typeof parsed.stage === "string") {
      return parsed;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function writeDrmPref(stage: FallbackStage): void {
  try {
    globalThis.localStorage?.setItem(DRM_PREF_KEY, JSON.stringify({ stage, ts: Date.now() }));
  } catch {
    // ignore
  }
}

function fallbackLog(stage: FallbackStage, message: string, ...rest: unknown[]): void {
  try {
    if (globalThis.localStorage?.getItem("sc.drm.debug") !== "1") return;
  } catch {
    // ignore
  }
  console.log(`[SC Fallback] [${stage}] ${message}`, ...rest);
}

export class DrmFallbackChain {
  private engine: WidevineDrmEngine;
  private listeners = new Set<FallbackListener>();
  private widevineEvents: DrmEngineEvent[] = [];

  constructor() {
    this.engine = new WidevineDrmEngine();
    this.engine.subscribe((event) => {
      this.widevineEvents.push(event);
      this.logEngineEvent(event);
    });
  }

  private logEngineEvent(event: DrmEngineEvent): void {
    try {
      if (globalThis.localStorage?.getItem("sc.drm.debug") !== "1") return;
    } catch {
      // ignore
    }
    switch (event.type) {
      case "service-cert-attempt":
      case "service-cert-installed":
        console.log(`[SC DRM] ${event.type} (${event.label})`);
        break;
      case "service-cert-failed":
        console.warn(`[SC DRM] ${event.type} (${event.label}): ${event.reason}`);
        break;
      case "cdm-message":
        console.log(
          `[SC DRM] cdm-message type=${event.messageType} size=${event.size} certInstalled=${event.certInstalled}`
        );
        break;
      case "license-request":
        console.log(`[SC DRM] license-request -> ${event.url}`);
        break;
      case "license-ok":
        console.log(`[SC DRM] license-ok size=${event.size}`);
        break;
      case "license-failed":
        console.error(`[SC DRM] license-failed status=${event.status}`);
        break;
      case "session-update-failed":
        console.error(`[SC DRM] session-update-failed: ${event.error}`);
        break;
      case "error":
        console.error(`[SC DRM] engine error (${event.phase}): ${event.error}`);
        break;
      default:
        break;
    }
  }

  subscribe(listener: FallbackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Whether a DRM track should jump straight to the widget. True only when the widget was the last
   * stage to actually succeed AND that was within RE_PROBE_INTERVAL_MS — so native EME is still
   * re-probed about once a day in case a future build makes it work.
   */
  private shouldTryWidgetFirst(): boolean {
    const pref = readDrmPref();
    if (!pref || pref.stage !== "widget") {
      return false;
    }
    return Date.now() - pref.ts < RE_PROBE_INTERVAL_MS;
  }

  /**
   * Execute the fallback chain for a SoundCloud track.
   *
   * @param audio         The shared <audio>/<video> element
   * @param streamUrl     The resolved stream URL (may be progressive, HLS, or DRM HLS)
   * @param drmConfig     Optional DRM metadata from the gateway
   * @param initSegment   Optional fetched MP4 init segment (for PSSH extraction)
   * @param widgetFactory Optional factory that creates a widget fallback
   */
  async execute(options: {
    audio: HTMLVideoElement;
    streamUrl: string;
    drmConfig?: DrmLicenseConfig;
    initSegment?: ArrayBuffer;
    widgetFactory?: () => Promise<void>;
    hlsConfig?: {
      emeEnabled?: boolean;
      licenseXhrSetup?: (xhr: XMLHttpRequest, url: string) => void;
    };
  }): Promise<FallbackResult> {
    this.widevineEvents = [];
    const identity = await deviceIdentityManager.ensureIdentity();
    const diagnostics: FallbackDiagnostics = {
      stage: "failed",
      deviceId: identity.deviceId,
      deviceFingerprint: identity.fingerprint,
      certPoolCount: globalCertPool.getCertificateCount(),
      widevineEvents: this.widevineEvents
    };

    const { audio, streamUrl, drmConfig, initSegment, widgetFactory } = options;

    // 0) Learned fast path: for DRM tracks whose last successful stage was the widget (and we're
    // not due for a periodic native re-probe), go straight to the widget instead of re-failing the
    // slow native-EME stages. On failure we fall through to the full chain below. We deliberately do
    // NOT refresh the stored timestamp here, so the once-per-day native re-probe still fires.
    if (drmConfig && widgetFactory && this.shouldTryWidgetFirst()) {
      this.notify("widget", "Resuming SoundCloud widget playback...");
      try {
        await widgetFactory();
        diagnostics.stage = "widget";
        fallbackLog("widget", "Success (widget-first fast path)");
        return { stage: "widget", widgetInjected: true, diagnostics };
      } catch (error) {
        fallbackLog(
          "widget",
          "widget-first failed; running full chain:",
          (error as Error)?.message
        );
      }
    }

    // 1) Progressive (direct MP3)
    if (!streamUrl.includes(".m3u8")) {
      this.notify("progressive", "Trying progressive stream...");
      try {
        await this.loadProgressive(audio, streamUrl);
        diagnostics.stage = "progressive";
        fallbackLog("progressive", "Success");
        return { stage: "progressive", audioReady: true, diagnostics };
      } catch (error) {
        fallbackLog("progressive", "Failed:", (error as Error)?.message);
      }
    }

    // 2) Plain HLS (no DRM)
    if (!drmConfig) {
      this.notify("plain-hls", "Trying plain HLS...");
      try {
        const hls = await this.loadPlainHls(audio, streamUrl);
        diagnostics.stage = "plain-hls";
        fallbackLog("plain-hls", "Success");
        return { stage: "plain-hls", audioReady: true, hlsInstance: hls, diagnostics };
      } catch (error) {
        fallbackLog("plain-hls", "Failed:", (error as Error)?.message);
      }
    }

    // 3) Widevine manual EME
    if (drmConfig && initSegment) {
      this.notify("widevine-manual-eme", "Trying manual Widevine EME...");
      try {
        const pssh = this.extractPsshFromMp4(initSegment);
        fallbackLog(
          "widevine-manual-eme",
          `pssh=${pssh ? pssh.byteLength + "b" : "none"} licenseHost=${new URL(drmConfig.licenseUrl).host} token=${drmConfig.licenseAuthToken ? "present" : "MISSING"} trackAuth=${drmConfig.trackAuthorization ? "present" : "MISSING"}`
        );
        if (pssh) {
          const result = await this.engine.acquireLicense(drmConfig, { pssh, initSegment });
          await audio.setMediaKeys(result.mediaKeys);
          const hls = await this.loadPlainHls(audio, streamUrl);
          diagnostics.stage = "widevine-manual-eme";
          fallbackLog("widevine-manual-eme", "Success certInstalled=" + result.certInstalled);
          writeDrmPref("widevine-manual-eme"); // native works → prefer it, stop widget-first
          return {
            stage: "widevine-manual-eme",
            audioReady: true,
            hlsInstance: hls,
            drmResult: result,
            diagnostics
          };
        }
      } catch (error) {
        fallbackLog("widevine-manual-eme", "Failed:", (error as Error)?.message);
        this.engine.abort();
      }
    }

    // 4) Widevine via hls.js built-in EME
    if (drmConfig) {
      this.notify("widevine-hlsjs-eme", "Trying hls.js built-in EME...");
      try {
        const hls = await this.loadHlsWithEme(audio, streamUrl, drmConfig, options.hlsConfig);
        diagnostics.stage = "widevine-hlsjs-eme";
        fallbackLog("widevine-hlsjs-eme", "Success");
        writeDrmPref("widevine-hlsjs-eme"); // native works → prefer it, stop widget-first
        return { stage: "widevine-hlsjs-eme", audioReady: true, hlsInstance: hls, diagnostics };
      } catch (error) {
        fallbackLog("widevine-hlsjs-eme", "Failed:", (error as Error)?.message);
      }
    }

    // 5) Widget fallback
    if (widgetFactory) {
      this.notify("widget", "Falling back to SoundCloud widget...");
      try {
        await widgetFactory();
        diagnostics.stage = "widget";
        fallbackLog("widget", "Success");
        // Full-chain widget win: remember it (with a fresh timestamp) so future DRM tracks take the
        // widget-first fast path until the next daily native re-probe.
        if (drmConfig) {
          writeDrmPref("widget");
        }
        return { stage: "widget", widgetInjected: true, diagnostics };
      } catch (error) {
        fallbackLog("widget", "Failed:", (error as Error)?.message);
      }
    }

    diagnostics.stage = "failed";
    diagnostics.error = "All fallback stages exhausted.";
    this.notify("failed", "No playable stream found.");
    throw new Error(
      drmConfig
        ? "This track's stream was blocked in AMP (it plays in a browser) — skipping."
        : "No playable stream was found for this track — skipping."
    );
  }

  private notify(stage: FallbackStage, message: string): void {
    for (const listener of this.listeners) {
      try {
        listener({ stage, message });
      } catch {
        // ignore
      }
    }
  }

  private async loadProgressive(audio: HTMLVideoElement, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onCanPlay = () => finish();
      const onError = () => finish(new Error("Progressive stream failed to load."));
      const timer = window.setTimeout(() => finish(new Error("Progressive stream timeout.")), 8000);

      const cleanup = () => {
        window.clearTimeout(timer);
        audio.removeEventListener("canplay", onCanPlay);
        audio.removeEventListener("error", onError);
      };

      audio.addEventListener("canplay", onCanPlay);
      audio.addEventListener("error", onError);
      audio.src = url;
      audio.load();
    });
  }

  private async loadPlainHls(audio: HTMLVideoElement, url: string): Promise<Hls> {
    const { default: Hls } = await import("hls.js");
    if (!Hls.isSupported()) {
      throw new Error("hls.js is not supported in this runtime.");
    }

    const hls = new Hls();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          hls.destroy();
          reject(error);
        } else {
          resolve(hls);
        }
      };
      const onCanPlay = () => finish();
      const onError = (_event: unknown, data: { fatal?: boolean; details?: string }) => {
        if (data?.fatal) finish(new Error(`HLS error: ${data.details ?? "fatal"}`));
      };
      const timer = window.setTimeout(() => finish(new Error("HLS stream timeout.")), 10000);

      const cleanup = () => {
        window.clearTimeout(timer);
        audio.removeEventListener("canplay", onCanPlay);
        hls.off(Hls.Events.ERROR, onError);
      };

      audio.addEventListener("canplay", onCanPlay);
      hls.on(Hls.Events.ERROR, onError);
      hls.loadSource(url);
      hls.attachMedia(audio);
    });
  }

  private async loadHlsWithEme(
    audio: HTMLVideoElement,
    url: string,
    drm: DrmLicenseConfig,
    hlsConfig?: { emeEnabled?: boolean; licenseXhrSetup?: (xhr: XMLHttpRequest, url: string) => void }
  ): Promise<Hls> {
    const { default: Hls } = await import("hls.js");
    if (!Hls.isSupported()) {
      throw new Error("hls.js is not supported in this runtime.");
    }

    const hls = new Hls({
      emeEnabled: true,
      drmSystems: {
        "com.widevine.alpha": {
          licenseUrl: drm.licenseUrl,
        }
      },
      licenseXhrSetup: (xhr, licenseUrl) => {
        const parsed = new URL(licenseUrl);
        if (drm.licenseAuthToken) {
          parsed.searchParams.set("license_token", drm.licenseAuthToken);
        }
        // Captured from the working browser: the license POST carries `license_token` ONLY (no
        // track_authorization — that belongs on the api-v2 /media resolve). Keep this in lockstep
        // with WidevineDrmEngine.postLicenseAndUpdate.
        xhr.open("POST", parsed.toString(), true);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.withCredentials = true;

        if (hlsConfig?.licenseXhrSetup) {
          hlsConfig.licenseXhrSetup(xhr, parsed.toString());
        }
      }
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          hls.destroy();
          reject(error);
        } else {
          resolve(hls);
        }
      };
      const onCanPlay = () => finish();
      const onError = (_event: unknown, data: { fatal?: boolean; details?: string }) => {
        if (data?.fatal) finish(new Error(`HLS EME error: ${data.details ?? "fatal"}`));
      };
      const timer = window.setTimeout(() => finish(new Error("HLS EME stream timeout.")), 12000);

      const cleanup = () => {
        window.clearTimeout(timer);
        audio.removeEventListener("canplay", onCanPlay);
        hls.off(Hls.Events.ERROR, onError);
      };

      audio.addEventListener("canplay", onCanPlay);
      hls.on(Hls.Events.ERROR, onError);
      hls.loadSource(url);
      hls.attachMedia(audio);
    });
  }

  /** Minimal MP4 PSSH extractor for the fallback chain. */
  private extractPsshFromMp4(buffer: ArrayBuffer): ArrayBuffer | undefined {
    const CONTAINER_BOXES = new Set([
      "moov", "trak", "mdia", "minf", "stbl", "stsd", "enca", "encv",
      "sinf", "schi", "moof", "traf"
    ]);
    const WIDEVINE_SYSTEM_ID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";

    function readBoxSize(view: DataView, offset: number): number {
      const size = view.getUint32(offset, false);
      if (size === 1) {
        const high = view.getUint32(offset + 8, false);
        const low = view.getUint32(offset + 12, false);
        if (high !== 0) return -1;
        return low;
      }
      return size;
    }

    function parseBoxes(view: DataView, start: number, end: number): ArrayBuffer | undefined {
      let offset = start;
      while (offset < end - 8) {
        const size = readBoxSize(view, offset);
        if (size <= 0 || offset + size > end) break;
        const type = String.fromCharCode(
          view.getUint8(offset + 4),
          view.getUint8(offset + 5),
          view.getUint8(offset + 6),
          view.getUint8(offset + 7)
        );
        if (type === "pssh") {
          const systemIdBytes = new Uint8Array(buffer, offset + 12, 16);
          const systemId = Array.from(systemIdBytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          const normalized =
            systemId.slice(0, 8) + "-" +
            systemId.slice(8, 12) + "-" +
            systemId.slice(12, 16) + "-" +
            systemId.slice(16, 20) + "-" +
            systemId.slice(20);
          if (normalized === WIDEVINE_SYSTEM_ID) {
            return buffer.slice(offset, offset + size);
          }
        } else if (CONTAINER_BOXES.has(type)) {
          const headerSize = view.getUint32(offset, false) === 1 ? 16 : 8;
          const inner = parseBoxes(view, offset + headerSize, offset + size);
          if (inner) return inner;
        }
        offset += size;
      }
      return undefined;
    }

    return parseBoxes(new DataView(buffer), 0, buffer.byteLength);
  }

}
