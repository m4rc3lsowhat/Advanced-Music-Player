import { register } from "node:module";

register("./_tsresolve.mjs", import.meta.url);

const {
  detectScript,
  scoreTwinMatch,
  pickBestTwin,
  scoreStationCandidate,
  normalizeTitle,
  localDateKey,
  libraryMixFingerprint
} = await import("../src/lib/mixes/composition.ts");
const { normalizeGenre, normalizeGenres } = await import("../src/lib/genreNormalize.ts");
const { tempoBucketForBpm } = await import("../src/lib/trackFeatures.ts");

let failures = 0;
let passes = 0;
const assert = (condition, message) => {
  if (condition) {
    passes += 1;
  } else {
    failures += 1;
    console.error(`FAIL: ${message}`);
  }
};

let idCounter = 0;
const track = (provider, artist, title, extra = {}) => {
  idCounter += 1;
  return {
    id: `${provider}-${idCounter}`,
    provider,
    providerTrackId: `${idCounter}`,
    title: title ?? `${artist} Song ${idCounter}`,
    creators: [artist],
    durationMs: extra.durationMs ?? 200000,
    explicit: false,
    playable: true,
    ...extra
  };
};

// ---- detectScript ----
assert(detectScript("Blinding Lights The Weeknd") === "latin", "latin detected");
assert(detectScript("밤편지 아이유") === "hangul", "hangul detected");
assert(detectScript("Любимка Хабиб") === "cyrillic", "cyrillic detected");
assert(detectScript("夜に駆ける YOASOBI") === "cjk", "kana/cjk detected");
assert(detectScript("123 !!!") === "other", "no letters → other");

// ---- normalizeTitle ----
assert(normalizeTitle("Closer (feat. Halsey)") === "closer", "strips bracketed feature credit");
assert(normalizeTitle("River (Acoustic)") === "river acoustic", "keeps non-credit bracket words");

// ---- normalizeGenre / normalizeGenres ----
assert(normalizeGenre("atl hip hop") === "Hip Hop", "atl hip hop → Hip Hop");
assert(normalizeGenre("melodic drill") === "Trap", "drill → Trap");
assert(normalizeGenre("k-pop") === "K-Pop", "k-pop → K-Pop (before pop)");
assert(normalizeGenre("dark trap") === "Trap", "dark trap → Trap");
assert(normalizeGenre("reggaeton") === "Reggaeton", "reggaeton → Reggaeton");
assert(normalizeGenre("something nonsensical xyz") === null, "unknown genre → null");
assert(
  JSON.stringify(normalizeGenres(["atl hip hop", "trap", "rap"])) ===
    JSON.stringify(["Hip Hop", "Trap", "Rap"]),
  "normalizeGenres dedupes + maps"
);

assert(
  localDateKey(new Date(2026, 6, 13, 23, 30)) === "2026-07-13",
  "Daily Mix date follows the local calendar"
);
const fingerprintA = libraryMixFingerprint([
  track("spotify", "Artist A", "Shared Song"),
  track("soundcloud", "Artist A", "Shared Song")
]);
const fingerprintB = libraryMixFingerprint([
  track("soundcloud", "Artist A", "Shared Song"),
  track("spotify", "Artist A", "Shared Song")
]);
assert(fingerprintA === fingerprintB, "mix fingerprint is order and provider agnostic");

// ---- tempoBucketForBpm ----
assert(tempoBucketForBpm(null) === null, "null bpm → null");
assert(tempoBucketForBpm(0) === null, "0 bpm → null");
assert(tempoBucketForBpm(70) === "chill", "70 → chill");
assert(tempoBucketForBpm(100) === "mellow", "100 → mellow");
assert(tempoBucketForBpm(120) === "upbeat", "120 → upbeat");
assert(tempoBucketForBpm(140) === "energetic", "140 → energetic");
assert(tempoBucketForBpm(170) === "fast", "170 → fast");

