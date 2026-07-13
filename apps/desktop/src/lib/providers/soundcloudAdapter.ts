import type Hls from "hls.js";
/*
 * ─── SOUNDCLOUD PLAYBACK — GROUND TRUTH (do NOT re-litigate; entitlement is not the issue) ───
 * NO track here requires Go+. Every liked track (incl. "DRM"/major-label ones like
 * Pop 1685274354) plays fine for THIS account in Chrome/Brave/Safari/Edge — no pay,
 * no Go+, never a problem. So a 403 in AMP is NEVER entitlement; it is a request-
 * context delta vs. a real browser (DataDome/anti-bot, cookies/session, CDM, headers).
 * The real browser request is the working reference — match it.
 */
import type {
  PlaybackAdapter,
  PlaybackAdapterEvent,
  PlaybackAdapterListener,
  PlaybackAdapterSnapshot,
  ProviderCollection,
  TrackCollection
} from "@amp/core";
import type { ProviderConnection, UnifiedTrack } from "@amp/core";
import { clampVolume } from "@amp/core";
import { gatewayRequest } from "../desktopBridge";
import {
  getSoundCloudStreamReadyTimeoutMessage,
  resetSoundCloudWidgetEventBridge,
  WidgetPlaybackStartGate
} from "./playbackGuards";
import {
  DrmFallbackChain,
  globalSubscriptionDetector,
  globalAdInjector,
  deviceIdentityManager
} from "../drm";

interface SoundCloudWidgetProgressEvent {
  currentPosition?: number;
  /** Fraction of the track played, 0..1 (~1 at the end). SoundCloud sends this on PLAY_PROGRESS. */
  relativePosition?: number;
}

interface SoundCloudWidgetController {
  bind(event: string, callback: (payload?: SoundCloudWidgetProgressEvent) => void): void;
  unbind(event: string): void;
  getDuration(callback: (durationMs: number) => void): void;
  getPosition(callback: (positionMs: number) => void): void;
  /** Swap the loaded track in-place without rebuilding the iframe/player. */
  load(url: string, options?: { auto_play?: boolean; callback?: () => void }): void;
  pause(): void;
  play(): void;
  seekTo(positionMs: number): void;
  setVolume(volume: number): void;
}

interface SoundCloudWidgetApi {
  (iframe: HTMLIFrameElement): SoundCloudWidgetController;
  Events: {
    READY: string;
    PLAY: string;
    PAUSE: string;
    FINISH: string;
    PLAY_PROGRESS: string;
    /** SC.Widget.Events.ERROR ("error") — present at runtime, omitted from older typings. */
    ERROR?: string;
  };
}

interface CachedValue<T> {
  expiresAt: number;
  value: T;
}

declare global {
  interface Window {
    SC?: {
      Widget?: SoundCloudWidgetApi;
    };
  }
}

const SOUND_CLOUD_LIKES_COLLECTION_ID = "likes";
const STREAM_READY_TIMEOUT_MS = 6000;
// How long the widget fallback may take to produce real, advancing playback before we treat the
// track as unplayable (e.g. DRM-locked) and let the caller fall through / auto-skip.
const WIDGET_PLAYBACK_TIMEOUT_MS = 10_000;

// Flag-gated DRM/EME diagnostics. Defaults ON so the next play attempt is conclusive without
// extra setup; silence it from DevTools with `localStorage.setItem("sc.drm.debug", "0")`.
const SC_DRM_DEBUG = (() => {
  try {
    return globalThis.localStorage?.getItem("sc.drm.debug") !== "0";
  } catch {
    return true;
  }
})();

function drmLog(message: string, ...rest: unknown[]): void {
  if (SC_DRM_DEBUG) {
    console.log(`[SC DRM] ${message}`, ...rest);
  }
}

