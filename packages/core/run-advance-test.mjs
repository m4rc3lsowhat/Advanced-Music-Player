// QueueEngine contract tests. Node 24 strips TS types on import, but the core files use
// extensionless relative imports, so we copy them into a temp dir with `.ts` extensions added.
//
// Run: node packages/core/run-advance-test.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "src");
const tmpDir = join(here, ".advtest");

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
for (const f of ["models.ts", "playback.ts", "queue.ts"]) {
  const code = readFileSync(join(srcDir, f), "utf8")
    .replace(/from "\.\/models"/g, 'from "./models.ts"')
    .replace(/from "\.\/playback"/g, 'from "./playback.ts"');
  writeFileSync(join(tmpDir, f), code);
}

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures += 1;
    console.error(`   FAIL: ${msg}`);
  }
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeTrack(index, provider = index % 2 === 0 ? "spotify" : "soundcloud") {
  return {
    id: `${provider}:track-${index}`,
    provider,
    providerTrackId: `track-${index}`,
    title: `Track ${index}`,
    creators: ["tester"],
    durationMs: 1000,
    explicit: false,
    playable: true
  };
}

class MockAdapter {
  constructor(provider) {
    this.provider = provider;
    this.listener = null;
    this.current = null;
    this.playCount = 0;
    this.volumeCalls = [];
    this.failTrackIds = new Set();
    this.playDelays = [];
  }

  subscribe(listener) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  async play(track) {
    const delay = this.playDelays.shift();
    if (delay) {
      await delay;
    }
    if (this.failTrackIds.has(track.providerTrackId) || this.failTrackIds.has(track.id)) {
      throw new Error(`${track.title} failed`);
    }
    this.current = track;
    this.playCount += 1;
    this.emit("state", "playing", track);
  }

  async pause() {
    this.emit("state", "paused", this.current);
  }

  async seek() {}

  async setVolume(volume) {
    this.volumeCalls.push(volume);
  }

  async preload() {}

  async teardown() {
    this.current = null;
  }

  async search() {
    return [];
  }

  async getCollections() {
    return [];
  }

  async getCollectionTracks() {
    return { id: "mock", provider: this.provider, kind: "playlist", title: "Mock", items: [] };
  }

  async getLibrary() {
    return { id: "mock", provider: this.provider, kind: "playlist", title: "Mock", items: [] };
  }

  emit(type, status, track = this.current) {
    this.listener?.({
      type,
      snapshot: {
        provider: this.provider,
        status,
        positionMs: 0,
        durationMs: track?.durationMs ?? 1000,
        volume: 1,
        activeTrackId: track?.providerTrackId
      }
    });
  }

  finish(track = this.current) {
    this.emit("ended", "idle", track);
  }
}

