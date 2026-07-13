/**
 * AudioReactor — makes the song-tinted gradient actually move with the song.
 *
 * It runs a requestAnimationFrame loop over an AnalyserNode, does onset (beat) detection on the
 * bass band via spectral flux against an adaptive threshold, smooths overall loudness with
 * fast-attack/slow-release envelopes, and writes ONLY two CSS custom properties — `--beat` and
 * `--energy` — onto :root. A single dedicated, GPU-composited overlay layer consumes them via
 * `opacity`/`transform` (compositor-only, no layout/paint). It deliberately does NOT touch the
 * app-wide accent vars (`--acid`/`--song-rgb`) per frame: those drive every border, label and
 * shadow in the UI, so rewriting them each frame restyled and repainted the whole document and
 * made the app lag. The artwork hue is set once per track by SongColor; the reactor only adds the
 * motion on top of it.
 *
 * Source: Windows system-audio loopback (`getDisplayMedia` + electron's setDisplayMediaRequestHandler
 * granting `audio: 'loopback'`) — it analyses AMP's actual OUTPUT, so it works uniformly for every
 * provider (Spotify's DRM SDK exposes no audio graph; SoundCloud plays via a media element or a
 * cross-origin widget). We deliberately do NOT tap the SoundCloud media element through Web Audio:
 * `createMediaElementSource` routes playback through the graph and silenced/locked certain streams.
 * If loopback isn't available the reactor never fires and the UI keeps the static artwork tint.
 */

const FLUX_WINDOW = 27; // ~0.8 s at the reactor's 33 fps sampling rate
const BEAT_DECAY_TAU_MS = 170; // beat pulse half-life feel: punchy but not strobing
const BEAT_REFRACTORY_MS = 160; // ignore re-triggers faster than ~375 BPM
const ENERGY_ATTACK = 0.35;
const ENERGY_RELEASE = 0.055;
// Sample/emit at ~33 fps, not every frame: beat motion still reads as smooth, but we halve the
// per-frame work (analyser read + CSS write + composite) so the main thread stays responsive.
const FRAME_INTERVAL_MS = 30;

export class AudioReactor {
  private loopbackCtx: AudioContext | null = null;
  private loopbackAnalyser: AnalyserNode | null = null;
  private loopbackStream: MediaStream | null = null;
  private loopbackFailed = false;
  private acquiringLoopback: Promise<boolean> | null = null;
  private acquisitionGeneration = 0;

  private freq: Uint8Array<ArrayBuffer> | null = null;
  private raf = 0;
  private running = false;
  /** The beat overlay element we write CSS vars to. Targeting THIS element (not :root) keeps the
   *  per-frame style invalidation to one node — writing --beat/--energy on documentElement made
   *  Chromium re-evaluate custom-property inheritance across the whole tree, which dropped clicks. */
  private target: HTMLElement | null = null;

  private fluxHistory: number[] = [];
  private prevBass = -1;
  private beatEnv = 0;
  private energyEnv = 0;
  private lastBeatAt = 0;
  private lastFrameAt = 0;
  private lastEmitAt = 0;

  /** Resolve (and cache) the overlay element we write --beat/--energy onto. */
  private resolveTarget(): HTMLElement | null {
    if (!this.target || !this.target.isConnected) {
      this.target = document.getElementById("amp-beat-layer");
    }
    return this.target;
  }

