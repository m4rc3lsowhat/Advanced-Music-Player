import type { Provider, UnifiedTrack } from "@amp/core";
import { normalizeGenre } from "../genreNormalize";

/**
 * Pure composition engine for Home "Daily Mixes" and song-seeded "Stations".
 *
 * Everything here is deterministic and network-free: discovery (provider API calls) happens
 * elsewhere and is passed in as plain track lists. That keeps this module fully unit-testable and
 * lets the same seeded date produce the same mixes all day (so Home is stable, not reshuffling on
 * every render).
 */

export type MixKind = "daily" | "blend" | "station";

export interface HomeMix {
  id: string;
  kind: MixKind;
  title: string;
  subtitle: string;
  tracks: UnifiedTrack[];
  /** For daily mixes: the artist (or genre) the cluster is anchored on. */
  anchor?: string;
}

export interface ArtistCluster {
  artist: string;
  tracks: UnifiedTrack[];
}

/** Stable identity for a track across providers, used for de-duplication. */
export function trackKey(track: UnifiedTrack): string {
  return `${track.provider}:${track.providerTrackId || track.id}`;
}

/** Remove duplicate tracks (same provider + providerTrackId), keeping first occurrence/order. */
export function dedupeTracks(tracks: UnifiedTrack[]): UnifiedTrack[] {
  const seen = new Set<string>();
  const out: UnifiedTrack[] = [];
  for (const track of tracks) {
    const key = trackKey(track);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(track);
  }
  return out;
}

/** Lower-cased, trimmed artist name with collapsed whitespace, for grouping/matching. */
export function normalizeArtist(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The track's primary artist (first credited creator), or "Unknown" if none. */
export function primaryArtist(track: UnifiedTrack): string {
  return track.creators.find((name) => name.trim().length > 0)?.trim() ?? "Unknown";
}

/**
 * Drop tracks whose primary artist matches `artist` (case-insensitive). Used to keep "discovered"
 * tracks to OTHER, similar artists instead of returning more of the anchor artist — the core of
 * making a Daily Mix feel like discovery rather than a single-artist playlist.
 */
export function excludeArtist(tracks: UnifiedTrack[], artist: string): UnifiedTrack[] {
  const target = normalizeArtist(artist);
  return tracks.filter((track) => normalizeArtist(primaryArtist(track)) !== target);
}

/**
 * Cap how many tracks any single artist contributes, preserving order. Keeps a pool of similar
 * tracks diverse so one adjacent artist doesn't dominate the mix/station.
 */
export function limitPerArtist(tracks: UnifiedTrack[], maxPerArtist: number): UnifiedTrack[] {
  const counts = new Map<string, number>();
  const out: UnifiedTrack[] = [];
  for (const track of tracks) {
    const key = normalizeArtist(primaryArtist(track));
    const count = counts.get(key) ?? 0;
    if (count >= maxPerArtist) {
      continue;
    }
    counts.set(key, count + 1);
    out.push(track);
  }
  return out;
}

/** Group tracks by their primary artist (display name preserved, matched case-insensitively). */
export function groupByArtist(tracks: UnifiedTrack[]): Map<string, UnifiedTrack[]> {
  const byKey = new Map<string, { display: string; tracks: UnifiedTrack[] }>();
  for (const track of tracks) {
    const display = primaryArtist(track);
    const key = normalizeArtist(display);
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.tracks.push(track);
    } else {
      byKey.set(key, { display, tracks: [track] });
    }
  }
  const out = new Map<string, UnifiedTrack[]>();
  for (const { display, tracks: bucketTracks } of byKey.values()) {
    out.set(display, bucketTracks);
  }
  return out;
}

/**
 * Top artist clusters by track count, descending. Ties broken alphabetically so the result is
 * deterministic. Clusters below `minTracks` are dropped (a one-off track isn't a "mix").
 */
export function topArtistClusters(
  tracks: UnifiedTrack[],
  max: number,
  minTracks = 1
): ArtistCluster[] {
  const groups = groupByArtist(tracks);
  return Array.from(groups.entries())
    .map(([artist, clusterTracks]) => ({ artist, tracks: clusterTracks }))
    .filter((cluster) => cluster.tracks.length >= minTracks && cluster.artist !== "Unknown")
    .sort((a, b) => b.tracks.length - a.tracks.length || a.artist.localeCompare(b.artist))
    .slice(0, max);
}

