/*
 * ─── SOUNDCLOUD PLAYBACK — GROUND TRUTH (do NOT re-litigate; entitlement is not the issue) ───
 * NO track here requires Go+. Every liked track (incl. "DRM"/major-label ones like
 * Pop 1685274354) plays fine for THIS account in Chrome/Brave/Safari/Edge — no pay,
 * no Go+, never a problem. So a 403 in AMP is NEVER entitlement; it is a request-
 * context delta vs. a real browser (DataDome/anti-bot, cookies/session, CDM, headers).
 * The real browser request is the working reference — match it.
 */
/**
 * CDM Service Certificate Pool
 *
 * Widevine license servers often require a "service certificate" (also called a
 * "privacy certificate" or "server certificate") to be installed on the MediaKeys
 * BEFORE generateRequest(). Without it, the CDM cannot privacy-encrypt the device
 * identifier in the license challenge, and KeyOS / BuyDRM servers reject the
 * challenge with 403 Forbidden.
 *
 * SoundCloud does NOT serve this certificate from their license endpoint
 * (`license.media-streaming.soundcloud.cloud/playback/widevine`). The endpoint
 * only accepts license challenges (POST with real CDM message) and returns
 * license responses — it does NOT return the service cert.
 *
 * This module implements a pool of strategies to obtain a valid Widevine service
 * certificate:
 *
 * 1. **Embedded pool** — A small set of known-good Widevine service certificates
 *    embedded at build time. These are public infrastructure certificates (not
 *    secrets) and are rotated infrequently.
 * 2. **Chrome CDM extraction** — Attempt to read the service certificate from the
 *    browser's own Widevine CDM via a lightweight probe request.
 * 3. **Proxy discovery** — In future phases, a AMP-run proxy can vend the cert.
 *
 * All certificates are cached in-memory and in localStorage so we only pay the
 * discovery cost once per app launch.
 */

const CERT_CACHE_KEY = "amp.drm.widevine.cert.v1";

interface CertEntry {
  label: string;
  bytes: Uint8Array;
  source: "embedded" | "extracted" | "proxy";
  addedAt: number;
}

interface CertPoolSnapshot {
  certs: Array<{ label: string; base64: string; source: CertEntry["source"]; addedAt: number }>;
}

// SoundCloud routes Widevine licensing through BuyDRM / KeyOS. A KeyOS license
// server only accepts a license challenge whose device identifier was privacy-
// encrypted with KeyOS's OWN service certificate — Google's generic
// "license.widevine.com" certificate does NOT validate there (and a malformed
// blob is rejected by the CDM with system code 17). We therefore ship NO
// embedded certificate. The correct certificate is fetched at runtime directly
// from SoundCloud's license server via the Widevine SERVICE_CERTIFICATE_REQUEST
// handshake — see fetchServiceCertFromLicenseServer() below.
const EMBEDDED_CERTS: Array<{ label: string; base64: string }> = [];

function drmLog(message: string, ...rest: unknown[]): void {
  try {
    if (globalThis.localStorage?.getItem("sc.drm.debug") === "0") return;
  } catch {
    // ignore
  }
  console.log(`[SC DRM] ${message}`, ...rest);
}

export class CdmCertificatePool {
  private certs: CertEntry[] = [];
  private triedInit = false;

  constructor() {
    this.loadFromLocalStorage();
  }

  /**
   * Attempt to install a valid Widevine service certificate on the given MediaKeys.
   * Returns true if any certificate was accepted by the CDM.
   */
  async installServiceCertificate(
    mediaKeys: MediaKeys,
    options?: { licenseUrl?: string; licenseAuthToken?: string; trackAuthorization?: string }
  ): Promise<boolean> {
    await this.ensureInitialized();

    // 1) Try any cached / embedded certificates first.
    for (const entry of this.certs) {
      if (await this.applyCert(mediaKeys, entry.bytes, entry.label, entry.source)) {
        return true;
      }
    }

    // 2) Fetch SoundCloud's own service certificate from the license server via
    //    the Widevine SERVICE_CERTIFICATE_REQUEST handshake, then install it.
    if (options?.licenseUrl) {
      try {
        const candidates = await this.fetchServiceCertFromLicenseServer(options);
        for (const candidate of candidates) {
          if (await this.applyCert(mediaKeys, candidate.bytes, candidate.label, "proxy")) {
            this.addCertificate(candidate.label, candidate.bytes, "proxy");
            return true;
          }
        }
      } catch (error) {
        drmLog(`service-cert handshake failed: ${(error as Error)?.message}`);
      }
    }

    return false;
  }

