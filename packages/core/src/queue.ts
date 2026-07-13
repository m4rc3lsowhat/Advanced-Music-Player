import {
  clampVolume,
  createEmptyPlaybackState,
  withPlaybackFlags,
  type PlaybackState,
  type Provider,
  type ProviderVolumeMap,
  type UnifiedTrack
} from "./models";
import type { PlaybackAdapter, PlaybackAdapterEvent } from "./playback";

export type QueueEngineListener = (state: PlaybackState) => void;

function isTrackEventForCurrentTrack(
  activeTrackId: string | undefined,
  currentTrack: UnifiedTrack | undefined
): boolean {
  if (!currentTrack) {
    return false;
  }
  if (!activeTrackId) {
    return true;
  }

  return activeTrackId === currentTrack.providerTrackId || activeTrackId === currentTrack.id;
}

export class QueueEngine {
  private adapters = new Map<Provider, PlaybackAdapter>();
  private state: PlaybackState = createEmptyPlaybackState();
  private listeners = new Set<QueueEngineListener>();
  private unsubscribers = new Map<Provider, () => void>();
  /**
   * The provider whose adapter is actually producing audio right now. Tracked separately from
   * state.activeProvider because setQueue() updates activeProvider to the *queued* track before
   * playAt() runs the cross-provider handoff — so we cannot rely on it to know what to pause.
   */
  private playingProvider?: Provider;
  /**
   * Bumped on every playAt() call. A transition that finds the generation has moved on (a newer
   * play started while it was tearing down / starting) bails out or stops itself, so two
   * overlapping calls can never leave both providers sounding at once — without one ever blocking
   * behind the other (which would stall, e.g., a SoundCloud play behind a slow Spotify start).
   */
  private playGeneration = 0;
  private transportIntent: "play" | "pause" | "stop" = "stop";

  constructor(adapters: PlaybackAdapter[] = []) {
    adapters.forEach((adapter) => this.registerAdapter(adapter));
  }

  registerAdapter(adapter: PlaybackAdapter): void {
    this.adapters.set(adapter.provider, adapter);
    const unsubscribe = adapter.subscribe((event) => this.handleAdapterEvent(event));
    this.unsubscribers.get(adapter.provider)?.();
    this.unsubscribers.set(adapter.provider, unsubscribe);
  }

  getState(): PlaybackState {
    return this.state;
  }

