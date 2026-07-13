/*
 * ─── SOUNDCLOUD PLAYBACK — GROUND TRUTH (do NOT re-litigate; entitlement is not the issue) ───
 * NO track here requires Go+. Every liked track (incl. "DRM"/major-label ones like
 * Pop 1685274354) plays fine for THIS account in Chrome/Brave/Safari/Edge — no pay,
 * no Go+, never a problem. So a 403 in AMP is NEVER entitlement; it is a request-
 * context delta vs. a real browser (DataDome/anti-bot, cookies/session, CDM, headers).
 * The real browser request is the working reference — match it.
 */
/**
 * Widevine DRM Engine
 *
 * Centralised, strategy-based Widevine EME orchestrator. Replaces the inline
 * manual-EME spaghetti in soundcloudAdapter.ts with a testable, observable engine
 * that can be iterated on independently.
 *
 * Design goals:
 *  - Single-responsibility: this file ONLY worries about getting a MediaKeySession
 *    licensed and ready. It does NOT touch hls.js, <audio>, or widgets.
 *  - Strategy pattern: each license-acquisition approach is a self-contained
 *    strategy so we can A/B them and add new ones (proxy, custom CDM, etc.)
 *  - Observable: every significant step emits diagnostics so the adapter can
 *    log, surface errors, or fall back cleanly.
 *  - Open-source compatible: no castLabs, no commercial SDK — only standard
 *    EME + hls.js + our own infrastructure.
 */

import { globalCertPool } from "./CdmCertificatePool";
import { deviceIdentityManager, type DeviceIdentity } from "./DeviceIdentity";

export interface DrmLicenseConfig {
  system: "com.widevine.alpha";
  licenseUrl: string;
  licenseAuthToken?: string;
  trackAuthorization?: string;
  oauthToken?: string;
}

export interface DrmInitData {
  /** The PSSH box extracted from the MP4 init segment. */
  pssh: ArrayBuffer;
  /** Optional: the raw init segment itself, for advanced parsers. */
  initSegment?: ArrayBuffer;
}

export type DrmEngineEvent =
  | { type: "mkgs-requested" }
  | { type: "mkgs-granted"; configuration: MediaKeySystemConfiguration | null }
  | { type: "mediakeys-created" }
  | { type: "service-cert-attempt"; label: string }
  | { type: "service-cert-installed"; label: string }
  | { type: "service-cert-failed"; label: string; reason: string }
  | { type: "session-created" }
  | { type: "generate-request-called"; initDataType: string; psshSize: number }
  | { type: "cdm-message"; messageType: MediaKeyMessageType; size: number; certInstalled: boolean }
  | { type: "license-request"; url: string }
  | { type: "license-ok"; size: number }
  | { type: "license-failed"; status: number }
  | { type: "session-update-ok" }
  | { type: "session-update-failed"; error: string }
  | { type: "error"; phase: string; error: string };

export type DrmEngineListener = (event: DrmEngineEvent) => void;

export interface DrmEngineResult {
  mediaKeys: MediaKeys;
  session: MediaKeySession;
  /** Whether a service (privacy) certificate was successfully installed. */
  certInstalled: boolean;
}