/** Deterministic 32-bit string hash (FNV-1a style) used to seed shuffles. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG — small, fast, deterministic. Returns a function yielding floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher-Yates shuffle seeded by a string — same seed always yields same order. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  const out = items.slice();
  const rand = seededRandom(hashString(seed));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Weave two lists together in alternating runs, capped at `limit`. Generic over any item; used to
 * blend providers (Spotify × SoundCloud) and familiar × discovered.
 */
export function interleave<T>(
  primary: T[],
  secondary: T[],
  primaryRun: number,
  secondaryRun: number,
  limit: number
): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (out.length < limit && (i < primary.length || j < secondary.length)) {
    for (let k = 0; k < primaryRun && i < primary.length && out.length < limit; k += 1) {
      out.push(primary[i]);
      i += 1;
    }
    for (let k = 0; k < secondaryRun && j < secondary.length && out.length < limit; k += 1) {
      out.push(secondary[j]);
      j += 1;
    }
  }
  return out;
}

export interface DailyMixOptions {
  /** Calendar date key (e.g. "2026-06-08"). Seeds ordering so mixes are stable for the whole day. */
  date: string;
  /** How many Daily Mixes to produce. */
  count: number;
  /** Target track count per mix. */
  size: number;
  /**
   * Discovered (new, not-yet-in-library) tracks keyed by anchor artist — produced by the discovery
   * layer. Optional: with none provided, mixes are built from library tracks only.
   */
  discovered?: Map<string, UnifiedTrack[]>;
  /** Minimum familiar tracks an artist must have to anchor a mix. */
  minClusterSize?: number;
}

/**
 * Build artist-anchored Daily Mixes from the user's library, blending familiar tracks with
 * discovered ones. Deterministic for a given `date` so the set is stable across renders/restarts.
 */
export function buildDailyMixes(library: UnifiedTrack[], options: DailyMixOptions): HomeMix[] {
  const { date, count, size } = options;
  const clusters = topArtistClusters(library, count, options.minClusterSize ?? 2);

  const mixes: HomeMix[] = [];
  clusters.forEach((cluster, index) => {
    const familiar = seededShuffle(cluster.tracks, `${date}:${cluster.artist}`);
    const discovered = options.discovered?.get(cluster.artist) ?? [];
    const discoveredFresh = seededShuffle(discovered, `${date}:disc:${cluster.artist}`);

    // Weave toward discovery — 1 familiar : 2 similar — so the mix plays like a varied radio
    // (anchor artist sprinkled through similar artists), not a single-artist playlist. Falls back to
    // the familiar lane only when discovery turned up nothing.
    const woven = discoveredFresh.length
      ? interleave(familiar, discoveredFresh, 1, 2, size)
      : familiar.slice(0, size);

    const tracks = dedupeTracks(woven);
    if (tracks.length < 4) {
      return;
    }
    mixes.push({
      id: `daily-${date}-${index}`,
      kind: "daily",
      title: `Daily Mix ${index + 1}`,
      subtitle: discoveredFresh.length
        ? `${cluster.artist} & similar — new picks daily`
        : `Built around ${cluster.artist}`,
      tracks,
      anchor: cluster.artist
    });
  });
  return mixes;
}

export interface StationOptions {
  /** Target track count for the station queue. */
  size: number;
  /** Seed string for deterministic ordering (e.g. seed track id). */
  seedKey?: string;
}

// ---- Station v2: similarity scoring, cross-provider dedupe, vibe-aware ordering ----

/** Bracketed or trailing featuring/production credits — noise for cross-provider matching. */
const CREDIT_IN_BRACKETS = /[([{][^)\]}]*\b(?:feat\.?|ft\.?|featuring|with|prod\.?)\b[^)\]}]*[)\]}]/gi;
const TRAILING_CREDIT = /\b(?:feat\.?|ft\.?|featuring)\s+.+$/i;

/**
 * Provider-agnostic identity for "the same song listed on both platforms": normalized title (credits
 * stripped, punctuation collapsed) plus primary artist. Words like "remix"/"live" survive on purpose
 * — a remix is a different song and must not collapse into the original.
 */
/** Normalized title: credits stripped, punctuation collapsed. Shared by cross-provider matching
 *  and the station "twin" resolver. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(CREDIT_IN_BRACKETS, " ")
    .replace(TRAILING_CREDIT, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function crossProviderKey(track: UnifiedTrack): string {
  return `${normalizeTitle(track.title)}::${normalizeArtist(primaryArtist(track))}`;
}

/** Local calendar date used to keep Daily Mix rollover aligned with the listener's midnight. */
export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Stable signature for the provider-agnostic songs that currently seed Daily Mixes. */
export function libraryMixFingerprint(tracks: UnifiedTrack[]): string {
  const keys = [...new Set(tracks.map(crossProviderKey))].sort();
  return `${keys.length}:${hashString(keys.join("\u001f")).toString(36)}`;
}

