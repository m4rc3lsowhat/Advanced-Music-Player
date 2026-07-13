import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

register("./_tsresolve.mjs", import.meta.url);

const modPath = fileURLToPath(new URL("../src/lib/mixes/composition.ts", import.meta.url));
const {
  trackKey,
  dedupeTracks,
  primaryArtist,
  excludeArtist,
  limitPerArtist,
  topArtistClusters,
  seededShuffle,
  interleave,
  buildDailyMixes,
  buildScoredStation
} = await import(pathToFileURL(modPath).href);

let failures = 0;
const assert = (condition, message) => {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${message}`);
  }
};

let idCounter = 0;
const track = (provider, artist, title) => {
  idCounter += 1;
  return {
    id: `${provider}-${idCounter}`,
    provider,
    providerTrackId: `${idCounter}`,
    title: title ?? `${artist} Song ${idCounter}`,
    creators: [artist],
    durationMs: 200000,
    explicit: false,
    playable: true
  };
};

// --- dedupeTracks ---
const a = track("spotify", "Carti", "Magnolia");
const dupA = { ...a };
assert(dedupeTracks([a, dupA, a]).length === 1, "dedupeTracks collapses same provider+id");
assert(trackKey(a) === "spotify:" + a.providerTrackId, "trackKey is provider:providerTrackId");

// --- primaryArtist ---
assert(primaryArtist(track("spotify", "Fred again..")) === "Fred again..", "primaryArtist returns first creator");
assert(
  primaryArtist({ ...a, creators: [] }) === "Unknown",
  "primaryArtist falls back to Unknown with no creators"
);

// --- excludeArtist (keep discovery to OTHER artists) ---
const mixedArtists = [
  track("soundcloud", "Kankan", "Kankan song"),
  track("soundcloud", "KANKAN", "Kankan caps"),
  track("soundcloud", "Summrs", "Summrs song"),
  track("soundcloud", "Autumn", "Autumn song")
];
const withoutAnchor = excludeArtist(mixedArtists, "kankan");
assert(withoutAnchor.length === 2, "excludeArtist drops all case-variants of the anchor artist");
assert(
  withoutAnchor.every((t) => primaryArtist(t) !== "Kankan" && primaryArtist(t) !== "KANKAN"),
  "excludeArtist leaves only other artists"
);

// --- limitPerArtist (diversify the similar pool) ---
const lopsided = [
  track("soundcloud", "Summrs"), track("soundcloud", "Summrs"), track("soundcloud", "Summrs"),
  track("soundcloud", "Autumn"), track("soundcloud", "Autumn")
];
const capped = limitPerArtist(lopsided, 2);
assert(capped.length === 4, "limitPerArtist caps each artist's contribution");
assert(capped.filter((t) => primaryArtist(t) === "Summrs").length === 2, "no artist exceeds the per-artist cap");

// --- topArtistClusters ---
const library = [
  track("spotify", "Carti"),
  track("spotify", "Carti"),
  track("soundcloud", "Carti"),
  track("spotify", "Fred again.."),
  track("soundcloud", "Fred again.."),
  track("spotify", "OneOff")
];
const clusters = topArtistClusters(library, 5, 2);
assert(clusters[0].artist === "Carti", "top cluster is the most-frequent artist");
assert(clusters[0].tracks.length === 3, "Carti cluster has 3 tracks across providers");
assert(
  clusters.every((c) => c.artist !== "OneOff"),
  "clusters below minTracks (2) are excluded"
);

// --- seededShuffle determinism ---
const base = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const s1 = seededShuffle(base, "2026-06-08:Carti");
const s2 = seededShuffle(base, "2026-06-08:Carti");
assert(JSON.stringify(s1) === JSON.stringify(s2), "seededShuffle is deterministic for same seed");
assert(JSON.stringify(base) === JSON.stringify([1,2,3,4,5,6,7,8,9,10]), "seededShuffle does not mutate input");
const s3 = seededShuffle(base, "different-seed");
assert(JSON.stringify(s1) !== JSON.stringify(s3), "different seeds generally produce different orders");

// --- interleave ---
const woven = interleave(["a", "a", "a"], ["b", "b"], 1, 1, 10);
assert(JSON.stringify(woven) === JSON.stringify(["a", "b", "a", "b", "a"]), "interleave 1:1 alternates and drains both");
assert(interleave(["a","a","a","a"], [], 1, 1, 2).length === 2, "interleave respects the limit");

// --- buildDailyMixes ---
const bigLibrary = [];
for (let i = 0; i < 6; i += 1) bigLibrary.push(track("spotify", "Carti"));
for (let i = 0; i < 5; i += 1) bigLibrary.push(track("soundcloud", "Fred again.."));
const mixesDay1 = buildDailyMixes(bigLibrary, { date: "2026-06-08", count: 4, size: 6 });
assert(mixesDay1.length >= 1, "buildDailyMixes produces at least one mix from clustered library");
assert(mixesDay1[0].kind === "daily" && mixesDay1[0].title === "Daily Mix 1", "first mix is labelled Daily Mix 1");
assert(mixesDay1[0].anchor === "Carti", "first mix anchored on the largest cluster");
const mixesAgain = buildDailyMixes(bigLibrary, { date: "2026-06-08", count: 4, size: 6 });
assert(
  JSON.stringify(mixesDay1[0].tracks.map(trackKey)) === JSON.stringify(mixesAgain[0].tracks.map(trackKey)),
  "same date yields identical Daily Mix ordering (stable for the day)"
);
const mixesDay2 = buildDailyMixes(bigLibrary, { date: "2026-06-09", count: 4, size: 6 });
assert(
  JSON.stringify(mixesDay1[0].tracks.map(trackKey)) !== JSON.stringify(mixesDay2[0].tracks.map(trackKey)),
  "a new date reshuffles the Daily Mix"
);

// daily mix with discovered tracks weaves them in
const discovered = new Map([["Carti", [track("soundcloud", "Carti", "Discovered A"), track("spotify", "Carti", "Discovered B")]]]);
const mixesDisc = buildDailyMixes(bigLibrary, { date: "2026-06-08", count: 4, size: 8, discovered });
const cartiMix = mixesDisc.find((m) => m.anchor === "Carti");
assert(
  cartiMix.tracks.some((t) => t.title === "Discovered A" || t.title === "Discovered B"),
  "discovered tracks are woven into the anchored daily mix"
);

// --- buildStation ---
const seed = track("spotify", "Chubina", "Slow");
const stationPool = [
  track("spotify", "X"), track("spotify", "Y"), track("spotify", "Z"),
  track("soundcloud", "P"), track("soundcloud", "Q"), track("soundcloud", "R")
];
const stationScores = new Map(
  stationPool.map((candidate, index) => [trackKey(candidate), 100 - index])
);
const station = buildScoredStation(seed, [...stationPool, seed], stationScores, {
  size: 5,
  seedKey: trackKey(seed)
});
assert(station.tracks[0].title === "Slow", "station starts on the seed track");
assert(station.tracks.length === 5, "station respects size cap");
assert(
  station.tracks.filter((t) => trackKey(t) === trackKey(seed)).length === 1,
  "seed is not duplicated in the station"
);
assert(
  station.tracks.some((t) => t.provider === "spotify") && station.tracks.some((t) => t.provider === "soundcloud"),
  "station blends both providers"
);
assert(station.kind === "station", "station kind is set");

const blocked = track("soundcloud", "Artist Foreign", "Foreign Script");
const gatedStation = buildScoredStation(
  seed,
  [stationPool[0], blocked],
  new Map([
    [trackKey(stationPool[0]), 2],
    [trackKey(blocked), -12]
  ]),
  { size: 5 }
);
assert(
  !gatedStation.tracks.some((candidate) => trackKey(candidate) === trackKey(blocked)),
  "station assembly excludes negatively scored candidates"
);

if (failures === 0) {
  console.log("PASS: mix composition tests completed.");
} else {
  console.error(`${failures} mix composition test(s) failed.`);
  process.exit(1);
}