function hexPreview(buffer: ArrayBuffer | undefined, count = 8): string {
  if (!buffer) return "null";
  return Array.from(new Uint8Array(buffer))
    .slice(0, count)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

export class WidevineDrmEngine {
  private listeners = new Set<DrmEngineListener>();
  private abortController = new AbortController();
  private deviceIdentity: DeviceIdentity | undefined;

  subscribe(listener: DrmEngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  /**
   * Attempt to acquire a Widevine license using the most robust strategy chain.
   *
   * Steps:
   *   1. Request MediaKeySystemAccess
   *   2. Create MediaKeys
   *   3. Install service certificate (from pool)
   *   4. Create session + generateRequest with init-segment PSSH
   *   5. POST license challenge
   *   6. Update session with license response
   *
   * Throws on any fatal step so the caller can fall back.
   */
  async acquireLicense(config: DrmLicenseConfig, initData: DrmInitData): Promise<DrmEngineResult> {
    this.deviceIdentity = await deviceIdentityManager.ensureIdentity();

    // 1) MKSA
    this.emit({ type: "mkgs-requested" });
    const access = await this.requestMediaKeySystemAccess();
    let configuration: MediaKeySystemConfiguration | null = null;
    try {
      configuration = access.getConfiguration();
    } catch {
      // best-effort diagnostics
    }
    this.emit({ type: "mkgs-granted", configuration });

    if (this.abortController.signal.aborted) {
      throw new Error("DRM operation aborted.");
    }

    // 2) MediaKeys
    const mediaKeys = await access.createMediaKeys();
    this.emit({ type: "mediakeys-created" });

    // 3) Service certificate
    const certInstalled = await this.installServiceCertificate(mediaKeys, config);
    this.emit(
      certInstalled
        ? { type: "service-cert-installed", label: "resolved" }
        : { type: "service-cert-failed", label: "all", reason: "no certificate accepted by CDM" }
    );

    if (this.abortController.signal.aborted) {
      throw new Error("DRM operation aborted.");
    }

    // 4) Session + generateRequest
    const session = mediaKeys.createSession();
    this.emit({ type: "session-created" });

    const licensePromise = this.waitForLicenseMessage(session, config, certInstalled);

    this.emit({
      type: "generate-request-called",
      initDataType: "cenc",
      psshSize: initData.pssh.byteLength
    });
    await session.generateRequest("cenc", initData.pssh);

    // 5+6) License + update
    await licensePromise;

    return { mediaKeys, session, certInstalled };
  }

  private async requestMediaKeySystemAccess(): Promise<MediaKeySystemAccess> {
    const configs: MediaKeySystemConfiguration[] = [
      {
        initDataTypes: ["cenc", "keyids"],
        audioCapabilities: [
          { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: "SW_SECURE_CRYPTO" }
        ],
        videoCapabilities: [
          { contentType: 'video/mp4; codecs="avc1.42e01e"', robustness: "SW_SECURE_CRYPTO" }
        ],
        persistentState: "optional",
        distinctiveIdentifier: "optional",
        sessionTypes: ["temporary"]
      }
    ];

    if (!navigator.requestMediaKeySystemAccess) {
      throw new Error("EME / requestMediaKeySystemAccess is not available in this runtime.");
    }

    return navigator.requestMediaKeySystemAccess("com.widevine.alpha", configs);
  }

  private async installServiceCertificate(
    mediaKeys: MediaKeys,
    config: DrmLicenseConfig
  ): Promise<boolean> {
    this.emit({ type: "service-cert-attempt", label: "cert-pool" });
    return globalCertPool.installServiceCertificate(mediaKeys, {
      licenseUrl: config.licenseUrl,
      licenseAuthToken: config.licenseAuthToken,
      trackAuthorization: config.trackAuthorization
    });
  }

  private waitForLicenseMessage(
    session: MediaKeySession,
    config: DrmLicenseConfig,
    certInstalled: boolean
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: number | undefined;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) window.clearTimeout(timer);
        session.removeEventListener("message", onMessage);
        session.removeEventListener("error", onError);
        this.abortController.signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };

      const onMessage = async (event: MediaKeyMessageEvent) => {
        this.emit({
          type: "cdm-message",
          messageType: event.messageType,
          size: event.message.byteLength,
          certInstalled
        });

        try {
          await this.postLicenseAndUpdate(session, event.message, config);
          finish();
        } catch (error) {
          finish(error as Error);
        }
      };

      const onError = (event: Event) => {
        const msg = (event as ErrorEvent).message ?? "MediaKeySession error";
        this.emit({ type: "error", phase: "session", error: msg });
        finish(new Error(msg));
      };

      const onAbort = () => finish(new Error("DRM operation aborted."));

      session.addEventListener("message", onMessage);
      session.addEventListener("error", onError);
      this.abortController.signal.addEventListener("abort", onAbort);

      // Bound the WHOLE round-trip (CDM challenge -> license POST -> session.update). The timer is
      // cleared on settle, so a slow-but-real license POST now surfaces its actual result (200/403)
      // instead of the old misleading "CDM did not send a challenge" error (which used to fire while
      // the POST was still in flight, because the timer was never cleared).
      timer = window.setTimeout(() => {
        finish(new Error("Widevine license round-trip timed out (15s)."));
      }, 15000);
    });
  }

  private async postLicenseAndUpdate(
    session: MediaKeySession,
    challenge: ArrayBuffer,
    config: DrmLicenseConfig
  ): Promise<void> {
    const url = new URL(config.licenseUrl);
    if (config.licenseAuthToken) {
      url.searchParams.set("license_token", config.licenseAuthToken);
    }
    // Captured from the working browser: the real player's
    // license POST carries `license_token` ONLY. `track_authorization` belongs on the api-v2 /media
    // resolve (which mints the license_token), NOT on this license POST — so we deliberately omit it.

    // Mirror a real browser's anonymous license POST: only Content-Type, nothing else.
    // Non-standard X-* headers can trip strict WAF/validation on the KeyOS endpoint.
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream"
    };

    this.emit({ type: "license-request", url: `${url.origin}${url.pathname}` });

    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: challenge,
      credentials: "include",
      signal: this.abortController.signal
    });

    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      this.emit({ type: "license-failed", status: response.status });
      throw new Error(`License server returned ${response.status}.`);
    }

    const license = await response.arrayBuffer();
    this.emit({ type: "license-ok", size: license.byteLength });

    await session.update(license);
    this.emit({ type: "session-update-ok" });
  }

  private emit(event: DrmEngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors must not break the engine
      }
    }
  }
}