  subscribe(listener: QueueEngineListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setQueue(queue: UnifiedTrack[], startIndex = 0): void {
    const safeIndex = queue.length === 0 ? -1 : Math.max(0, Math.min(startIndex, queue.length - 1));
    this.patchState({
      queue: [...queue],
      currentIndex: safeIndex,
      activeProvider: queue[safeIndex]?.provider,
      durationMs: queue[safeIndex]?.durationMs ?? 0,
      positionMs: 0,
      lastError: undefined
    });
  }

  /** Insert a track to play right after the current one, without interrupting playback. */
  addNext(track: UnifiedTrack): void {
    if (this.state.queue.length === 0) {
      this.setQueue([track], 0);
      void this.playAt(0);
      return;
    }
    const insertAt = Math.min(this.state.currentIndex + 1, this.state.queue.length);
    const queue = [...this.state.queue];
    queue.splice(insertAt, 0, track);
    this.patchState({ queue });
  }

  /**
   * Replace the queue order in place WITHOUT touching the currently-playing track or its position —
   * used for drag-to-reorder. The caller passes the reordered queue and the new index of the track
   * that's playing now (so the engine keeps pointing at the same song).
   */
  reorderQueue(queue: UnifiedTrack[], currentIndex: number): void {
    const safeIndex = queue.length === 0 ? -1 : Math.max(0, Math.min(currentIndex, queue.length - 1));
    this.patchState({ queue: [...queue], currentIndex: safeIndex });
  }

  /**
   * Remove one track from the queue. Removing an upcoming or already-played track never interrupts
   * audio — only the index bookkeeping shifts. Removing the track that is playing right now hands
   * off to whatever slid into its slot (or pauses at the end of the queue).
   */
  removeAt(index: number): void {
    if (index < 0 || index >= this.state.queue.length) {
      return;
    }
    const queue = [...this.state.queue];
    queue.splice(index, 1);

    if (index === this.state.currentIndex) {
      if (queue.length === 0) {
        this.patchState({ queue, currentIndex: -1 });
        void this.playAt(-1);
        return;
      }
      if (index >= queue.length) {
        ++this.playGeneration;
        this.transportIntent = "pause";
        // Removed the playing TAIL track: nothing slid into its slot, so pause at the (new) end
        // instead of audibly restarting the previous song. positionMs must reset too — resume()
        // replays from state.positionMs, which still holds the removed track's position.
        this.playingProvider = undefined;
        void this.teardownOthers(undefined);
        this.patchState({
          queue,
          currentIndex: queue.length - 1,
          activeProvider: queue[queue.length - 1]?.provider,
          status: "paused",
          positionMs: 0,
          durationMs: queue[queue.length - 1]?.durationMs ?? 0
        });
        return;
      }
      this.patchState({ queue, currentIndex: index });
      void this.playAt(index);
      return;
    }

    const currentIndex = index < this.state.currentIndex ? this.state.currentIndex - 1 : this.state.currentIndex;
    this.patchState({ queue, currentIndex });
  }

  async playAt(index = this.state.currentIndex, options?: { positionMs?: number }): Promise<void> {
    const generation = ++this.playGeneration;
    this.transportIntent = "play";
    const superseded = () => generation !== this.playGeneration;

    const track = this.state.queue[index];
    if (!track) {
      this.transportIntent = "stop";
      await this.teardownOthers(undefined);
      this.playingProvider = undefined;
      this.patchState({ status: "idle", currentIndex: -1, activeProvider: undefined });
      return;
    }

    if (!track.playable) {
      this.patchState({
        currentIndex: index,
        status: "error",
        lastError: `${track.title} is unavailable and was skipped.`
      });
      if (index + 1 < this.state.queue.length) {
        await this.playAt(index + 1, options);
      } else {
        this.patchState({ status: "paused" });
      }
      return;
    }

    const adapter = this.adapters.get(track.provider);
    if (!adapter) {
      this.patchState({
        currentIndex: index,
        status: "error",
        lastError: `No playback adapter is registered for ${track.provider}.`
      });
      return;
    }

    const previousProvider = this.playingProvider;
    const providerChanged = previousProvider && previousProvider !== track.provider;

    this.patchState({
      currentIndex: index,
      activeProvider: track.provider,
      status: "loading",
      durationMs: track.durationMs,
      positionMs: 0,
      lastError: undefined,
      lastTransition: providerChanged
        ? {
            from: previousProvider,
            to: track.provider,
            at: new Date().toISOString()
          }
        : this.state.lastTransition
    });

    // Stop EVERY other provider before starting this one, so nothing else can still be sounding —
    // even if our notion of the previously-playing provider was stale.
    await this.teardownOthers(track.provider);
    if (superseded()) {
      return;
    }

    try {
      this.playingProvider = track.provider;
      await adapter.preload?.(track);
      if (superseded()) {
        return;
      }
      await adapter.play(track, {
        queue: this.state.queue,
        startAt: index,
        positionMs: options?.positionMs ?? 0
      });
      // Re-apply the current effective volume so provider trims survive every handoff.
      void adapter.setVolume(this.getEffectiveVolume(track.provider)).catch(() => undefined);
    } catch (error) {
      if (superseded()) {
        return;
      }
      // A track that fails to resolve/stream at runtime must not stall the queue — skip it and
      // roll on, mirroring the !playable branch above. Without this, one bad SoundCloud track
      // (e.g. an unresolvable stream) silently halts auto-advance for the rest of the mix.
      this.patchState({
        currentIndex: index,
        status: "error",
        lastError:
          error instanceof Error ? error.message : `${track.title} could not be played and was skipped.`
      });
      if (index + 1 < this.state.queue.length) {
        await this.playAt(index + 1);
      } else {
        this.patchState({ status: "paused" });
      }
      return;
    }

    // A newer play() started while this one was loading. Stop ours so they don't overlap — but
    // only if the newer one uses a DIFFERENT provider. If it reused this same adapter (e.g.
    // SoundCloud → SoundCloud), that adapter is already playing the new track, and tearing it down
    // would wrongly kill it.
    if (superseded()) {
      const currentTrack = this.state.queue[this.state.currentIndex];
      if (
        this.playingProvider === track.provider &&
        currentTrack?.provider === track.provider
      ) {
        const intent = this.transportIntent as "play" | "pause" | "stop";
        if (intent === "pause") {
          await adapter.pause();
        } else if (intent === "stop") {
          await adapter.teardown();
        } else if (
          this.state.status === "playing" &&
          currentTrack.providerTrackId !== track.providerTrackId
        ) {
          // A slower same-provider play resolved after the newer one and may have replaced the
          // adapter's output. Reassert the track the engine still considers current.
          await adapter.play(currentTrack, {
            queue: this.state.queue,
            startAt: this.state.currentIndex,
            positionMs: this.state.positionMs
          });
        }
      } else {
        await adapter.teardown();
      }
    }
  }

  /** Tear down every registered adapter except `keep`, so only one provider ever has audio. */
  private async teardownOthers(keep: Provider | undefined): Promise<void> {
    for (const [provider, adapter] of this.adapters) {
      if (provider !== keep) {
        try {
          await adapter.teardown();
        } catch {
          // Best-effort; one adapter's teardown must never block the handoff.
        }
      }
    }
  }

  async pause(): Promise<void> {
    const generation = ++this.playGeneration;
    this.transportIntent = "pause";
    const adapter = this.getActiveAdapter();
    if (!adapter) {
      return;
    }

    await adapter.pause();
    if (generation !== this.playGeneration) {
      await this.restoreLatestPlayIntent(adapter);
      return;
    }
    this.patchState({ status: "paused" });
  }

  async resume(): Promise<void> {
    if (this.state.currentIndex < 0) {
      return;
    }
    await this.playAt(this.state.currentIndex, {
      positionMs: this.state.positionMs
    });
  }

  async togglePlayback(): Promise<void> {
    if (this.state.status === "playing") {
      await this.pause();
      return;
    }
    await this.resume();
  }

  async next(): Promise<void> {
    if (!this.state.canGoNext) {
      return;
    }

    await this.playAt(this.state.currentIndex + 1);
  }

  async previous(): Promise<void> {
    if (!this.state.canGoPrevious) {
      return;
    }

    await this.playAt(this.state.currentIndex - 1);
  }

  async seek(positionMs: number): Promise<void> {
    const adapter = this.getActiveAdapter();
    if (!adapter) {
      return;
    }

    const generation = this.playGeneration;
    const trackId = this.state.queue[this.state.currentIndex]?.providerTrackId;
    this.patchState({ positionMs });
    await adapter.seek(positionMs);
    if (
      generation !== this.playGeneration ||
      this.state.queue[this.state.currentIndex]?.providerTrackId !== trackId
    ) {
      await this.restoreLatestPlayIntent(adapter);
    }
  }

  private async restoreLatestPlayIntent(adapter: PlaybackAdapter): Promise<void> {
    if (this.transportIntent !== "play" || this.state.status !== "playing") {
      return;
    }
    const currentTrack = this.state.queue[this.state.currentIndex];
    if (!currentTrack || currentTrack.provider !== adapter.provider) {
      return;
    }
    await adapter.play(currentTrack, {
      queue: this.state.queue,
      startAt: this.state.currentIndex,
      positionMs: this.state.positionMs
    });
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = clampVolume(volume);
    const adapter = this.getActiveAdapter();
    const activeProvider = this.state.activeProvider;
    this.patchState({ volume: clamped });
    if (adapter) {
      await adapter.setVolume(this.getEffectiveVolume(activeProvider));
    }
  }

  async setProviderVolume(provider: Provider, volume: number): Promise<void> {
    const clamped = clampVolume(volume);
    const providerVolumes: ProviderVolumeMap = {
      ...this.state.providerVolumes,
      [provider]: clamped
    };
    const adapter = this.state.activeProvider === provider ? this.adapters.get(provider) : undefined;
    this.patchState({ providerVolumes });
    if (adapter) {
      await adapter.setVolume(this.getEffectiveVolume(provider));
    }
  }

  /**
   * Randomize only the not-yet-played part of the queue (everything after the current track), so
   * turning shuffle on mid-playback reshuffles "up next" without interrupting the current song.
   */
  reshuffleUpcoming(): void {
    if (this.state.currentIndex < 0 || this.state.queue.length <= this.state.currentIndex + 2) {
      return;
    }
    const head = this.state.queue.slice(0, this.state.currentIndex + 1);
    const tail = this.state.queue.slice(this.state.currentIndex + 1);
    for (let i = tail.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [tail[i], tail[j]] = [tail[j], tail[i]];
    }
    this.patchState({ queue: [...head, ...tail] });
  }

  async teardown(): Promise<void> {
    ++this.playGeneration;
    this.transportIntent = "stop";
    const { volume, providerVolumes } = this.state;
    this.playingProvider = undefined;
    await Promise.all(Array.from(this.adapters.values()).map((adapter) => adapter.teardown()));
    this.patchState({
      ...createEmptyPlaybackState(),
      volume,
      providerVolumes
    });
  }

  private getActiveAdapter(): PlaybackAdapter | undefined {
    if (!this.state.activeProvider) {
      return undefined;
    }
    return this.adapters.get(this.state.activeProvider);
  }

  private handleAdapterEvent(event: PlaybackAdapterEvent): void {
    const currentTrack = this.state.queue[this.state.currentIndex];
    if (currentTrack && event.snapshot.provider !== currentTrack.provider) {
      return;
    }
    if (!isTrackEventForCurrentTrack(event.snapshot.activeTrackId, currentTrack)) {
      return;
    }

    if (event.type === "ended") {
      if (this.state.canGoNext) {
        void this.next();
      } else {
        this.patchState({
          status: "paused",
          positionMs: event.snapshot.durationMs || this.state.durationMs
        });
      }
      return;
    }

    if (event.type === "error") {
      // Surface the error but don't stall the queue — skip to the next track if there is one.
      // (A broken/DRM SoundCloud stream that errors mid-load otherwise silently halts the mix.)
      this.patchState({
        status: "error",
        lastError: event.snapshot.error ?? "Playback failed."
      });
      void this.next();
      return;
    }

    // Volume is owned by the engine (master plus provider trim), not by adapter state ticks.
    // Adapter snapshots report their effective output level, which would otherwise overwrite the
    // user's master/trim controls during routine position updates.
    this.patchState({
      status: event.snapshot.status,
      positionMs: event.snapshot.positionMs,
      durationMs: event.snapshot.durationMs || this.state.durationMs
    });
  }

  private getEffectiveVolume(provider: Provider | undefined): number {
    if (!provider) {
      return clampVolume(this.state.volume);
    }
    return clampVolume(this.state.volume * this.state.providerVolumes[provider]);
  }

  private patchState(partial: Partial<PlaybackState>): void {
    this.state = withPlaybackFlags({
      ...this.state,
      ...partial
    });

    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch {
        // Listener failures are UI/integration failures, not playback transport failures.
      }
    }
  }
}
