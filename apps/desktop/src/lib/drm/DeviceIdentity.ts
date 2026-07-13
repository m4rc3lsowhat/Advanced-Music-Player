/*
 * ─── SOUNDCLOUD PLAYBACK — GROUND TRUTH (do NOT re-litigate; entitlement is not the issue) ───
 * NO track here requires Go+. Every liked track (incl. "DRM"/major-label ones like
 * Pop 1685274354) plays fine for THIS account in Chrome/Brave/Safari/Edge — no pay,
 * no Go+, never a problem. So a 403 in AMP is NEVER entitlement; it is a request-
 * context delta vs. a real browser (DataDome/anti-bot, cookies/session, CDM, headers).
 * The real browser request is the working reference — match it.
 */
/**
 * In-house device identity generation and persistence.
 *
 * AMP needs a stable, cryptographically-unique device identity for:
 *  - DRM license-request correlation (so the license server sees a consistent device)
 *  - Ad-inventory personalization (free-tier SoundCloud users)
 *  - Future first-party API authentication (our own developer identity system)
 *
 * The identity is generated once per machine+userData directory, persisted in
 * the Electron userData folder (encrypted with safeStorage when available), and
 * falls back to localStorage in browser previews.
 */

type PersistFn = (key: string, value: string) => Promise<void> | void;
type RetrieveFn = (key: string) => Promise<string | null | undefined> | string | null | undefined;

/** Browser-safe random bytes using Web Crypto. */
async function getRandomBytes(length: number): Promise<Uint8Array> {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.getRandomValues) {
    throw new Error("Secure random number generation is unavailable.");
  }
  return webCrypto.getRandomValues(new Uint8Array(length));
}

/** Browser-safe SHA-256 digest returning hex string. */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.subtle) {
    throw new Error("Secure hashing is unavailable.");
  }
  const hash = await webCrypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface DeviceIdentityPayload {
  /** Stable UUID v4 generated on first run. */
  deviceId: string;
  /** ISO timestamp of first generation. */
  createdAt: string;
  /** Ed25519-like signing key seed (32 bytes, base64). Not a full keypair yet —
   *  reserved for future first-party API request signing. */
  signingSeed?: string;
  /** A short "fingerprint" shown in UI for support / diagnostics. */
  fingerprint: string;
}

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly signingSeed: Uint8Array | undefined;
  /** Raw bytes for license-request nonce derivation. */
  readonly entropy: Uint8Array;
}

const STORAGE_KEY = "amp.device.identity.v1";

class DeviceIdentityManager {
  private cached: DeviceIdentity | undefined;
  private persistFn: PersistFn | undefined;
  private retrieveFn: RetrieveFn | undefined;

  setPersistence(persist: PersistFn, retrieve: RetrieveFn) {
    this.persistFn = persist;
    this.retrieveFn = retrieve;
  }

  async ensureIdentity(): Promise<DeviceIdentity> {
    if (this.cached) {
      return this.cached;
    }

    let raw: string | null | undefined = null;
    if (this.retrieveFn) {
      raw = await this.retrieveFn(STORAGE_KEY);
    }
    // Default fallback: localStorage in browser / Electron renderer
    if (!raw) {
      try {
        raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
      } catch {
        // ignore
      }
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as DeviceIdentityPayload;
        const identity = this.deserialize(parsed);
        this.cached = identity;
        return identity;
      } catch {
        // corrupt — regenerate below
      }
    }

    const identity = await this.generateNew();
    await this.save(identity);
    this.cached = identity;
    return identity;
  }

  clearCache(): void {
    this.cached = undefined;
  }

  private async generateNew(): Promise<DeviceIdentity> {
    const entropy = await getRandomBytes(32);
    const deviceId = globalThis.crypto.randomUUID?.() ?? (await this.fallbackUuid());
    const fingerprint = (await sha256Hex(entropy)).slice(0, 16);
    return {
      deviceId,
      fingerprint,
      signingSeed: entropy,
      entropy
    };
  }

  private deserialize(payload: DeviceIdentityPayload): DeviceIdentity {
    const entropy = new Uint8Array(32);
    if (payload.signingSeed) {
      try {
        const binary = atob(payload.signingSeed);
        const decoded = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          decoded[i] = binary.charCodeAt(i);
        }
        entropy.set(decoded.slice(0, 32));
      } catch {
        // ignore corrupt seed
      }
    }
    return {
      deviceId: payload.deviceId,
      fingerprint: payload.fingerprint,
      signingSeed: payload.signingSeed ? entropy : undefined,
      entropy
    };
  }

  private async save(identity: DeviceIdentity): Promise<void> {
    const payload: DeviceIdentityPayload = {
      deviceId: identity.deviceId,
      createdAt: new Date().toISOString(),
      fingerprint: identity.fingerprint,
      signingSeed: identity.signingSeed
        ? btoa(
            Array.from(identity.signingSeed)
              .map((b) => String.fromCharCode(b))
              .join("")
          )
        : undefined
    };
    const json = JSON.stringify(payload);
    if (this.persistFn) {
      await this.persistFn(STORAGE_KEY, json);
    } else {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, json);
      } catch {
        // ignore
      }
    }
  }

  private async fallbackUuid(): Promise<string> {
    const bytes = await getRandomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

export const deviceIdentityManager = new DeviceIdentityManager();