function drmHexPreview(buffer: ArrayBuffer | undefined, count = 8): string {
  if (!buffer) {
    return "null";
  }
  return Array.from(new Uint8Array(buffer))
    .slice(0, count)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

export class SoundCloudPlaybackAdapter implements PlaybackAdapter {
  readonly provider = "soundcloud" as const;

  private audio = document.createElement("video");
  private hls?: Hls;
  private listeners = new Set<PlaybackAdapterListener>();
  private widgetApiPromise?: Promise<SoundCloudWidgetApi>;
  private widget?: SoundCloudWidgetController;
  private widgetIframe?: HTMLIFrameElement;
  private widgetTrackUrl?: string;
  /**
   * Guards against emitting more than one "ended" per widget track. The widget's FINISH event is
   * unreliable for the hidden iframe, so we ALSO treat end-of-progress as the track ending — this
   * flag de-dupes the two triggers. Re-armed when a new track actually starts playing.
   */
  private widgetEndedEmitted = false;
  // Position-polling watchdog: the widget's PLAY_PROGRESS/FINISH events are unreliable for the hidden
  // iframe, so we poll its real position to detect end-of-track instead.
  private widgetPoll?: ReturnType<typeof setInterval>;
  private widgetLastPolledPosition = -1;
  private widgetStallTicks = 0;
  private widgetLastProgressEmitAt = 0;
  private widgetPlaybackStartGate = new WidgetPlaybackStartGate({
    timeoutMs: WIDGET_PLAYBACK_TIMEOUT_MS,
    timeoutMessage: "SoundCloud widget never started playing (stream blocked in-app)."
  });
  private playbackMode: "stream" | "widget" | undefined;
  private snapshot: PlaybackAdapterSnapshot = {
    provider: "soundcloud",
    status: "idle",
    positionMs: 0,
    durationMs: 0,
    volume: 0.8
  };
  // Incremented on every play(); a play whose token is stale (a newer one started) bails out so
  // two overlapping plays can't fight over the single audio element.
  private playToken = 0;
  /**
   * Tracks whether we should detach MediaKeys when the next track starts.
   * hls.js creates MediaKeys and sessions for DRM tracks, but does not
   * automatically detach them on destroy(). We do it manually when switching
   * from a DRM track to a non-DRM track to avoid session leakage.
   */
  private shouldDetachMediaKeys = false;
  private fallbackChain = new DrmFallbackChain();

  constructor(private options: SoundCloudAdapterOptions) {
    if (options.initialVolume != null) {
      this.snapshot = { ...this.snapshot, volume: clampVolume(options.initialVolume) };
    }
    this.audio.preload = "metadata";
    // NOTE: deliberately NO crossOrigin. Routing this element through Web Audio (for the old
    // beat-detection tap) required crossOrigin="anonymous", which forced every SoundCloud stream
    // fetch into CORS mode — tracks whose CDN omits Access-Control-Allow-Origin then either failed
    // to load or played SILENT-but-"playing" and locked up the app. The reactor now reads system
    // audio via loopback (like Spotify), so this element just plays normally with no CORS coupling.
    this.audio.volume = this.snapshot.volume;
    // Attach (hidden) to the document so the element behaves like a standard media element.
    if (typeof document !== "undefined") {
      this.audio.setAttribute("aria-hidden", "true");
      this.audio.style.display = "none";
      document.body.appendChild(this.audio);
    }
    this.bindAudioEvents();
  }

  subscribe(listener: PlaybackAdapterListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async search(query: string): Promise<UnifiedTrack[]> {
    const result = await gatewayRequest<UnifiedTrack[]>({
      provider: "soundcloud",
      operation: "search",
      variables: { query }
    });

    if (!result.ok || !result.data) {
      throw new Error(result.error ?? "SoundCloud search failed.");
    }

    return result.data;
  }

  /**
   * Discover tracks related to a SoundCloud track (api-v2 `/tracks/{id}/related`). Powers Stations
   * and the SoundCloud side of Daily Mixes. Returns [] on any failure so discovery degrades quietly
   * rather than throwing into the mix builder.
   */
  async relatedTracks(track: UnifiedTrack): Promise<UnifiedTrack[]> {
    if (track.provider !== "soundcloud") {
      return [];
    }
    // Pass the whole track — the gateway extracts the bare numeric id from its URN providerTrackId.
    const result = await gatewayRequest<UnifiedTrack[]>({
      provider: "soundcloud",
      operation: "relatedTracks",
      variables: { track, limit: 20 }
    });
    return result.ok && result.data ? result.data : [];
  }

  /**
   * Resolves a *public* SoundCloud profile URL into its likes, uploads, and public playlists —
   * anonymously, using the scraped public client_id. No sign-in required. Only returns data the
   * profile owner has made public (private likes need the browser sign-in path instead).
   */
  async resolveProfile(profileUrl: string): Promise<SoundCloudProfileResult> {
    const result = await gatewayRequest<SoundCloudProfileResult>({
      provider: "soundcloud",
      operation: "resolveProfile",
      variables: { profileUrl }
    });

    if (!result.ok || !result.data) {
      throw new Error(result.error ?? "Could not load that SoundCloud profile.");
    }

    return result.data;
  }

  async getCollections(): Promise<ProviderCollection[]> {
    const connection = this.options.getConnection();
    const token = connection?.accessToken;

    if (token) {
      const result = await gatewayRequest<ProviderCollection[]>({
        provider: "soundcloud",
        operation: "getCollections",
        variables: { accessToken: token }
      });

      if (result.ok && result.data) {
        return result.data;
      }
    }

    // Fallback: return just Likes for unauthenticated users
    return [
      {
        id: SOUND_CLOUD_LIKES_COLLECTION_ID,
        provider: "soundcloud",
        kind: "likes",
        title: "Likes",
        trackCount: 0
      }
    ];
  }

  async getCollectionTracks(collectionId: string): Promise<TrackCollection> {
    const connection = this.options.getConnection();
    const token = connection?.accessToken;

    if (!token) {
      throw new Error("Connect SoundCloud to access collection tracks.");
    }

    const result = await gatewayRequest<TrackCollection>({
      provider: "soundcloud",
      operation: "getCollectionTracks",
      variables: { collectionId, accessToken: token }
    });

    if (!result.ok || !result.data) {
      throw new Error(result.error ?? "Failed to fetch SoundCloud collection tracks.");
    }

    return result.data;
  }

  async getLibrary(): Promise<TrackCollection> {
    return this.getCollectionTracks(SOUND_CLOUD_LIKES_COLLECTION_ID);
  }

  async play(track: UnifiedTrack, context: { positionMs?: number }): Promise<void> {
    const token = ++this.playToken;
    const superseded = () => token !== this.playToken;
    const startPositionMs = context.positionMs ?? 0;

    // Same-provider handoffs do not call teardown(), so stop the old stream/widget immediately
    // before any async resolve work. This prevents the previous SoundCloud track from leaking
    // audio or currentTime into the next one while the new stream URL loads.
    this.stopCurrentPlayback();
    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        status: "loading",
        positionMs: startPositionMs,
        durationMs: track.durationMs,
        activeTrackId: track.providerTrackId,
        error: undefined
      }
    });

    try {
      const streamResult = await gatewayRequest<{
        url: string;
        drm?: {
          system: string;
          licenseUrl: string;
          licenseAuthToken?: string;
          oauthToken?: string;
          trackAuthorization?: string;
        };
      }>({
        provider: "soundcloud",
        operation: "resolveStream",
        variables: { track }
      });
      if (superseded()) {
        return;
      }

      if (!streamResult.ok || !streamResult.data?.url) {
        throw new Error(streamResult.error ?? "Could not resolve SoundCloud stream.");
      }

      // Detect subscription tier from track metadata (heuristic when API data absent).
      globalSubscriptionDetector.ingestTrackHeuristic(track.requiresGoPlus ?? false);

      // Free-tier ad injection scaffold: attempt to play an ad break before the track.
      // In Phase 1 this returns immediately (no ad network wired yet).
      await globalAdInjector.maybePlayAdsBeforeTrack({
        trackTitle: track.title,
        trackDurationMs: track.durationMs
      });
      if (superseded()) {
        return;
      }

      await this.loadStream(streamResult.data.url, streamResult.data.drm, track);
      if (superseded()) {
        return;
      }
      // loadStream's fallback chain may have played this track through the SoundCloud widget
      // (widget-first fast path or the widget fallback stage). In that case the widget owns playback
      // and the end-of-track poll, and playWithWidget already emitted the playing state — so we must
      // NOT clobber the mode back to "stream" or start the (src-less) <audio> element. Doing so was
      // the bug that gated out every widget event/poll handler and broke queue auto-advance.
      if (this.playbackMode === "widget") {
        return;
      }
      this.playbackMode = "stream";
      if (startPositionMs > 0) {
        this.audio.currentTime = startPositionMs / 1000;
      }
      await this.audio.play();
      if (superseded()) {
        this.stopCurrentPlayback();
        return;
      }
    } catch (streamError) {
      if (superseded()) {
        return;
      }
      if (!track.externalUrl) {
        throw streamError;
      }

      try {
        await this.playWithWidget(track, startPositionMs);
        return;
      } catch {
        throw streamError;
      }
    }

    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        status: "playing",
        positionMs: startPositionMs,
        durationMs: track.durationMs,
        activeTrackId: track.providerTrackId,
        error: undefined
      }
    });
  }

  async pause(): Promise<void> {
    if (this.playbackMode === "widget" && this.widget) {
      this.widget.pause();
    } else {
      this.audio.pause();
    }

    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        status: "paused"
      }
    });
  }

  async seek(positionMs: number): Promise<void> {
    if (this.playbackMode === "widget" && this.widget) {
      this.widget.seekTo(positionMs);
    } else {
      this.audio.currentTime = positionMs / 1000;
    }

    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        positionMs
      }
    });
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = clampVolume(volume);
    this.audio.volume = clamped;
    if (this.playbackMode === "widget" && this.widget) {
      this.widget.setVolume(Math.round(clamped * 100));
    }

    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        volume: clamped
      }
    });
  }

  async teardown(): Promise<void> {
    this.playToken += 1;
    this.stopCurrentPlayback();

    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        status: "paused",
        positionMs: 0
      }
    });
  }

  private stopCurrentPlayback(): void {
    this.widgetPlaybackStartGate.cancel(new Error("SoundCloud widget playback was interrupted."));
    this.stopWidgetEndPolling();
    const wasWidget = this.playbackMode === "widget";
    this.playbackMode = undefined;

    if (wasWidget && this.widget) {
      try {
        this.widget.pause();
      } catch {
        // Widget teardown should not block provider handoff.
      }
    }
    // Remove the widget iframe entirely — pausing it over postMessage is unreliable, so the only
    // way to guarantee its audio stops (and never overlaps the other provider) is to delete it.
    this.destroyWidget();

    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.hls?.destroy();
    this.hls = undefined;
    if (this.shouldDetachMediaKeys && this.audio.mediaKeys) {
      this.audio.setMediaKeys(null).catch(() => {
        // ignore
      });
      this.shouldDetachMediaKeys = false;
    }
  }


  private bindAudioEvents() {
    // Coalesce position emits to ~4/sec. Each emit fans out to a store set({ playback }) + React
    // render; an unthrottled timeupdate (which a stalling stream can fire in bursts) would turn that
    // into a synchronous render storm that locks the whole UI. The seek bar only needs ~4/sec.
    let lastTimeUpdateEmit = 0;
    this.audio.addEventListener("timeupdate", () => {
      if (this.playbackMode !== "stream") {
        return;
      }
      const now = performance.now();
      if (now - lastTimeUpdateEmit < 240) {
        return;
      }
      lastTimeUpdateEmit = now;

      this.emit({
        type: "state",
        snapshot: {
          ...this.snapshot,
          status: this.audio.paused ? "paused" : "playing",
          positionMs: this.audio.currentTime * 1000,
          durationMs: Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : this.snapshot.durationMs,
          volume: this.snapshot.volume
        }
      });
    });

    this.audio.addEventListener("ended", () => {
      if (this.playbackMode !== "stream") {
        return;
      }

      this.emit({
        type: "ended",
        snapshot: {
          ...this.snapshot,
          status: "paused",
          positionMs: this.snapshot.durationMs
        }
      });
    });

    this.audio.addEventListener("error", () => {
      if (this.playbackMode !== "stream") {
        return;
      }

      this.emitError("SoundCloud playback failed to start.");
    });
  }

  private async loadStream(
    source: string,
    drm?: {
      system: string;
      licenseUrl: string;
      licenseAuthToken?: string;
      oauthToken?: string;
      trackAuthorization?: string;
    },
    track?: UnifiedTrack
  ): Promise<void> {
    this.destroyWidget();
    this.playbackMode = "stream";
    this.hls?.destroy();
    this.hls = undefined;
    if (this.shouldDetachMediaKeys && this.audio.mediaKeys) {
      this.audio.setMediaKeys(null).catch(() => {
        // ignore
      });
      this.shouldDetachMediaKeys = false;
    }

    // Pre-fetch init segment for DRM so the fallback chain can extract PSSH.
    let initSegment: ArrayBuffer | undefined;
    if (drm && source.includes(".m3u8")) {
      try {
        const manifestText = await fetch(source, { credentials: "include" }).then((r) =>
          r.ok ? r.text() : ""
        );
        const mapMatch = manifestText.match(/#EXT-X-MAP:URI=["']([^"']+)["']/);
        if (mapMatch) {
          const initUrl = new URL(mapMatch[1], source).toString();
          const response = await fetch(initUrl, { credentials: "include" });
          if (response.ok) {
            initSegment = await response.arrayBuffer();
          }
        }
      } catch {
        // best-effort
      }
    }

    const drmConfig = drm
      ? {
          system: "com.widevine.alpha" as const,
          licenseUrl: drm.licenseUrl,
          licenseAuthToken: drm.licenseAuthToken,
          trackAuthorization: drm.trackAuthorization,
          oauthToken: drm.oauthToken
        }
      : undefined;

    const result = await this.fallbackChain.execute({
      audio: this.audio,
      streamUrl: source,
      drmConfig,
      initSegment,
      widgetFactory: track?.externalUrl
        ? () => this.playWithWidget(track, 0)
        : undefined
    });

    this.hls = result.hlsInstance;
    if (drmConfig) {
      this.shouldDetachMediaKeys = true;
    }

    // Log diagnostics for debugging
    if (result.diagnostics.error) {
      console.warn("[SC DRM] Fallback chain diagnostics:", result.diagnostics);
    }
  }

  private async playWithWidget(track: UnifiedTrack, positionMs: number): Promise<void> {
    if (!track.externalUrl) {
      throw new Error("SoundCloud widget playback needs a public track URL.");
    }

    if (this.playbackMode !== "widget") {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.hls?.destroy();
      this.hls = undefined;
    }

    if (!this.widget || !this.widgetIframe) {
      // No warm player yet — build the iframe and load the player shell once (the slow part:
      // downloads the SoundCloud widget JS + inits its EME pipeline).
      this.widget = await this.createWidget(track.externalUrl);
      this.widgetTrackUrl = track.externalUrl;
    } else if (this.widgetTrackUrl !== track.externalUrl) {
      // Reuse the warm iframe: swap the track in place via the Widget API instead of rebuilding it.
      // This skips reloading the player page + widget JS + EME shell — the bulk of the per-track
      // latency — so subsequent DRM tracks start almost immediately.
      await this.loadWidgetTrack(this.widget, track.externalUrl);
      this.widgetTrackUrl = track.externalUrl;
    }

    this.playbackMode = "widget";
    this.widget.setVolume(Math.round(this.snapshot.volume * 100));
    if (positionMs > 0) {
      this.widget.seekTo(positionMs);
    }
    this.widgetEndedEmitted = true;
    const playbackStarted = this.waitForWidgetPlayback();
    this.widget.play();

    // The widget reports "ready" on iframe injection, not on real playback. A track whose stream
    // is blocked in-app (monetized/Widevine that 403s its license or 404s its streams in AMP's
    // context) loads the widget fine but leaves a silent "playing" state that never advances.
    // Require genuine forward progress before we report success; otherwise reject so play()'s
    // caller (and the queue) can surface the failure and move on.
    await playbackStarted;
    // The new track is now genuinely playing (position near 0), so arm end-detection for it. Done
    // here (not at the start of playWithWidget) so a stale end-of-progress event from the previous
    // track can't slip through the window before the swap completes and double-advance the queue.
    this.widgetEndedEmitted = false;
    this.startWidgetEndPolling();

    const durationMs = await this.getWidgetDuration(this.widget);
    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        // Preserve a pause issued while the widget was still spinning up — this emit confirms the
        // widget produced real playback, but it must not overrule the user's latest intent.
        status: this.snapshot.status === "paused" ? "paused" : "playing",
        // Keep the live position PLAY_PROGRESS has already reported. Using the `positionMs` arg here
        // (0 for the widget-first fast path) would yank the progress bar back to 0 right after the
        // track starts — a visible "jump backwards" every time a widget track begins.
        positionMs: this.snapshot.positionMs,
        durationMs: durationMs || track.durationMs,
        activeTrackId: track.providerTrackId,
        error: undefined
      }
    });
  }

  private async createWidget(trackUrl: string): Promise<SoundCloudWidgetController> {
    const widgetApi = await this.loadWidgetApi();
    this.destroyWidget();

    const iframe = document.createElement("iframe");
    iframe.src = buildWidgetUrl(trackUrl);
    // Give the iframe a real size (parked off-screen) rather than 1x1: at 1x1 the widget's internal
    // waveform canvas is 0-sized, which throws uncaught CanvasRenderingContext2D.createPattern errors
    // every frame in the widget's render loop and can stop it emitting PLAY_PROGRESS/FINISH — which
    // is what stalls queue auto-advance. A normal-sized, off-screen, transparent iframe renders
    // cleanly while staying invisible.
    iframe.width = "320";
    iframe.height = "160";
    iframe.allow = "autoplay; encrypted-media";
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.position = "fixed";
    iframe.style.left = "-10000px";
    iframe.style.top = "0";
    iframe.style.width = "320px";
    iframe.style.height = "160px";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";

    document.body.appendChild(iframe);

    const widget = widgetApi(iframe);
    this.widgetIframe = iframe;
    this.widget = widget;
    try {
      await this.waitForWidgetReady(widgetApi, widget);
      this.resetWidgetEventBridge(widgetApi, widget);
      return widget;
    } catch (error) {
      if (this.widget === widget) {
        this.destroyWidget();
      }
      throw error;
    }
  }

  /**
   * Swap the track inside the existing warm widget iframe via the Widget API. Far faster than
   * createWidget() because the player page, widget JS, and EME shell are already loaded — only the
   * new track's stream is resolved.
   *
   * SoundCloud keeps existing event listeners across load(), so the adapter re-installs its bridge
   * with an unbind-first reset after the load completes. This keeps one progress/end handler alive
   * for the current widget instead of stacking duplicates on every warm swap.
   */
  private async loadWidgetTrack(
    widget: SoundCloudWidgetController,
    trackUrl: string
  ): Promise<void> {
    const widgetApi = await this.loadWidgetApi();
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error("SoundCloud widget did not load the next track in time."));
      }, 12_000);
      widget.load(trackUrl, {
        auto_play: true,
        callback: () => {
          window.clearTimeout(timeout);
          resolve();
        }
      });
    });
    this.resetWidgetEventBridge(widgetApi, widget);
  }

  private async loadWidgetApi(): Promise<SoundCloudWidgetApi> {
    if (window.SC?.Widget) {
      return window.SC.Widget;
    }

    if (this.widgetApiPromise) {
      return this.widgetApiPromise;
    }

    this.widgetApiPromise = new Promise<SoundCloudWidgetApi>((resolve, reject) => {
      const existing = document.getElementById("soundcloud-widget-api") as HTMLScriptElement | null;
      if (existing) {
        window.setTimeout(() => {
          if (window.SC?.Widget) {
            resolve(window.SC.Widget);
            return;
          }
          reject(new Error("SoundCloud widget API did not finish loading."));
        }, 50);
        return;
      }

      const script = document.createElement("script");
      script.id = "soundcloud-widget-api";
      script.src = "https://w.soundcloud.com/player/api.js";
      script.async = true;
      script.onload = () => {
        if (window.SC?.Widget) {
          resolve(window.SC.Widget);
          return;
        }
        reject(new Error("SoundCloud widget API loaded without exposing SC.Widget."));
      };
      script.onerror = () => reject(new Error("Failed to load the SoundCloud widget API."));
      document.body.appendChild(script);
    });

    return this.widgetApiPromise;
  }

  private async waitForWidgetReady(
    widgetApi: SoundCloudWidgetApi,
    widget: SoundCloudWidgetController
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        window.clearTimeout(timeout);
        widget.unbind(widgetApi.Events.READY);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timeout = window.setTimeout(() => {
        settle(new Error("SoundCloud widget playback did not finish loading."));
      }, 12_000);

      widget.bind(widgetApi.Events.READY, () => {
        settle();
      });
    });
  }

  private resetWidgetEventBridge(
    widgetApi: SoundCloudWidgetApi,
    widget: SoundCloudWidgetController
  ): void {
    resetSoundCloudWidgetEventBridge(widget, widgetApi.Events, {
      onPlay: () => {
        if (this.playbackMode !== "widget") {
          return;
        }

        this.emit({
          type: "state",
          snapshot: {
            ...this.snapshot,
            status: "playing",
            error: undefined
          }
        });
      },
      onPause: () => {
        if (this.playbackMode !== "widget") {
          return;
        }

        this.emit({
          type: "state",
          snapshot: {
            ...this.snapshot,
            status: "paused"
          }
        });
      },
      onProgress: (payload) => this.handleWidgetProgress(payload),
      onFinish: () => {
        if (this.playbackMode !== "widget") {
          return;
        }
        this.emitWidgetEnded();
      },
      onError: () => {
        this.widgetPlaybackStartGate.reject(
          new Error("SoundCloud widget reported an error (stream blocked in-app).")
        );
      }
    });
  }

  private handleWidgetProgress(payload?: SoundCloudWidgetProgressEvent): void {
    const currentPosition = payload?.currentPosition ?? this.snapshot.positionMs;
    if (currentPosition > 0) {
      this.widgetPlaybackStartGate.resolve();
    }

    if (this.playbackMode !== "widget") {
      return;
    }

    // Coalesce emits to ~4/sec, mirroring the stream path's timeupdate throttle. The widget fires
    // PLAY_PROGRESS many times a second; every emit becomes a store set + a re-render of every
    // component subscribed to `playback`, and at full event rate that render storm saturates the
    // main thread — dropped clicks, frozen beat overlay, the works. ~4/sec is the cadence the
    // stream path already proves out.
    const now = performance.now();
    if (now - this.widgetLastProgressEmitAt >= 240) {
      this.widgetLastProgressEmitAt = now;
      this.emit({
        type: "state",
        snapshot: {
          ...this.snapshot,
          // A progress tick must never flip a user pause back to "playing": the widget flushes
          // trailing PLAY_PROGRESS events after PAUSE, and since nothing else emits while paused,
          // the stuck "playing" status kept the UI's smooth ticker advancing the seek bar forever.
          // Real resumes announce themselves via the PLAY event / play(), never via progress.
          status: this.snapshot.status === "paused" ? "paused" : "playing",
          positionMs: currentPosition,
          volume: this.snapshot.volume
        }
      });
    }

    // Primary auto-advance trigger: the widget's FINISH event frequently never fires for the
    // hidden iframe, so when progress reaches the end of the track, treat it as ended too.
    // Deliberately outside the throttle window — the final ticks must not be skipped.
    const relative =
      payload?.relativePosition ??
      (this.snapshot.durationMs > 0 ? currentPosition / this.snapshot.durationMs : 0);
    if (relative >= 0.99) {
      this.emitWidgetEnded();
    }
  }

  /** Emit exactly one "ended" for the current widget track (FINISH + end-of-progress can both fire). */
  private emitWidgetEnded(): void {
    if (this.widgetEndedEmitted) {
      return;
    }
    this.widgetEndedEmitted = true;
    this.stopWidgetEndPolling();
    this.emit({
      type: "ended",
      snapshot: {
        ...this.snapshot,
        status: "paused",
        positionMs: this.snapshot.durationMs
      }
    });
  }

  /**
   * Polls the widget's real position on a timer instead of trusting its PLAY_PROGRESS/FINISH events
   * (which often never fire for the hidden iframe). Advances the queue when playback reaches the end
   * of the track, or stalls in the final stretch (the widget commonly pauses at the end without
   * firing FINISH). This is the reliable end-of-track signal across the widget's quirks.
   */
  private startWidgetEndPolling(): void {
    this.stopWidgetEndPolling();
    this.widgetLastPolledPosition = -1;
    this.widgetStallTicks = 0;
    this.widgetPoll = setInterval(() => {
      if (this.playbackMode !== "widget" || this.widgetEndedEmitted) {
        return;
      }
      // Read the position PLAY_PROGRESS maintains in our snapshot (it's what drives the progress bar)
      // rather than the widget's getPosition(), whose callback doesn't fire for the hidden iframe.
      const positionMs = this.snapshot.positionMs;
      const dur = this.snapshot.durationMs || 0;
      if (dur <= 0) {
        return;
      }
      const ratio = positionMs / dur;

      // Reached the very end → advance. Unconditional (independent of play/pause) because the widget
      // commonly auto-pauses at the natural end without firing FINISH, and we still want to advance.
      if (positionMs >= dur - 1500 || ratio >= 0.985) {
        this.emitWidgetEnded();
        return;
      }

      // Stall detection — ONLY while actually playing. Otherwise a user-initiated pause near the end
      // freezes the position and would be mistaken for an end-of-track stall, triggering a spurious
      // auto-advance a few seconds after the user pauses. Reset the counter while paused.
      if (this.snapshot.status !== "playing") {
        this.widgetStallTicks = 0;
        this.widgetLastPolledPosition = positionMs;
        return;
      }
      if (positionMs > this.widgetLastPolledPosition + 250) {
        this.widgetLastPolledPosition = positionMs;
        this.widgetStallTicks = 0;
      } else {
        this.widgetStallTicks += 1;
      }
      // Position frozen in the final stretch for several ticks → the track has effectively finished
      // (the widget sometimes stops emitting progress just shy of the end without firing FINISH).
      if (this.widgetStallTicks >= 3 && ratio >= 0.9) {
        this.emitWidgetEnded();
      }
    }, 1500);
  }

  private stopWidgetEndPolling(): void {
    if (this.widgetPoll) {
      clearInterval(this.widgetPoll);
      this.widgetPoll = undefined;
    }
  }

  private async getWidgetDuration(widget: SoundCloudWidgetController): Promise<number> {
    return new Promise((resolve) => {
      widget.getDuration((durationMs) => resolve(durationMs ?? 0));
    });
  }

  /**
   * Resolve only once the widget produces real, advancing playback (PLAY_PROGRESS with a
   * position > 0). Reject on the widget's own ERROR event or after a timeout. This turns the
   * widget's "injected" state into an honest "is actually playing" check so a track the widget
   * cannot play (e.g. DRM-restricted) fails fast instead of sitting silent.
   */
  private waitForWidgetPlayback(): Promise<void> {
    return this.widgetPlaybackStartGate.wait();
  }

  /** Simple hash for deduplicating MediaKeySession initData. */
  private hashArrayBuffer(buffer: ArrayBuffer, maxBytes = 64): string {
    const view = new Uint8Array(buffer);
    let hash = 0;
    const limit = Math.min(view.length, maxBytes);
    for (let i = 0; i < limit; i++) {
      hash = (hash * 31 + view[i]) | 0;
    }
    return `${hash.toString(16)}_${view.length}`;
  }

  /**
   * Fetch SoundCloud's Widevine SERVICE (privacy) certificate and install it on `mediaKeys`
   * via setServerCertificate(). Returns true once a certificate is successfully installed.
   *
   * The Widevine cert endpoint is not officially documented, so we try the two known shapes in
   * order and stop at the first the CDM accepts:
   *   1. A clean GET on the license host's /playback/widevine path (no query, no body). This
   *      mirrors the captured Safari FairPlay baseline (GET /playback/fairplay -> 200,
   *      application/x-x509-ca-cert) — SoundCloud's own infrastructure pattern.
   *   2. A Widevine "service certificate request" POST: the 2-byte SignedMessage
   *      { type: SERVICE_CERTIFICATE_REQUEST } == [0x08, 0x04], the standard CDM probe.
   * Per W3C EME, setServerCertificate() resolves false only when the key system cannot use
   * server certificates at all, and rejects when the blob is malformed; a reject just means we
   * fall through to the next shape.
   */
  private async installWidevineServiceCertificate(
    mediaKeys: MediaKeys,
    licenseUrl: string
  ): Promise<boolean> {
    const certUrl = new URL(licenseUrl);
    certUrl.search = "";
    const target = certUrl.toString();

    const attempts: Array<{ label: string; init: RequestInit }> = [
      { label: "GET", init: { method: "GET", credentials: "include" } },
      {
        label: "POST-2byte",
        init: {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/octet-stream" },
          // Widevine SignedMessage { type: SERVICE_CERTIFICATE_REQUEST }
          body: new Uint8Array([0x08, 0x04])
        }
      }
    ];

    for (const attempt of attempts) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(target, { ...attempt.init, signal: controller.signal });
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok) {
          drmLog(
            `certFetch ${attempt.label} ${certUrl.pathname} status=${response.status} ct=${contentType}`
          );
          continue;
        }
        const certBuffer = await response.arrayBuffer();
        drmLog(
          `certFetch ${attempt.label} ${certUrl.pathname} status=${response.status} ct=${contentType} size=${certBuffer.byteLength} preview=${drmHexPreview(certBuffer, 8)}`
        );
        if (certBuffer.byteLength === 0) {
          continue;
        }
        try {
          const accepted = await mediaKeys.setServerCertificate(new Uint8Array(certBuffer));
          if (accepted === false) {
            // Key system does not support server certificates at all — no shape will help.
            drmLog(`setServerCertificate(${attempt.label}) returned false (key system unsupported)`);
            return false;
          }
          drmLog(`setServerCertificate(${attempt.label}) OK size=${certBuffer.byteLength}`);
          return true;
        } catch (certError) {
          console.error(
            `[SC DRM] setServerCertificate(${attempt.label}) rejected — blob is not a valid Widevine service cert (ct=${contentType}, size=${certBuffer.byteLength})`,
            certError
          );
        }
      } catch (error) {
        drmLog(`certFetch ${attempt.label} failed: ${(error as Error)?.message ?? String(error)}`);
      } finally {
        window.clearTimeout(timeout);
      }
    }
    return false;
  }

  /** Extract the first Widevine PSSH box from an MP4 init segment (recursive). */
  private extractPsshFromMp4(buffer: ArrayBuffer): ArrayBuffer | undefined {
    const CONTAINER_BOXES = new Set([
      "moov", "trak", "mdia", "minf", "stbl", "stsd", "enca", "encv",
      "sinf", "schi", "moof", "traf"
    ]);
    const WIDEVINE_SYSTEM_ID = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";

    function readBoxSize(view: DataView, offset: number): number {
      const size = view.getUint32(offset, false);
      if (size === 1) {
        // extended size
        const high = view.getUint32(offset + 8, false);
        const low = view.getUint32(offset + 12, false);
        if (high !== 0) {
          // 64-bit size too large for JS — skip it
          return -1;
        }
        return low;
      }
      return size;
    }

    function parseBoxes(view: DataView, start: number, end: number): ArrayBuffer | undefined {
      let offset = start;
      while (offset < end - 8) {
        const size = readBoxSize(view, offset);
        if (size <= 0 || offset + size > end) {
          break;
        }
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
          const normalizedSystemId =
            systemId.slice(0, 8) + "-" +
            systemId.slice(8, 12) + "-" +
            systemId.slice(12, 16) + "-" +
            systemId.slice(16, 20) + "-" +
            systemId.slice(20);
          if (normalizedSystemId === WIDEVINE_SYSTEM_ID) {
            return buffer.slice(offset, offset + size);
          }
        } else if (CONTAINER_BOXES.has(type)) {
          // Skip 8-byte header (or 16-byte extended header)
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

  private destroyWidget(): void {
    this.stopWidgetEndPolling();
    const widget = this.widget;
    const events = window.SC?.Widget?.Events;
    if (widget && events) {
      for (const event of [events.READY, events.PLAY, events.PAUSE, events.FINISH, events.PLAY_PROGRESS, events.ERROR]) {
        if (event) {
          widget.unbind(event);
        }
      }
    }
    this.widget = undefined;
    this.widgetTrackUrl = undefined;

    if (this.widgetIframe) {
      this.widgetIframe.remove();
      this.widgetIframe = undefined;
    }
  }

  private emit(event: PlaybackAdapterEvent): void {
    this.snapshot = event.snapshot;
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private emitError(message: string): void {
    this.emit({
      type: "error",
      snapshot: {
        ...this.snapshot,
        status: "error",
        error: message
      }
    });
  }
}

interface SoundCloudAdapterOptions {
  getConnection: () => ProviderConnection | undefined;
  refreshConnection: () => Promise<ProviderConnection | undefined>;
  onConnectionIssue: (issue: string, patch?: Partial<ProviderConnection>) => void;
  /** Effective starting volume after master and provider trim are applied. */
  initialVolume?: number;
}

export interface SoundCloudProfileResult {
  /** The profile's display name (full name or @username). */
  displayName: string;
  /** Public liked tracks. */
  likes: UnifiedTrack[];
  /** The profile's own public uploads. */
  uploads: UnifiedTrack[];
  /** Public playlists, as selectable collections. */
  playlists: ProviderCollection[];
}

function buildWidgetUrl(trackUrl: string): string {
  const params = new URLSearchParams({
    url: trackUrl,
    auto_play: "false",
    hide_related: "true",
    show_comments: "false",
    show_user: "false",
    show_reposts: "false",
    buying: "false",
    download: "false",
    sharing: "false",
    visual: "false"
  });
  return `https://w.soundcloud.com/player/?${params.toString()}`;
}