try {
  const { QueueEngine } = await import(pathToFileURL(join(tmpDir, "queue.ts")).href);

  async function testLongMixedAutoAdvance() {
    const spotify = new MockAdapter("spotify");
    const soundcloud = new MockAdapter("soundcloud");
    const adapters = { spotify, soundcloud };
    const engine = new QueueEngine([spotify, soundcloud]);
    const tracks = Array.from({ length: 60 }, (_, i) => makeTrack(i));

    engine.setQueue(tracks, 0);
    await engine.playAt(0);
    await tick();

    let handoffs = 0;
    let prevProvider = engine.getState().activeProvider;
    let maxReached = 0;

    for (let i = 0; i < tracks.length - 1; i += 1) {
      const active = engine.getState().activeProvider;
      adapters[active].finish();
      await tick();
      const idx = engine.getState().currentIndex;
      if (idx === i + 1) {
        maxReached = idx;
      }
      assert(idx === i + 1, `after finishing track ${i}, expected index ${i + 1}, got ${idx}`);
      const nextProvider = engine.getState().activeProvider;
      if (nextProvider !== prevProvider) {
        handoffs += 1;
      }
      prevProvider = nextProvider;
      if (idx !== i + 1) {
        break;
      }
    }

    const lastActive = engine.getState().activeProvider;
    adapters[lastActive].finish();
    await tick();
    const endState = engine.getState();
    assert(endState.currentIndex === tracks.length - 1, "last track index should remain selected");
    assert(endState.status === "paused", `after last track status should be paused, got ${endState.status}`);
    assert(maxReached === tracks.length - 1, `mixed queue reached ${maxReached}/${tracks.length - 1}`);
    assert(handoffs === tracks.length - 1, `expected ${tracks.length - 1} handoffs, got ${handoffs}`);
  }

  async function testStaleSameProviderEventsIgnored() {
    const spotify = new MockAdapter("spotify");
    const engine = new QueueEngine([spotify]);
    const first = makeTrack(0, "spotify");
    const second = makeTrack(1, "spotify");

    engine.setQueue([first, second], 0);
    await engine.playAt(0);
    await engine.playAt(1);
    spotify.finish(first);
    await tick();

    assert(engine.getState().currentIndex === 1, "stale ended event must not advance current track");
    assert(engine.getState().status === "playing", "stale ended event must not pause current track");
  }

  async function testOverlappingSameProviderPlayKeepsNewest() {
    let releaseFirst;
    const firstDelay = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const spotify = new MockAdapter("spotify");
    spotify.playDelays.push(firstDelay);
    const engine = new QueueEngine([spotify]);
    const first = makeTrack(0, "spotify");
    const second = makeTrack(1, "spotify");

    engine.setQueue([first, second], 0);
    const firstPlay = engine.playAt(0);
    await tick();
    await engine.playAt(1);
    releaseFirst();
    await firstPlay;
    await tick();

    assert(engine.getState().currentIndex === 1, "overlapping playAt should leave newest index active");
    assert(engine.getState().queue[engine.getState().currentIndex]?.id === second.id, "newest track should remain active");
    assert(spotify.current?.id === second.id, "same-provider overlap should leave the adapter on the newest track");
  }

  async function testPauseCancelsInflightPlay() {
    let releasePlay;
    const playDelay = new Promise((resolve) => {
      releasePlay = resolve;
    });
    const spotify = new MockAdapter("spotify");
    spotify.playDelays.push(playDelay);
    const engine = new QueueEngine([spotify]);
    const track = makeTrack(0, "spotify");

    engine.setQueue([track], 0);
    const pendingPlay = engine.playAt(0);
    await tick();
    await engine.pause();
    releasePlay();
    await pendingPlay;
    await tick();

    assert(engine.getState().status === "paused", "pause should win over an in-flight play");
  }

  async function testRemovingInflightTailCannotResumeRemovedTrack() {
    let releasePlay;
    const playDelay = new Promise((resolve) => {
      releasePlay = resolve;
    });
    const spotify = new MockAdapter("spotify");
    const soundcloud = new MockAdapter("soundcloud");
    spotify.playDelays.push(playDelay);
    const engine = new QueueEngine([spotify, soundcloud]);
    const first = makeTrack(0, "soundcloud");
    const tail = makeTrack(1, "spotify");

    engine.setQueue([first, tail], 1);
    const pendingPlay = engine.playAt(1);
    await tick();
    engine.removeAt(1);
    releasePlay();
    await pendingPlay;
    await tick();

    assert(engine.getState().queue.length === 1, "removing the tail should keep only the prior track");
    assert(engine.getState().status === "paused", "removed in-flight tail should leave the queue paused");
    assert(engine.getState().activeProvider === "soundcloud", "removing the tail should select the remaining provider");
    assert(spotify.current?.id !== tail.id, "removed in-flight tail must not resume after its play resolves");
  }

  async function testManualNextAtTailIsNoOp() {
    const spotify = new MockAdapter("spotify");
    const engine = new QueueEngine([spotify]);
    const track = makeTrack(0, "spotify");

    engine.setQueue([track], 0);
    await engine.playAt(0);
    await engine.next();

    assert(engine.getState().status === "playing", "manual next at the tail should not fake a pause");
    assert(spotify.current?.id === track.id, "manual next at the tail should keep current audio");
  }

  async function testFailedTrackSkipsForward() {
    const spotify = new MockAdapter("spotify");
    spotify.failTrackIds.add("track-0");
    const engine = new QueueEngine([spotify]);
    const first = makeTrack(0, "spotify");
    const second = makeTrack(1, "spotify");

    engine.setQueue([first, second], 0);
    await engine.playAt(0);

    assert(engine.getState().currentIndex === 1, "failed track should skip to next track");
    assert(engine.getState().status === "playing", "queue should keep playing after a failed track when next exists");
  }

  async function testQueueCanStartAtMiddleIndex() {
    const spotify = new MockAdapter("spotify");
    const engine = new QueueEngine([spotify]);
    const tracks = Array.from({ length: 5 }, (_, i) => makeTrack(i, "spotify"));

    engine.setQueue(tracks, 2);
    await engine.playAt(2);

    assert(engine.getState().currentIndex === 2, "queue should start at requested middle index");
    assert(engine.getState().canGoPrevious === true, "middle queue start should allow previous");
    assert(engine.getState().canGoNext === true, "middle queue start should allow next");

    spotify.finish();
    await tick();

    assert(engine.getState().currentIndex === 3, "ended middle item should advance to following item");
    assert(
      engine.getState().queue.map((track) => track.id).join(",") === tracks.map((track) => track.id).join(","),
      "starting at a middle index should preserve the full queue order"
    );
  }

  function testReshuffleUpcomingKeepsCurrentAndHistory() {
    const spotify = new MockAdapter("spotify");
    const engine = new QueueEngine([spotify]);
    const tracks = Array.from({ length: 8 }, (_, i) => makeTrack(i, "spotify"));

    engine.setQueue(tracks, 3);
    engine.reshuffleUpcoming();

    const state = engine.getState();
    const historyAndCurrent = state.queue.slice(0, 4).map((track) => track.id).join(",");
    const expectedHistoryAndCurrent = tracks.slice(0, 4).map((track) => track.id).join(",");
    const shuffledTailIds = state.queue
      .slice(4)
      .map((track) => track.id)
      .sort()
      .join(",");
    const expectedTailIds = tracks
      .slice(4)
      .map((track) => track.id)
      .sort()
      .join(",");

    assert(state.currentIndex === 3, "reshuffle should keep the current index");
    assert(historyAndCurrent === expectedHistoryAndCurrent, "reshuffle should preserve history and current item");
    assert(shuffledTailIds === expectedTailIds, "reshuffle should keep the same upcoming tracks");
  }

  async function testEffectiveVolumeReappliesOnHandoff() {
    const spotify = new MockAdapter("spotify");
    const soundcloud = new MockAdapter("soundcloud");
    const engine = new QueueEngine([spotify, soundcloud]);

    await engine.setVolume(0.8);
    await engine.setProviderVolume("spotify", 1);
    await engine.setProviderVolume("soundcloud", 0.25);
    engine.setQueue([makeTrack(0, "spotify"), makeTrack(1, "soundcloud")], 0);
    await engine.playAt(0);
    spotify.finish();
    await tick();

    assert(spotify.volumeCalls.includes(0.8), "Spotify should receive master volume times provider trim");
    assert(soundcloud.volumeCalls.includes(0.2), "SoundCloud should receive provider-trimmed volume on handoff");

    await engine.setProviderVolume("soundcloud", 0.5);
    assert(
      soundcloud.volumeCalls.includes(0.4),
      "active provider should receive updated effective volume when its trim changes"
    );
  }

  await testLongMixedAutoAdvance();
  await testStaleSameProviderEventsIgnored();
  await testOverlappingSameProviderPlayKeepsNewest();
  await testPauseCancelsInflightPlay();
  await testRemovingInflightTailCannotResumeRemovedTrack();
  await testManualNextAtTailIsNoOp();
  await testFailedTrackSkipsForward();
  await testQueueCanStartAtMiddleIndex();
  testReshuffleUpcomingKeepsCurrentAndHistory();
  await testEffectiveVolumeReappliesOnHandoff();

  if (failures === 0) {
    console.log("PASS: QueueEngine playback contract tests completed.");
  } else {
    console.error(`FAIL: ${failures} QueueEngine assertion(s) failed.`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("ERROR running QueueEngine contract tests:", err);
  process.exitCode = 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
