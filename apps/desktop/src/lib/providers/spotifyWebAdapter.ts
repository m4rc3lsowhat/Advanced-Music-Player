import type { UnifiedTrack } from "@amp/core";
import { clampVolume } from "@amp/core";
import {
  ensureSpotifyWebDevice,
  subscribeSpotifyPlayerState,
  getSpotifyPlayerState,
  setSpotifyPlayerVolume,
  setSpotifyPlayerPosition,
  pauseSpotifyPlayer,
  resumeSpotifyPlayer,
  type SpotifyPlaybackState
} from "../spotifyWebPlayer";
import { SpotifyBaseAdapter } from "./spotifyBaseAdapter";
import { isStartupWithoutProgress } from "./playbackGuards";

export const STALL_GRACE_MS = 3_500;
export const STALL_TIMEOUT_MS = 8_000;
// Poll the SDK's live position every second. The SDK's player_state_changed event only fires on
// discrete changes (play/pause/track-change), NOT as a position ticker — so progress/stall must be
// judged from getCurrentState(), or steady playback looks "stalled" and gets falsely skipped.
const PROGRESS_TICK_MS = 1_000;
const SERVER_ERROR_STARTUP_RETRY_DELAYS_MS = [900, 1_800, 3_000];

const SWITCH_HINT =
  "In-app Spotify playback failed. Reconnect Spotify, then try again.";
const STALL_MESSAGE =
  "In-app Spotify playback stalled. Try the track again in a moment.";
const STARTUP_STALL_MESSAGE =
  "Spotify could not start this track in-app. It was skipped.";

/**
 * Pure stall decision. A stall = the SDK reports playing, we are past the start grace, and the
 * reported position has not advanced for STALL_TIMEOUT_MS. Kept pure for testability.
 */
export function isStalled(input: {
  playing: boolean;
  msSinceStart: number;
  msSinceProgress: number;
  graceMs?: number;
  stallMs?: number;
}): boolean {
  const grace = input.graceMs ?? STALL_GRACE_MS;
  const stall = input.stallMs ?? STALL_TIMEOUT_MS;
  return input.playing && input.msSinceStart > grace && input.msSinceProgress > stall;
}

/**
 * Spotify playback in-app via the Web Playback SDK. Starts a track with the Web API targeting the
 * in-app SDK device, then drives state from the SDK's local state. No background Spotify app.
 */
export class SpotifyWebAdapter extends SpotifyBaseAdapter {
  private currentUri?: string;
  /**
   * The providerTrackId of the track we ASKED the SDK to play. Spotify "track relinking" can make
   * the SDK report a different `current_track.id` (the market-playable equivalent of the same song),
   * which would otherwise mismatch the queued track id and make the QueueEngine drop every playing/
   * position event — leaving the UI stuck on "loading"/paused while audio plays. We emit this
   * requested id instead so the engine's per-track event filter always matches.
   */
  private currentTrackId?: string;
  private playToken = 0;
  private isActive = false;
  private endedEmitted = false;
  private unsubscribeState?: () => void;
  private watchdogTimer?: number;
  private activeSince = 0;
  private lastPositionMs = 0;
  private lastProgressAt = 0;
  private lastDurationMs = 0;
  private hasSeenProgress = false;
  private userPaused = false;

  async play(track: UnifiedTrack, context: { positionMs?: number }): Promise<void> {
    const token = ++this.playToken;
    const superseded = () => token !== this.playToken;

    if (!this.isOAuthConnected()) {
      throw new Error("Connect your Spotify Premium account to play this track.");
    }
    const connection = this.options.getConnection();
    if (connection?.requiresPremium) {
      this.options.onConnectionIssue("Spotify playback requires a Premium account.", {
        requiresPremium: true
      });
      throw new Error("Spotify playback requires a Premium account.");
    }

    const uri = track.providerUri ?? `spotify:track:${track.providerTrackId}`;
    const startAt = Math.max(0, context.positionMs ?? 0);

    // Resume in place if this is the same track and we're already sounding.
    if (uri === this.currentUri && this.isActive) {
      this.userPaused = false;
      await resumeSpotifyPlayer();
      this.beginActiveState(track, this.lastPositionMs);
      this.startWatchdog();
      return;
    }

    let deviceId: string;
    try {
      deviceId = await ensureSpotifyWebDevice(() => this.getAccessToken());
    } catch (error) {
      this.failApi(error);
      throw error instanceof Error ? error : new Error(SWITCH_HINT);
    }
    if (superseded()) {
      return;
    }

    this.ensureStateSubscription();

    const playBody = JSON.stringify({ uris: [uri], position_ms: startAt });
    const playPath = `/me/player/play?device_id=${encodeURIComponent(deviceId)}`;

    let response = await this.request(playPath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: playBody
    });
    if (superseded()) {
      return;
    }