// ---- scoreTwinMatch / pickBestTwin (anchor fix) ----
const seed = track("spotify", "Drake", "Passionfruit", { durationMs: 298000 });
const exactTwin = track("soundcloud", "Drake", "Passionfruit", { durationMs: 299000 });
const wrongLangDecoy = track("soundcloud", "DJ XYZ", "Passionfruit (사랑 Remix)", { durationMs: 180000 });
const coverDecoy = track("soundcloud", "Some Coverband", "Passionfruit (Acoustic Cover)", { durationMs: 240000 });
assert(
  scoreTwinMatch(seed, exactTwin) > scoreTwinMatch(seed, wrongLangDecoy),
  "exact twin out-scores wrong-language decoy"
);
assert(
  pickBestTwin(seed, [wrongLangDecoy, coverDecoy, exactTwin]) === exactTwin,
  "pickBestTwin picks the real twin over decoys"
);
assert(
  pickBestTwin(seed, [track("soundcloud", "Nobody", "Totally Different Song")]) === undefined,
  "pickBestTwin returns undefined when no confident match"
);

// ---- scoreStationCandidate: language gate ----
const enSeed = track("spotify", "The Weeknd", "Out of Time");
const baseSignals = {
  seed: enSeed,
  hop1Keys: new Set(),
  hop2Keys: new Set(),
  neighbourArtistWeight: new Map(),
  libraryArtists: new Set(),
  seedScript: "latin",
  libraryScripts: new Set(),
  seedGenres: new Set(),
  candidateGenres: new Map(),
  seedFeature: undefined,
  candidateFeatures: new Map()
};
const sameLangCandidate = track("soundcloud", "Giveon", "Heartbreak Anniversary");
const otherLangCandidate = track("soundcloud", "아이유", "밤편지");
// Both are hop-1 (same provenance) so the ONLY difference is the language gate.
const langSignals = {
  ...baseSignals,
  hop1Keys: new Set([
    `${sameLangCandidate.provider}:${sameLangCandidate.providerTrackId}`,
    `${otherLangCandidate.provider}:${otherLangCandidate.providerTrackId}`
  ])
};
assert(
  scoreStationCandidate(sameLangCandidate, langSignals) >
    scoreStationCandidate(otherLangCandidate, langSignals),
  "same-language candidate beats a different-script candidate with identical provenance"
);
assert(
  scoreStationCandidate(otherLangCandidate, langSignals) < 0,
  "different-script candidate is gated below zero despite hop-1 provenance"
);

// Multilingual library relaxes the gate.
const multilingualSignals = { ...langSignals, libraryScripts: new Set(["hangul"]) };
assert(
  scoreStationCandidate(otherLangCandidate, multilingualSignals) >
    scoreStationCandidate(otherLangCandidate, langSignals),
  "multilingual library softens the language penalty"
);

// ---- scoreStationCandidate: genre gate ----
const genreSeed = track("spotify", "Metro Boomin", "Trance");
const genreSignals = {
  ...baseSignals,
  seed: genreSeed,
  seedScript: "latin",
  seedGenres: new Set(["Hip Hop"]),
  candidateGenres: new Map()
};
const sameGenre = track("soundcloud", "Future", "Mask Off");
const offGenre = track("soundcloud", "Some Folk Singer", "Quiet Cabin");
const cg = new Map();
cg.set(`${sameGenre.provider}:${sameGenre.providerTrackId}`, new Set(["Hip Hop"]));
cg.set(`${offGenre.provider}:${offGenre.providerTrackId}`, new Set(["Folk"]));
const withGenres = { ...genreSignals, candidateGenres: cg };
assert(
  scoreStationCandidate(sameGenre, withGenres) > scoreStationCandidate(offGenre, withGenres),
  "matching-genre candidate beats off-genre candidate"
);

// ---- scoreStationCandidate: vibe distance ----
const vibeSeedFeature = { bpm: 90, loudness: -6 };
const closeVibe = track("soundcloud", "Artist A", "Close Tempo");
const farVibe = track("soundcloud", "Artist B", "Far Tempo");
const cf = new Map();
cf.set(`${closeVibe.provider}:${closeVibe.providerTrackId}`, { bpm: 95, loudness: -6 });
cf.set(`${farVibe.provider}:${farVibe.providerTrackId}`, { bpm: 175, loudness: -3 });
const vibeSignals = {
  ...baseSignals,
  seedFeature: vibeSeedFeature,
  candidateFeatures: cf,
  hop1Keys: new Set([
    `${closeVibe.provider}:${closeVibe.providerTrackId}`,
    `${farVibe.provider}:${farVibe.providerTrackId}`
  ])
};
assert(
  scoreStationCandidate(closeVibe, vibeSignals) > scoreStationCandidate(farVibe, vibeSignals),
  "similar-tempo candidate beats a far-tempo one"
);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