  /**
   * Kick off loopback acquisition from a real user gesture (Settings toggle, play button) so the
   * getDisplayMedia call carries transient activation where Chromium demands it.
   */
  primeLoopback(): void {
    void this.ensureLoopback();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastFrameAt = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running && this.beatEnv === 0 && this.energyEnv === 0) {
      return;
    }
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.beatEnv = 0;
    this.energyEnv = 0;
    this.prevBass = -1;
    this.fluxHistory = [];
    // Settle the overlay to invisible (opacity follows these). The artwork accent vars are owned by
    // SongColor and are left untouched, so the UI keeps its song tint without a per-frame rewrite.
    const targetEl = this.resolveTarget();
    if (targetEl) {
      targetEl.style.setProperty("--beat", "0");
      targetEl.style.setProperty("--energy", "0");
    }
    if (this.loopbackCtx?.state === "running") {
      void this.loopbackCtx.suspend().catch(() => undefined);
    }
  }

  /** Fully release the system-audio capture (leaving audio mode). Allows a fresh retry later. */
  releaseLoopback(): void {
    this.acquisitionGeneration += 1;
    const stream = this.loopbackStream;
    this.loopbackStream = null;
    this.loopbackAnalyser = null;
    stream?.getTracks().forEach((track) => track.stop());
    const context = this.loopbackCtx;
    this.loopbackCtx = null;
    void context?.close().catch(() => undefined);
    this.loopbackFailed = false;
  }

  private async ensureLoopback(): Promise<boolean> {
    if (this.loopbackAnalyser) {
      return true;
    }
    if (this.loopbackFailed) {
      return false;
    }
    if (this.acquiringLoopback) {
      return this.acquiringLoopback;
    }
    const generation = this.acquisitionGeneration;
    this.acquiringLoopback = (async () => {
      try {
        // getDisplayMedia REQUIRES a video request, and electron's loopback grant binds the audio to
        // a screen-capture source. We only want the audio — so request the slowest, tiniest possible
        // video and stop that track immediately. Crucially, if the desktop-capture session lingers
        // after the track stop (a known Electron behaviour with audio:'loopback'), capping it at
        // ~1 fps keeps it negligible instead of a full-rate screen capture that saturates the GPU /
        // main process and freezes the whole UI (the "dozens of clicks to switch tabs" lag).
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          // Frame rate is the lever that matters — cap the screen capture at ~1 fps so any lingering
          // session is trivial. (Width/height only downscale post-capture, and over-tiny values risk
          // the request being rejected, which would kill loopback entirely — so we don't set them.)
          video: { frameRate: { ideal: 1, max: 3 } }
        });
        if (generation !== this.acquisitionGeneration) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        stream.getVideoTracks().forEach((track) => track.stop());
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach((track) => track.stop());
          this.loopbackFailed = true;
          return false;
        }
        // latencyHint "playback" lets Chromium use larger audio buffers (less frequent processing
        // = less CPU) — we only need ~30 Hz of spectrum data, not low-latency monitoring.
        const ctx = new AudioContext({ latencyHint: "playback" });
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0; // the reactor applies its own envelopes
        source.connect(analyser); // analysis only — never to destination (no echo)
        this.loopbackStream = stream;
        this.loopbackCtx = ctx;
        this.loopbackAnalyser = analyser;
        stream.getAudioTracks()[0]?.addEventListener(
          "ended",
          () => {
            if (this.loopbackStream === stream) {
              this.releaseLoopback();
            }
          },
          { once: true }
        );
        return true;
      } catch {
        if (generation === this.acquisitionGeneration) {
          this.loopbackFailed = true;
        }
        return false;
      } finally {
        this.acquiringLoopback = null;
      }
    })();
    return this.acquiringLoopback;
  }

  private tick = (now: number) => {
    if (!this.running) {
      return;
    }
    this.raf = requestAnimationFrame(this.tick);

    // Throttle the heavy work (analyser read + envelopes + CSS write) to ~33 fps. rAF still drives
    // it so it pauses with the tab, but we skip frames in between to keep the main thread free.
    if (now - this.lastEmitAt < FRAME_INTERVAL_MS) {
      return;
    }

    if (!this.loopbackAnalyser) {
      return;
    }
    if (this.loopbackCtx?.state === "suspended") {
      void this.loopbackCtx.resume().catch(() => undefined);
    }
    const analyser = this.loopbackAnalyser;

    const bins = analyser.frequencyBinCount;
    if (!this.freq || this.freq.length !== bins) {
      this.freq = new Uint8Array(new ArrayBuffer(bins));
      this.prevBass = -1;
    }
    analyser.getByteFrequencyData(this.freq);

    const dt = Math.min(100, Math.max(1, now - this.lastFrameAt));
    this.lastFrameAt = now;

    // Band energies. fftSize 1024 at 44.1/48 kHz ≈ 43–47 Hz per bin: bins 1–4 cover the kick
    // range (~45–190 Hz); the overall level ignores the hiss above ~8 kHz.
    const binHz = (this.loopbackCtx?.sampleRate ?? 48_000) / analyser.fftSize;
    const bassStart = Math.max(1, Math.ceil(45 / binHz));
    const bassEnd = Math.min(bins - 1, Math.floor(190 / binHz));
    let bass = 0;
    for (let i = bassStart; i <= bassEnd; i += 1) {
      bass += this.freq[i];
    }
    bass /= Math.max(1, bassEnd - bassStart + 1) * 255;

    const upper = Math.min(bins, Math.max(2, Math.floor(8_000 / binHz)));
    let total = 0;
    for (let i = 1; i < upper; i += 1) {
      total += this.freq[i];
    }
    total /= (upper - 1) * 255;

    // Loudness envelope: jumps up fast, falls slowly — "breathing", not flicker.
    const target = Math.min(1, total * 2.4);
    const k = target > this.energyEnv ? ENERGY_ATTACK : ENERGY_RELEASE;
    this.energyEnv += (target - this.energyEnv) * k;

    // Beat onset: positive bass flux above the song's own recent mean + deviation.
    if (this.prevBass >= 0) {
      const flux = Math.max(0, bass - this.prevBass);
      this.fluxHistory.push(flux);
      if (this.fluxHistory.length > FLUX_WINDOW) {
        this.fluxHistory.shift();
      }
      const n = this.fluxHistory.length;
      const mean = this.fluxHistory.reduce((acc, value) => acc + value, 0) / n;
      const variance = this.fluxHistory.reduce((acc, value) => acc + (value - mean) ** 2, 0) / n;
      const threshold = mean + 1.6 * Math.sqrt(variance) + 0.006;
      if (n >= 12 && flux > threshold && bass > 0.16 && now - this.lastBeatAt > BEAT_REFRACTORY_MS) {
        this.beatEnv = 1;
        this.lastBeatAt = now;
      }
    }
    this.prevBass = bass;

    this.beatEnv *= Math.exp(-dt / BEAT_DECAY_TAU_MS);
    if (this.beatEnv < 0.002) {
      this.beatEnv = 0;
    }

    this.lastEmitAt = now;
    // The ONLY per-frame writes: two scalars on the overlay ELEMENT itself (never :root), so the
    // style invalidation is confined to that single node — no document-wide custom-property recalc.
    const targetEl = this.resolveTarget();
    if (targetEl) {
      targetEl.style.setProperty("--beat", this.beatEnv.toFixed(3));
      targetEl.style.setProperty("--energy", this.energyEnv.toFixed(3));
    }
  };
}

export const audioReactor = new AudioReactor();