  private async applyCert(
    mediaKeys: MediaKeys,
    bytes: Uint8Array,
    label: string,
    source: CertEntry["source"]
  ): Promise<boolean> {
    try {
      const accepted = await mediaKeys.setServerCertificate(bytes as BufferSource);
      if (accepted === false) {
        drmLog(`setServerCertificate(${label}) returned false (unsupported)`);
        return false;
      }
      drmLog(`setServerCertificate(${label}) OK source=${source} bytes=${bytes.length}`);
      return true;
    } catch (error) {
      drmLog(`setServerCertificate(${label}) rejected: ${(error as Error)?.message}`);
      return false;
    }
  }

  /**
   * Request the Widevine service certificate from a license server using the
   * SERVICE_CERTIFICATE_REQUEST handshake. The request body is the 2-byte
   * SignedMessage { type: SERVICE_CERTIFICATE_REQUEST }. The response is a
   * SignedMessage { type: SERVICE_CERTIFICATE, msg: <SignedDrmCertificate> }.
   *
   * Different CDM builds accept either the full SignedMessage or the inner
   * certificate bytes, so we return both as candidates for setServerCertificate.
   */
  private async fetchServiceCertFromLicenseServer(options: {
    licenseUrl?: string;
    licenseAuthToken?: string;
    trackAuthorization?: string;
  }): Promise<Array<{ label: string; bytes: Uint8Array }>> {
    const url = new URL(options.licenseUrl!);
    if (options.licenseAuthToken) {
      url.searchParams.set("license_token", options.licenseAuthToken);
    }
    if (options.trackAuthorization) {
      url.searchParams.set("track_authorization", options.trackAuthorization);
    }

    // SignedMessage { type = SERVICE_CERTIFICATE_REQUEST (4) } => tag 0x08, value 0x04
    const request = new Uint8Array([0x08, 0x04]);

    drmLog(`service-cert request -> ${url.origin}${url.pathname}`);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: request as BufferSource,
      credentials: "include",
      signal: AbortSignal.timeout(15_000)
    });

    if (!response.ok) {
      drmLog(`service-cert request failed: ${response.status}`);
      return [];
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > 1024 * 1024) {
      throw new Error("Service certificate response was too large.");
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    if (raw.length > 1024 * 1024) {
      throw new Error("Service certificate response was too large.");
    }
    drmLog(`service-cert response: ${raw.length} bytes head=${hexHead(raw, 6)}`);
    if (raw.length < 8) {
      // Too small to be a certificate (likely an error blob).
      return [];
    }

    const candidates: Array<{ label: string; bytes: Uint8Array }> = [
      { label: "sc-keyos-signedmessage", bytes: raw }
    ];

    // Unwrap SignedMessage.msg (field 2) — the inner SignedDrmCertificate.
    const inner = extractProtobufField(raw, 2);
    if (inner && inner.length > 0 && inner.length < raw.length) {
      candidates.push({ label: "sc-keyos-drmcert", bytes: inner });
    }

    return candidates;
  }

  /**
   * Add a discovered certificate to the pool (e.g. from a proxy response).
   */
  addCertificate(label: string, bytes: Uint8Array, source: CertEntry["source"]): void {
    this.certs.push({ label, bytes, source, addedAt: Date.now() });
    this.saveToLocalStorage();
  }

  getCertificateCount(): number {
    return this.certs.length;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.triedInit) return;
    this.triedInit = true;

    // 1) Load embedded certs
    for (const embedded of EMBEDDED_CERTS) {
      try {
        const bytes = base64ToUint8Array(embedded.base64);
        if (bytes.length > 0) {
          this.certs.push({
            label: embedded.label,
            bytes,
            source: "embedded",
            addedAt: Date.now()
          });
        }
      } catch {
        // skip malformed embedded cert
      }
    }

    // 2) Try Chrome CDM extraction via a probe EME session
    try {
      await this.extractFromBrowserCdm();
    } catch {
      // extraction is best-effort
    }

    this.saveToLocalStorage();
  }

  /**
   * Attempt to extract the service certificate by creating a temporary
   * MediaKeySession and inspecting the CDM's behaviour. Some Chrome builds
   * vend the cert implicitly during the first individualization flow.
   *
   * This is a SCaffold — the real implementation needs to capture the
   * certificate bytes from the CDM's message exchange.
   */
  private async extractFromBrowserCdm(): Promise<void> {
    if (!navigator.requestMediaKeySystemAccess) {
      return;
    }

    const access = await navigator.requestMediaKeySystemAccess("com.widevine.alpha", [
      {
        initDataTypes: ["cenc"],
        audioCapabilities: [
          { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: "SW_SECURE_CRYPTO" }
        ],
        videoCapabilities: [
          { contentType: 'video/mp4; codecs="avc1.42e01e"', robustness: "SW_SECURE_CRYPTO" }
        ],
        sessionTypes: ["temporary"]
      }
    ]);

    const mediaKeys = await access.createMediaKeys();

    // Some CDMs expose the service certificate through an internal extension.
    // This is non-standard and varies by Chrome version, so we probe cautiously.
    const anyMediaKeys = mediaKeys as unknown as Record<string, unknown>;
    if (typeof anyMediaKeys.getServerCertificate === "function") {
      try {
        const cert = await (anyMediaKeys.getServerCertificate as () => Promise<Uint8Array>)();
        if (cert && cert.length > 0) {
          this.addCertificate("browser-extracted", cert as Uint8Array, "extracted");
          drmLog(`extractFromBrowserCdm: got ${cert.length} bytes`);
        }
      } catch {
        // probe failed
      }
    }
  }

  private loadFromLocalStorage(): void {
    try {
      const raw = globalThis.localStorage?.getItem(CERT_CACHE_KEY);
      if (!raw) return;
      const snapshot = JSON.parse(raw) as CertPoolSnapshot;
      for (const entry of snapshot.certs ?? []) {
        try {
          const bytes = base64ToUint8Array(entry.base64);
          this.certs.push({
            label: entry.label,
            bytes,
            source: entry.source,
            addedAt: entry.addedAt
          });
        } catch {
          // skip corrupt entry
        }
      }
    } catch {
      // ignore
    }
  }

  private saveToLocalStorage(): void {
    try {
      const snapshot: CertPoolSnapshot = {
        certs: this.certs.map((c) => ({
          label: c.label,
          base64: uint8ArrayToBase64(c.bytes),
          source: c.source,
          addedAt: c.addedAt
        }))
      };
      globalThis.localStorage?.setItem(CERT_CACHE_KEY, JSON.stringify(snapshot));
    } catch {
      // ignore
    }
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function hexHead(bytes: Uint8Array, count = 8): string {
  return Array.from(bytes.slice(0, count))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

/**
 * Minimal protobuf scanner: returns the bytes of the first length-delimited
 * (wire type 2) field matching `fieldNumber`, or undefined.
 */
function extractProtobufField(data: Uint8Array, fieldNumber: number): Uint8Array | undefined {
  let i = 0;
  while (i < data.length) {
    const tag = data[i++];
    const fn = tag >> 3;
    const wt = tag & 0x07;
    if (wt === 0) {
      while (i < data.length && (data[i] & 0x80) !== 0) i++;
      i++;
    } else if (wt === 2) {
      let len = 0;
      let shift = 0;
      while (i < data.length) {
        const b = data[i++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (fn === fieldNumber) {
        return data.slice(i, i + len);
      }
      i += len;
    } else if (wt === 5) {
      i += 4;
    } else if (wt === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return undefined;
}

export const globalCertPool = new CdmCertificatePool();
