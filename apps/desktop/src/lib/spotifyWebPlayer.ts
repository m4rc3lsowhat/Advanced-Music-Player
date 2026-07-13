/**
 * In-app Spotify playback via the official Web Playback SDK.
 *
 * This is AMP's Spotify playback path.
 */

import { clampVolume } from "@amp/core";

const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";
const PLAYER_NAME = "AMP";
const READY_TIMEOUT_MS = 15_000;

type TokenProvider = () => Promise<string | undefined>;

export interface SpotifyPlaybackState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: {
    current_track: { id: string; uri: string } | null;
  };
}

interface SpotifyPlayerInstance {
  connect(): Promise<boolean>;
  disconnect(): void;
  getCurrentState(): Promise<SpotifyPlaybackState | null>;
  setVolume(volume: number): Promise<void>;
  seek(positionMs: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  // The SDK's listener payloads vary per event; callers narrow with an inline type.
  addListener(event: string, cb: (payload: any) => void): boolean;
}

declare global {
  interface Window {
    Spotify?: {
      Player: new (options: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayerInstance;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let sdkLoad: Promise<void> | undefined;
let devicePromise: Promise<string> | undefined;
let player: SpotifyPlayerInstance | undefined;
let cachedDeviceId: string | undefined;
let deviceGeneration = 0;
const stateListeners = new Set<(state: SpotifyPlaybackState | null) => void>();

/** Inject the Spotify SDK script once and resolve when it signals ready. */
function loadSdk(): Promise<void> {
  if (sdkLoad) {
    return sdkLoad;
  }

  sdkLoad = new Promise<void>((resolve, reject) => {
    if (window.Spotify) {
      resolve();
      return;
    }

    // The SDK invokes this global once it has finished evaluating.
    window.onSpotifyWebPlaybackSDKReady = () => resolve();

    if (document.querySelector(`script[src="${SDK_SRC}"]`)) {
      // Tag already present (e.g. a prior failed attempt); the callback above resolves us.
      return;
    }

    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.onerror = () => {
      sdkLoad = undefined;
      reject(new Error("Could not load the Spotify Web Playback SDK (offline?)."));
    };
    document.head.appendChild(script);
  });

  return sdkLoad;
}

/**
 * Ensure the in-app Spotify Connect device exists and return its device id.
 * Resolves once the SDK reports `ready`. Rejects if the SDK can't initialise — no Premium, EME
 * missing, auth error, or a connect timeout — and the adapter surfaces that as a track error.
 */
export function ensureSpotifyWebDevice(getToken: TokenProvider): Promise<string> {
  if (cachedDeviceId) {
    return Promise.resolve(cachedDeviceId);
  }
  if (devicePromise) {
    return devicePromise;
  }

  const generation = deviceGeneration;
  const pending = (async () => {
    await loadSdk();
    if (generation !== deviceGeneration) {
      throw new Error("Spotify player initialization was cancelled.");
    }
    if (!window.Spotify) {
      throw new Error("Spotify Web Playback SDK unavailable.");
    }

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: number;

      const fail = (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        try {
          instance.disconnect();
        } catch {
          // best-effort
        }
        if (player === instance) {
          player = undefined;
          cachedDeviceId = undefined;
        }
        devicePromise = undefined;
        reject(new Error(message));
      };

      const instance = new window.Spotify!.Player({
        name: PLAYER_NAME,
        volume: 0.8,
        getOAuthToken: (cb) => {
          // Called on init and again whenever the SDK needs a fresh token; getToken
          // already refreshes, so this keeps the device authenticated indefinitely.
          void getToken().then((token) => {
            if (token && !settled && generation === deviceGeneration) {
              cb(token);
            }
          });
        }
      });

      timer = window.setTimeout(() => {
        fail("The in-app Spotify player did not start in time.");
      }, READY_TIMEOUT_MS);

      instance.addListener("ready", ({ device_id }: { device_id: string }) => {
        if (generation !== deviceGeneration) {
          fail("Spotify player initialization was cancelled.");
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        cachedDeviceId = device_id;
        player = instance;
        // Only cache connection work while it is pending. Once ready, cachedDeviceId is the cache;
        // retaining a resolved promise would return an offline id after a later not_ready event.
        devicePromise = undefined;
        resolve(device_id);
      });
      instance.addListener("not_ready", () => {
        if (!settled) {
          fail("The in-app Spotify player went offline before it was ready.");
          return;
        }
        if (player === instance) {
          try {
            instance.disconnect();
          } catch {
            // best-effort
          }
          player = undefined;
          cachedDeviceId = undefined;
          devicePromise = undefined;
        }
      });
      instance.addListener("initialization_error", ({ message }: { message: string }) => {
        fail(`Spotify player init failed: ${message}`);
      });
      instance.addListener("authentication_error", ({ message }: { message: string }) => {
        fail(`Spotify auth failed: ${message}`);
      });
      instance.addListener("account_error", ({ message }: { message: string }) => {
        fail(`Spotify account error (Premium required): ${message}`);
      });
      // Real-time playback state straight from the SDK — no Web API polling (which 429s).
      instance.addListener("player_state_changed", (state: SpotifyPlaybackState | null) => {
        for (const listener of stateListeners) {
          listener(state);
        }
      });

      void instance.connect().then((ok) => {
        if (generation !== deviceGeneration) {
          fail("Spotify player initialization was cancelled.");
        } else if (!ok) {
          fail("The in-app Spotify player could not connect.");
        }
      });
    });
  })();
  devicePromise = pending;

  // On failure, clear the cached promise so a later play() can retry from scratch.
  void pending.catch(() => {
    if (devicePromise === pending) {
      devicePromise = undefined;
    }
  });

  return pending;
}

export function getSpotifyWebDeviceId(): string | undefined {
  return cachedDeviceId;
}

/** Subscribe to the SDK's real-time playback-state events (track-end, pause, track change). */
export function subscribeSpotifyPlayerState(
  listener: (state: SpotifyPlaybackState | null) => void
): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** Read the SDK's current state LOCALLY (no Web API call) — used for smooth position updates. */
export async function getSpotifyPlayerState(): Promise<SpotifyPlaybackState | null> {
  try {
    return (await player?.getCurrentState()) ?? null;
  } catch {
    return null;
  }
}

/** Pause the in-app player LOCALLY through the SDK (no Web API call). */
export async function pauseSpotifyPlayer(): Promise<void> {
  try {
    await player?.pause();
  } catch {
    // best-effort
  }
}

/** Resume the in-app player LOCALLY through the SDK (no Web API call). */
export async function resumeSpotifyPlayer(): Promise<void> {
  try {
    await player?.resume();
  } catch {
    // best-effort
  }
}

/** Set the in-app player's volume LOCALLY (no Web API call). */
export async function setSpotifyPlayerVolume(volume: number): Promise<void> {
  try {
    await player?.setVolume(clampVolume(volume));
  } catch {
    // best-effort
  }
}

/**
 * Seek the in-app player LOCALLY through the SDK (no Web API call). The Web API
 * `/me/player/seek` leaves the in-app SDK device at the new position but with its audio silenced
 * (the slider moves, nothing plays) — seeking through the SDK keeps audio and position in sync.
 */
export async function setSpotifyPlayerPosition(positionMs: number): Promise<void> {
  try {
    await player?.seek(Math.max(0, Math.round(positionMs)));
  } catch {
    // best-effort
  }
}

export function teardownSpotifyWebDevice(): void {
  deviceGeneration += 1;
  try {
    player?.disconnect();
  } catch {
    // best-effort
  }
  player = undefined;
  cachedDeviceId = undefined;
  devicePromise = undefined;
}