// ---- Script / language detection (for the station language gate) ----

export type ScriptTag =
  | "latin"
  | "cyrillic"
  | "cjk"
  | "hangul"
  | "arabic"
  | "devanagari"
  | "hebrew"
  | "greek"
  | "thai"
  | "other";

/**
 * Dominant writing script of a string (title + artist). Catches the jarring "station switched to a
 * different language" drift (English → Korean → Russian). Note: it groups all Latin-script
 * languages together, so Spanish vs English is NOT distinguished — only genuine script jumps are.
 */
export function detectScript(text: string): ScriptTag {
  const counts: Record<ScriptTag, number> = {
    latin: 0,
    cyrillic: 0,
    cjk: 0,
    hangul: 0,
    arabic: 0,
    devanagari: 0,
    hebrew: 0,
    greek: 0,
    thai: 0,
    other: 0
  };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) {
      counts.latin += 1;
    } else if (code >= 0x400 && code <= 0x4ff) {
      counts.cyrillic += 1;
    } else if (code >= 0xac00 && code <= 0xd7a3) {
      counts.hangul += 1;
    } else if (
      (code >= 0x3040 && code <= 0x30ff) || // hiragana + katakana → grouped with CJK
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf)
    ) {
      counts.cjk += 1;
    } else if ((code >= 0x600 && code <= 0x6ff) || (code >= 0x750 && code <= 0x77f)) {
      counts.arabic += 1;
    } else if (code >= 0x900 && code <= 0x97f) {
      counts.devanagari += 1;
    } else if (code >= 0x590 && code <= 0x5ff) {
      counts.hebrew += 1;
    } else if (code >= 0x370 && code <= 0x3ff) {
      counts.greek += 1;
    } else if (code >= 0xe00 && code <= 0xe7f) {
      counts.thai += 1;
    }
  }
  // Bias toward non-Latin scripts: romanized artist names and loanwords inflate the Latin count, so
  // a track with real CJK/Hangul/Cyrillic presence should be tagged by THAT script (it's the signal
  // the language gate cares about), not drowned out by a romaji artist credit.
  let total = 0;
  let nonLatinBest: ScriptTag = "other";
  let nonLatinCount = 0;
  for (const key of Object.keys(counts) as ScriptTag[]) {
    total += counts[key];
    if (key !== "latin" && key !== "other" && counts[key] > nonLatinCount) {
      nonLatinCount = counts[key];
      nonLatinBest = key;
    }
  }
  if (nonLatinCount > 0 && nonLatinCount >= Math.max(2, total * 0.2)) {
    return nonLatinBest;
  }
  return counts.latin > 0 ? "latin" : "other";
}

// ---- Station seed "twin" resolution ----

/**
 * Confidence that `candidate` is the same recording as `seed` — title equality dominates, artist
 * match and duration proximity refine. Used to stop the station engine from anchoring on the wrong
 * SoundCloud upload (a cover/remix/same-title decoy), the core "it just searched the name" bug.
 */
export function scoreTwinMatch(seed: UnifiedTrack, candidate: UnifiedTrack): number {
  const seedTitle = normalizeTitle(seed.title);
  const candTitle = normalizeTitle(candidate.title);
  const seedArtist = normalizeArtist(primaryArtist(seed));
  const candArtist = normalizeArtist(primaryArtist(candidate));
  let score = 0;

  if (candTitle === seedTitle) {
    score += 3;
  } else if (seedTitle && (candTitle.includes(seedTitle) || seedTitle.includes(candTitle))) {
    score += 1.5;
  }
  if (candArtist === seedArtist) {
    score += 2;
  } else if (seedArtist && (candArtist.includes(seedArtist) || seedArtist.includes(candArtist))) {
    score += 1;
  }
  const delta = Math.abs(candidate.durationMs - seed.durationMs);
  if (delta <= 3000) {
    score += 1;
  } else if (delta <= 8000) {
    score += 0.5;
  } else if (delta > 30000) {
    score -= 1;
  }
  return score;
}