    // A freshly-`ready` SDK device often isn't registered with Spotify Connect yet, so the first
    // play can 404 (device unknown). Transfer playback to force registration, wait, then retry.
    // Do NOT do this for Spotify 5xx responses: the SDK may already have the command via its
    // dealer connection, and repeated transfer/play calls can pause or destabilize the SDK device.
    let attempts = 0;
    while (
      !response.ok &&
      response.status === 404 &&
      attempts < 3 &&
      !superseded()
    ) {
      attempts += 1;
      await this.request("/me/player", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_ids: [deviceId], play: false })
      });
      await this.delay(800);
      if (superseded()) {
        return;
      }
      response = await this.request(playPath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: playBody
      });
    }
    if (superseded()) {
      return;
    }

    if (!response.ok && response.status >= 500) {
      attempts = 0;
      while (attempts < 2 && !superseded()) {
        attempts += 1;
        await this.delay(700);
        if (await this.isSdkAlreadyOnTrack(uri)) {
          break;
        }
        response = await this.request(playPath, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: playBody
        });
        if (response.ok || response.status < 500) {
          break;
        }
      }
    }
    if (superseded()) {
      return;
    }

    // Real auth / entitlement failures are fatal and worth surfacing immediately.
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      const err = await this.createSpotifyApiError(response, "Spotify could not start in-app playback.");
      this.failApi(err);
      throw err;
    }

    // For 404 / 5xx (notably Spotify's intermittent 502 on /me/player/play and the SDK's own
    // /track-playback state calls), do NOT fail immediately: the SDK may still start the track via
    // its Connect dealer. Begin active state and let the watchdog declare failure only if the SDK
    // never actually produces playback.
    const needsServerErrorStartupRetry = !response.ok && response.status >= 500;
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Spotify API] /me/player/play returned ${response.status}; trusting the SDK's playback state instead of failing.`
      );
    }

    this.currentUri = uri;
    this.beginActiveState(track, startAt);
    this.startWatchdog();
    if (needsServerErrorStartupRetry) {
      void this.retryStartupAfterServerError(uri, playPath, playBody, superseded).catch(() => undefined);
    }
  }

  async pause(): Promise<void> {
    this.userPaused = true;
    this.emit({ type: "state", snapshot: { ...this.snapshot, status: "paused" } });
    await pauseSpotifyPlayer();
  }

  async seek(positionMs: number): Promise<void> {
    const next = Math.max(0, Math.floor(positionMs));
    await setSpotifyPlayerPosition(next);
    this.lastPositionMs = next;
    this.lastProgressAt = Date.now();
    this.hasSeenProgress = next > 0;
    this.emit({ type: "state", snapshot: { ...this.snapshot, positionMs: next } });
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = clampVolume(volume);
    this.snapshot.volume = clamped;
    await setSpotifyPlayerVolume(clamped);
    this.emit({ type: "state", snapshot: { ...this.snapshot, volume: clamped } });
  }

  async teardown(): Promise<void> {
    // Handoff teardown: stop sounding + watchdog but KEEP the SDK device so returning to Spotify
    // is instant. Full device destruction happens on a mode switch (the store calls
    // teardownSpotifyWebDevice) or on app teardown.
    this.playToken += 1;
    const wasSounding = this.isActive;
    this.isActive = false;
    this.stopWatchdog();
    if (wasSounding) {
      await pauseSpotifyPlayer();
    }
    this.currentUri = undefined;
    this.userPaused = false;
    this.emit({ type: "state", snapshot: { ...this.snapshot, status: "paused" } });
  }

  private ensureStateSubscription(): void {
    if (this.unsubscribeState) {
      return;
    }
    this.unsubscribeState = subscribeSpotifyPlayerState((state) => this.onSdkState(state));
  }

  private async isSdkAlreadyOnTrack(uri: string): Promise<boolean> {
    const state = await getSpotifyPlayerState();
    return state?.track_window.current_track?.uri === uri && !state.paused;
  }

  private async retryStartupAfterServerError(
    uri: string,
    playPath: string,
    playBody: string,
    superseded: () => boolean
  ): Promise<void> {
    for (const delayMs of SERVER_ERROR_STARTUP_RETRY_DELAYS_MS) {
      await this.delay(delayMs);
      if (superseded() || !this.isActive || this.currentUri !== uri) {
        return;
      }
      if (await this.isSdkAlreadyOnTrack(uri)) {
        return;
      }

      const response = await this.request(playPath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: playBody
      });
      if (response.ok || response.status < 500) {
        return;
      }
    }
  }

  // Event-driven fast path for immediate reactions (a real track end, an external pause). Position
  // progress and stall are judged by the polling loop below, since this event does NOT tick with
  // playback. The activeSince grace stops a paused-at-0 state during initial load from being read
  // as a track end.
  private onSdkState(state: SpotifyPlaybackState | null): void {
    if (!this.isActive || !state) {
      return;
    }
    const positionMs = state.position;
    const durationMs = state.duration || this.lastDurationMs;
    if (positionMs > this.lastPositionMs) {
      this.lastProgressAt = Date.now();
      this.hasSeenProgress = true;
    }
    this.lastPositionMs = positionMs;
    this.lastDurationMs = durationMs;

    if (!this.userPaused && this.isEndState(state)) {
      this.handleTrackEnded();
      return;
    }

    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        status: state.paused ? "paused" : "playing",
        positionMs,
        durationMs,
        activeTrackId: this.currentTrackId ?? state.track_window.current_track?.id ?? this.snapshot.activeTrackId
      }
    });
  }

  /** A single-track session reports paused at position 0 when it finishes (ignored during load). */
  private isEndState(state: SpotifyPlaybackState): boolean {
    return (
      state.paused &&
      state.position === 0 &&
      this.hasSeenProgress &&
      (state.duration || this.lastDurationMs) > 0 &&
      Date.now() - this.activeSince > STALL_GRACE_MS
    );
  }

  private beginActiveState(track: UnifiedTrack, positionMs: number): void {
    this.isActive = true;
    this.endedEmitted = false;
    this.userPaused = false;
    this.currentTrackId = track.providerTrackId;
    this.activeSince = Date.now();
    this.lastPositionMs = positionMs;
    this.lastProgressAt = Date.now();
    this.lastDurationMs = track.durationMs;
    this.hasSeenProgress = positionMs > 0;
    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        status: "loading",
        durationMs: track.durationMs,
        positionMs,
        activeTrackId: track.providerTrackId,
        error: undefined
      }
    });
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = window.setInterval(() => {
      void this.tickProgress();
    }, PROGRESS_TICK_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Poll the SDK's live position once per tick. Drives the UI position, end detection, and the
   * stall check — all from getCurrentState(), which (unlike player_state_changed) reflects real
   * playback progress second-to-second.
   */
  private async tickProgress(): Promise<void> {
    if (!this.isActive) {
      return;
    }
    const state = await getSpotifyPlayerState();
    if (!this.isActive) {
      return;
    }

    const now = Date.now();

    if (!state) {
      // No SDK state at all — only a failure if we never got going well past the grace + timeout.
      if (now - this.activeSince > STALL_GRACE_MS + STALL_TIMEOUT_MS) {
        this.failApi(new Error(STALL_MESSAGE));
      }
      return;
    }

    const positionMs = state.position;
    const durationMs = state.duration || this.lastDurationMs;
    const playing = !state.paused;

    if (positionMs > this.lastPositionMs) {
      this.lastProgressAt = now;
      this.hasSeenProgress = true;
    }
    this.lastPositionMs = positionMs;
    this.lastDurationMs = durationMs;

    if (!this.userPaused && this.isEndState(state)) {
      this.handleTrackEnded();
      return;
    }

    if (
      isStartupWithoutProgress({
        hasSeenProgress: this.hasSeenProgress,
        positionMs,
        msSinceStart: now - this.activeSince,
        startupGraceMs: STALL_GRACE_MS,
        stallMs: STALL_TIMEOUT_MS,
        userPaused: this.userPaused
      })
    ) {
      this.failTrack(new Error(STARTUP_STALL_MESSAGE));
      return;
    }

    if (
      isStalled({
        playing,
        msSinceStart: now - this.activeSince,
        msSinceProgress: now - this.lastProgressAt
      })
    ) {
      this.failApi(new Error(STALL_MESSAGE));
      return;
    }

    this.emit({
      type: "state",
      snapshot: {
        ...this.snapshot,
        status: playing ? "playing" : "paused",
        positionMs,
        durationMs,
        activeTrackId: this.currentTrackId ?? state.track_window.current_track?.id ?? this.snapshot.activeTrackId
      }
    });
  }

  private handleTrackEnded(): void {
    if (this.endedEmitted) {
      return;
    }
    this.endedEmitted = true;
    this.isActive = false;
    this.currentUri = undefined;
    this.stopWatchdog();
    this.emit({
      type: "ended",
      snapshot: {
        ...this.snapshot,
        status: "paused",
        positionMs: this.lastDurationMs,
        activeTrackId: this.snapshot.activeTrackId
      }
    });
  }

  private failApi(error: unknown): void {
    this.isActive = false;
    this.stopWatchdog();
    const message = error instanceof Error ? error.message : SWITCH_HINT;
    this.options.onConnectionIssue(message);
    this.emit({ type: "error", snapshot: { ...this.snapshot, status: "paused", error: message } });
  }

  private failTrack(error: Error): void {
    this.isActive = false;
    this.stopWatchdog();
    this.emit({
      type: "error",
      snapshot: { ...this.snapshot, status: "paused", error: error.message }
    });
  }
}