/** Best confident twin among `candidates`, or undefined if none clears `minScore`. */
export function pickBestTwin(
  seed: UnifiedTrack,
  candidates: UnifiedTrack[],
  minScore = 3.5
): UnifiedTrack | undefined {
  let best: UnifiedTrack | undefined;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scoreTwinMatch(seed, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best && bestScore >= minScore ? best : undefined;
}

/** Normalized top-level genre set for a single raw genre tag (fallback when no enrichment map). */
function toGenreSet(genre: string | undefined): Set<string> {
  const normalized = normalizeGenre(genre);
  return normalized ? new Set<string>([normalized]) : new Set<string>();
}

/**
 * Collapse cross-provider duplicates (same song on Spotify AND SoundCloud), keeping the
 * `preferred` provider's copy when both exist. Order of first appearance is preserved.
 */
export function dedupeAcrossProviders(tracks: UnifiedTrack[], preferred: Provider): UnifiedTrack[] {
  const byKey = new Map<string, UnifiedTrack>();
  for (const track of tracks) {
    const key = crossProviderKey(track);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, track);
    } else if (existing.provider !== preferred && track.provider === preferred) {
      byKey.set(key, track);
    }
  }
  return [...byKey.values()];
}

/** Everything the scorer knows about how a candidate relates to the seed. */
export interface StationSignals {
  seed: UnifiedTrack;
  /** trackKeys of SoundCloud related-tracks for the seed itself (strongest similarity signal). */
  hop1Keys: Set<string>;
  /** trackKeys of related-tracks of hop-1 tracks (neighbour-of-neighbour). */
  hop2Keys: Set<string>;
  /** Normalized artist → weighted appearance count across the related pools. */
  neighbourArtistWeight: Map<string, number>;
  /** Normalized artists present in the user's library (familiarity nudge). */
  libraryArtists: Set<string>;
  /** Dominant script of the seed (title+artist). Candidates in another script are gated out. */
  seedScript?: ScriptTag;
  /** Scripts well-represented in the user's library — relaxes the language gate for multilingual users. */
  libraryScripts?: Set<ScriptTag>;
  /** Normalized top-level genres of the seed (SoundCloud tag / Spotify artist genres). */
  seedGenres?: Set<string>;
  /** Per-candidate normalized genres, keyed by trackKey. */
  candidateGenres?: Map<string, Set<string>>;
  /** Seed tempo (bpm) + loudness, when known (Deezer enrichment). */
  seedFeature?: { bpm: number | null; loudness: number | null };
  /** Per-candidate tempo/loudness, keyed by trackKey. */
  candidateFeatures?: Map<string, { bpm: number | null; loudness: number | null }>;
}

/**
 * Similarity score for one station candidate. Provenance dominates (being a related-track of the
 * seed beats every soft signal); artist-level signals and vibe proxies (genre, duration) refine.
 */
export function scoreStationCandidate(track: UnifiedTrack, signals: StationSignals): number {
  const key = trackKey(track);
  const artist = normalizeArtist(primaryArtist(track));
  const seedArtist = normalizeArtist(primaryArtist(signals.seed));
  let score = 0;

  if (signals.hop1Keys.has(key)) {
    score += 3;
  } else if (signals.hop2Keys.has(key)) {
    score += 1.5;
  }
  // Artists that keep showing up across the related pools are the seed's true neighbourhood.
  score += Math.min(signals.neighbourArtistWeight.get(artist) ?? 0, 4) * 0.5;
  if (artist === seedArtist) {
    score += 0.75;
  }
  if (signals.libraryArtists.has(artist)) {
    score += 0.75;
  }

  // Genre: reward overlap, softly penalize a mismatch. A soft penalty (not a hard gate) is what
  // keeps a "balanced" station mostly in-lane while still allowing the occasional adjacent-genre
  // left turn — versus the old +1 tiebreaker that a wrong-genre related track easily out-scored.
  const seedGenres = signals.seedGenres ?? toGenreSet(signals.seed.genre);
  const candGenres = signals.candidateGenres?.get(key) ?? toGenreSet(track.genre);
  if (seedGenres.size > 0 && candGenres.size > 0) {
    const overlaps = [...candGenres].some((genre) => seedGenres.has(genre));
    score += overlaps ? 1.5 : -1.5;
  }

  // Language gate: a different writing script is the "switched to another language" drift the user
  // hit. Hard-penalize it (effectively a gate vs. the ~+6 max of provenance signals) UNLESS the
  // user's own library shows they listen in that script.
  if (signals.seedScript && signals.seedScript !== "other") {
    const candScript = detectScript(`${track.title} ${primaryArtist(track)}`);
    if (candScript !== "other" && candScript !== signals.seedScript) {
      const allowed = signals.libraryScripts?.has(candScript) ?? false;
      score += allowed ? -1 : -12;
    }
  }

  // Vibe distance: when Deezer gave us tempo/loudness for BOTH, pull candidates far from the seed's
  // feel down. Absent features → term is skipped (no penalty), so coverage gaps never break a station.
  const seedFeature = signals.seedFeature;
  const candFeature = signals.candidateFeatures?.get(key);
  if (seedFeature?.bpm != null && candFeature?.bpm != null) {
    score -= Math.min(Math.abs(candFeature.bpm - seedFeature.bpm) / 60, 1) * 1.5;
    if (seedFeature.loudness != null && candFeature.loudness != null) {
      score -= Math.min(Math.abs(candFeature.loudness - seedFeature.loudness) / 6, 1) * 0.5;
    }
  }

  // Mild vibe proxy: songs wildly longer/shorter than the seed (3+ min apart) score nothing here.
  const durationDelta = Math.abs(track.durationMs - signals.seed.durationMs);
  score += 0.5 * (1 - Math.min(durationDelta / 180_000, 1));

  return score;
}

/**
 * Order station candidates: highest similarity first with seeded jitter (so equal scores vary per
 * station, not per render), a hard no-same-artist-back-to-back rule, per-artist score decay so no
 * one artist floods the queue, and a soft nudge to rotate providers after a 3-run streak.
 */
export function orderStationTracks(
  candidates: UnifiedTrack[],
  scores: Map<string, number>,
  seedKey: string,
  size: number
): UnifiedTrack[] {
  const rand = seededRandom(hashString(`${seedKey}:order`));
  const pool = candidates.map((track) => ({
    track,
    base: scores.get(trackKey(track)) ?? 0,
    jitter: rand()
  }));
  const artistPlays = new Map<string, number>();
  const out: UnifiedTrack[] = [];
  let lastArtist: string | undefined;
  let lastProvider: Provider | undefined;
  let providerStreak = 0;

  while (out.length < size && pool.length > 0) {
    // Provider floor: provenance scores come from SoundCloud's related graph, so without a floor
    // the other provider gets buried (stations came out 48-vs-2). While the pool still offers more
    // than one provider, any provider sitting under ~30% of the queue so far takes the next slot.
    let forcedProvider: Provider | undefined;
    if (out.length >= 2) {
      const pooledProviders = new Set(pool.map((item) => item.track.provider));
      if (pooledProviders.size > 1) {
        const placed = new Map<Provider, number>();
        for (const track of out) {
          placed.set(track.provider, (placed.get(track.provider) ?? 0) + 1);
        }
        for (const provider of pooledProviders) {
          if ((placed.get(provider) ?? 0) < Math.floor(out.length * 0.3)) {
            forcedProvider = provider;
            break;
          }
        }
      }
    }
    let bestIndex = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const { track, base, jitter } = pool[i];
      const artist = normalizeArtist(primaryArtist(track));
      if (artist === lastArtist && pool.length > 1) {
        continue;
      }
      if (forcedProvider && track.provider !== forcedProvider) {
        continue;
      }
      const plays = artistPlays.get(artist) ?? 0;
      let value = base * Math.pow(0.55, plays) + jitter * 1.1;
      if (lastProvider && providerStreak >= 3 && track.provider !== lastProvider) {
        value += 0.5;
      }
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) {
      bestIndex = 0;
    }
    const picked = pool.splice(bestIndex, 1)[0].track;
    const artist = normalizeArtist(primaryArtist(picked));
    artistPlays.set(artist, (artistPlays.get(artist) ?? 0) + 1);
    providerStreak = picked.provider === lastProvider ? providerStreak + 1 : 1;
    lastProvider = picked.provider;
    lastArtist = artist;
    out.push(picked);
  }
  return out;
}

/**
 * Build a song-seeded station from scored candidates: the seed first (playback starts on the song
 * the user chose), then candidates in similarity order. Candidates should already be playable,
 * seed-free and cross-provider deduped — this function only orders and packages.
 */
export function buildScoredStation(
  seed: UnifiedTrack,
  candidates: UnifiedTrack[],
  scores: Map<string, number>,
  options: StationOptions
): HomeMix {
  const seedKey = options.seedKey ?? trackKey(seed);
  const pool = candidates.filter(
    (track) => trackKey(track) !== trackKey(seed) && (scores.get(trackKey(track)) ?? 0) >= 0
  );
  const ordered = orderStationTracks(pool, scores, seedKey, Math.max(0, options.size - 1));
  const tracks = dedupeTracks([seed, ...ordered]).slice(0, options.size);

  return {
    id: `station-${seedKey}`,
    kind: "station",
    title: `${seed.title} Radio`,
    subtitle: `Based on ${primaryArtist(seed)}`,
    tracks,
    anchor: primaryArtist(seed)
  };
}
