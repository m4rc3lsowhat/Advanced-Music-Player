import {
  DEFAULT_PROVIDER_VOLUMES,
  clampVolume,
  reorderPlaylistEntries,
  type PlaylistEntry,
  type ProjectTrack,
  type ProjectTrackSource,
  type Provider,
  type ProviderVolumeMap,
  type ProviderConnection,
  type UnifiedPlaylist,
  type UnifiedTrack
} from "@amp/core";
import { createDefaultConnections } from "./defaults";
import type { TrackFeatureMap } from "./trackFeatures";

const PLAYLISTS_KEY = "spot-cloud.playlists";
const RECENTS_KEY = "spot-cloud.recent";
const PROJECT_TRACKS_KEY = "spot-cloud.project-tracks";
const UI_PREFS_KEY = "spot-cloud.ui-prefs";
const AUDIO_FEATURES_KEY = "spot-cloud.audio-features";

export type AccentSource = "artwork" | "audio" | "static";

/** Beat-pulse strength multiplier for "audio" accent mode. 1 = default; 0 = no pulse; 2 = double. */
export const BEAT_INTENSITY_DEFAULT = 1;
export const BEAT_INTENSITY_MAX = 2;

interface UiPreferences {
  accentSource?: AccentSource;
  beatIntensity?: number;
  soundCloudProfileUrl?: string;
  volume?: number;
  providerVolumes?: Partial<Record<Provider, number>>;
  onboardingComplete?: boolean;
  shuffle?: boolean;
  discordPresenceEnabled?: boolean;
}

// Older builds seeded fake "demo" tracks/playlist that could get persisted locally.
// These helpers purge that leftover data so the library only ever shows real items.
const DEMO_TRACK_ID_PREFIX = "demo-";
const DEMO_PLAYLIST_ID = "playlist-demo-1";

function isDemoTrack(track: { id?: string } | undefined): boolean {
  return typeof track?.id === "string" && track.id.startsWith(DEMO_TRACK_ID_PREFIX);
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readJson<T>(key: string, fallback: T): T {
  if (!canUseStorage()) {
    return fallback;
  }

  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(fallback) && !Array.isArray(parsed)) {
      return fallback;
    }
    if (
      fallback !== null &&
      typeof fallback === "object" &&
      !Array.isArray(fallback) &&
      (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      return fallback;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProvider(value: unknown): value is Provider {
  return value === "spotify" || value === "soundcloud" || value === "youtube" || value === "local";
}

function isUnifiedTrack(value: unknown): value is UnifiedTrack {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isProvider(value.provider) &&
    typeof value.providerTrackId === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.creators) &&
    value.creators.every((creator) => typeof creator === "string") &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    typeof value.explicit === "boolean" &&
    typeof value.playable === "boolean"
  );
}

function isPlaylistEntry(value: unknown): value is PlaylistEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.playlistId === "string" &&
    typeof value.order === "number" &&
    Number.isFinite(value.order) &&
    typeof value.addedAt === "string" &&
    isUnifiedTrack(value.track)
  );
}

function readStoredPlaylists(): UnifiedPlaylist[] {
  return readJson<unknown[]>(PLAYLISTS_KEY, []).flatMap((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.ownerId !== "string" ||
      typeof value.title !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string" ||
      !Array.isArray(value.entries)
    ) {
      return [];
    }
    return [{ ...value, entries: value.entries.filter(isPlaylistEntry) } as unknown as UnifiedPlaylist];
  });
}

function readStoredProjectTracks(): ProjectTrack[] {
  return readJson<unknown[]>(PROJECT_TRACKS_KEY, []).filter((value): value is ProjectTrack =>
    Boolean(
      isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.ownerId === "string" &&
        isProvider(value.provider) &&
        typeof value.providerTrackId === "string" &&
        typeof value.source === "string" &&
        typeof value.createdAt === "string" &&
        typeof value.updatedAt === "string" &&
        isUnifiedTrack(value.track)
    )
  );
}

function readStoredRecentTracks(): UnifiedTrack[] {
  return readJson<unknown[]>(RECENTS_KEY, []).filter(isUnifiedTrack);
}

function writeJson<T>(key: string, value: T): boolean {
  if (!canUseStorage()) {
    return false;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    // Most likely QuotaExceededError on a very large library. Throwing here used to abort the
    // caller (add/import/like) midway — a skipped persist is the lesser failure, so log and move on.
    console.warn(`Persist failed for "${key}"`, error);
    return false;
  }
}

function writeJsonOrThrow<T>(key: string, value: T, label: string): void {
  if (!writeJson(key, value)) {
    throw new Error(`Could not save ${label}. Local storage may be full or unavailable.`);
  }
}

function hydrateTrackSnapshot(track: UnifiedTrack, projectTrackId?: string | null): UnifiedTrack {
  return {
    ...track,
    projectTrackId: projectTrackId ?? track.projectTrackId
  };
}

export async function loadPlaylists(): Promise<UnifiedPlaylist[]> {
  const rawStored = readStoredPlaylists();
  const stored = rawStored
    .filter((playlist) => playlist.id !== DEMO_PLAYLIST_ID)
    .map((playlist) => ({
      ...playlist,
      entries: playlist.entries.filter((entry) => !isDemoTrack(entry.track))
    }));
  if (stored.length !== rawStored.length) {
    writeJson(PLAYLISTS_KEY, stored);
  }
  return stored.map((playlist) => ({
    ...playlist,
    entries: reorderPlaylistEntries(
      [...playlist.entries]
        .sort((left, right) => left.order - right.order)
        .map<PlaylistEntry>((entry) => ({
          ...entry,
          track: hydrateTrackSnapshot(entry.track, entry.projectTrackId)
        }))
    )
  }));
}

export async function loadProjectTracks(): Promise<ProjectTrack[]> {
  const stored = readStoredProjectTracks();
  const cleaned = stored.filter((item) => !isDemoTrack(item.track));
  if (cleaned.length !== stored.length) {
    writeJson(PROJECT_TRACKS_KEY, cleaned);
  }
  return cleaned;
}

export async function upsertProjectTrack(
  track: UnifiedTrack,
  source: ProjectTrackSource
): Promise<ProjectTrack> {
  const normalizedProviderTrackId = track.providerTrackId || track.id;
  const now = new Date().toISOString();

  const all = readStoredProjectTracks();
  const existing = all.find(
    (item) => item.provider === track.provider && item.providerTrackId === normalizedProviderTrackId
  );
  const projectTrackId = existing?.id ?? track.projectTrackId ?? crypto.randomUUID();
  const nextTrack = hydrateTrackSnapshot(
    { ...track, providerTrackId: normalizedProviderTrackId },
    projectTrackId
  );
  const nextProjectTrack: ProjectTrack = {
    id: projectTrackId,
    ownerId: "local-user",
    provider: track.provider,
    providerTrackId: normalizedProviderTrackId,
    source,
    track: nextTrack,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const remaining = all.filter((item) => item.id !== nextProjectTrack.id);
  writeJsonOrThrow(PROJECT_TRACKS_KEY, [nextProjectTrack, ...remaining], "the music library");
  return nextProjectTrack;
}

export async function upsertProjectTracks(
  tracks: UnifiedTrack[],
  source: ProjectTrackSource
): Promise<ProjectTrack[]> {
  if (tracks.length === 0) {
    return [];
  }

  const now = new Date().toISOString();
  const all = readStoredProjectTracks();
  const byKey = new Map<string, ProjectTrack>(
    all.map((item) => [`${item.provider}:${item.providerTrackId}`, item] as const)
  );
  const incoming: ProjectTrack[] = [];
  const incomingKeys = new Set<string>();

  for (const track of tracks) {
    const normalizedProviderTrackId = track.providerTrackId || track.id;
    const key = `${track.provider}:${normalizedProviderTrackId}`;
    const existing = byKey.get(key);
    const projectTrackId = existing?.id ?? track.projectTrackId ?? crypto.randomUUID();
    const nextTrack = hydrateTrackSnapshot(
      { ...track, providerTrackId: normalizedProviderTrackId },
      projectTrackId
    );
    const nextProjectTrack: ProjectTrack = {
      id: projectTrackId,
      ownerId: "local-user",
      provider: track.provider,
      providerTrackId: normalizedProviderTrackId,
      source,
      track: nextTrack,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    byKey.set(key, nextProjectTrack);
    incomingKeys.add(key);
    incoming.push(nextProjectTrack);
  }

  const remaining = all.filter((item) => !incomingKeys.has(`${item.provider}:${item.providerTrackId}`));
  writeJsonOrThrow(PROJECT_TRACKS_KEY, [...incoming, ...remaining], "the music library");
  return incoming;
}

export async function upsertPlaylist(playlist: UnifiedPlaylist): Promise<void> {
  const existing = readStoredPlaylists();
  const next = existing.filter((item) => item.id !== playlist.id);
  next.unshift(playlist);
  writeJsonOrThrow(PLAYLISTS_KEY, next, "the playlist");
}

export async function deletePlaylist(id: string): Promise<void> {
  const all = readStoredPlaylists();
  writeJsonOrThrow(
    PLAYLISTS_KEY,
    all.filter((playlist) => playlist.id !== id),
    "the playlist change"
  );
}

export async function replaceRecentTracks(tracks: UnifiedTrack[]): Promise<void> {
  writeJson(RECENTS_KEY, tracks);
}

export async function loadRecentTracks(): Promise<UnifiedTrack[]> {
  const stored = readStoredRecentTracks();
  const cleaned = stored.filter((track) => !isDemoTrack(track));
  if (cleaned.length !== stored.length) {
    writeJson(RECENTS_KEY, cleaned);
  }
  return cleaned;
}

export async function loadProviderConnections(): Promise<Record<Provider, ProviderConnection>> {
  return createDefaultConnections();
}

export async function disconnectProvider(_provider: Provider): Promise<void> {
  // No remote state to clear — the desktop bridge clears the encrypted local session.
}

// ---- UI preferences (synchronous; backed by localStorage) ----

export function loadAccentSource(): AccentSource {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  return prefs.accentSource === "audio" || prefs.accentSource === "static"
    ? prefs.accentSource
    : "artwork";
}

export function saveAccentSource(source: AccentSource): void {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  writeJson(UI_PREFS_KEY, { ...prefs, accentSource: source });
}

export function loadBeatIntensity(): number {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  const value = prefs.beatIntensity;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return BEAT_INTENSITY_DEFAULT;
  }
  return Math.max(0, Math.min(BEAT_INTENSITY_MAX, value));
}

export function saveBeatIntensity(value: number): void {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  const clamped = Math.max(0, Math.min(BEAT_INTENSITY_MAX, value));
  writeJson(UI_PREFS_KEY, { ...prefs, beatIntensity: clamped });
}

export function loadDiscordPresenceEnabled(): boolean {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  // Privacy-first: presence is opt-in, so anything but an explicit true is off.
  return prefs.discordPresenceEnabled === true;
}

export function saveDiscordPresenceEnabled(enabled: boolean): void {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  writeJson(UI_PREFS_KEY, { ...prefs, discordPresenceEnabled: enabled });
}

// One master playback volume, with provider trims persisted separately for loudness matching.
export function loadVolume(): number {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  const volume = typeof prefs.volume === "number" ? prefs.volume : 0.8;
  return clampVolume(volume);
}

export function saveVolume(volume: number): void {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  writeJson(UI_PREFS_KEY, { ...prefs, volume: clampVolume(volume) });
}

export function loadProviderVolumes(): ProviderVolumeMap {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  const resolve = (provider: Provider) =>
    clampVolume(
      typeof prefs.providerVolumes?.[provider] === "number"
        ? (prefs.providerVolumes[provider] as number)
        : DEFAULT_PROVIDER_VOLUMES[provider]
    );
  return {
    spotify: resolve("spotify"),
    soundcloud: resolve("soundcloud"),
    youtube: resolve("youtube"),
    local: resolve("local")
  };
}

export function saveProviderVolume(provider: Provider, volume: number): void {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  writeJson(UI_PREFS_KEY, {
    ...prefs,
    providerVolumes: {
      ...prefs.providerVolumes,
      [provider]: clampVolume(volume)
    }
  });
}

// Shuffle toggle, persisted so the player remembers it across launches.
export function loadShuffle(): boolean {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  return prefs.shuffle === true;
}

export function saveShuffle(shuffle: boolean): void {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  writeJson(UI_PREFS_KEY, { ...prefs, shuffle });
}

// The first-run setup flag as a tri-state: true = finished/skipped setup; false = the user chose
// "Start over" (keep showing setup until they finish it again, even across relaunches); undefined =
// never set, so the store decides based on prior use (guide fresh installs, auto-skip existing ones).
export function loadOnboardingComplete(): boolean | undefined {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  return typeof prefs.onboardingComplete === "boolean" ? prefs.onboardingComplete : undefined;
}

export function saveOnboardingComplete(complete: boolean): void {
  const prefs = readJson<UiPreferences>(UI_PREFS_KEY, {});
  writeJson(UI_PREFS_KEY, { ...prefs, onboardingComplete: complete });
}

// ---- Per-track audio features (tempo/loudness/genre), cached once per track ----

export function loadTrackFeatures(): TrackFeatureMap {
  return readJson<TrackFeatureMap>(AUDIO_FEATURES_KEY, {});
}

export function saveTrackFeatures(map: TrackFeatureMap): void {
  writeJson(AUDIO_FEATURES_KEY, map);
}

// ---- Local listening stats (private, on-device — no analytics leaves the machine) ----

const PLAY_LOG_KEY = "spot-cloud.play-log";
const PLAY_LOG_CAP = 3000;

interface PlayEvent {
  key: string;
  title: string;
  artist: string;
  provider: Provider;
  at: number;
}

export interface ListeningStats {
  totalPlays: number;
  weekPlays: number;
  providerSplit: Record<Provider, number>;
  topArtists: Array<{ artist: string; count: number }>;
  topTracks: Array<{ key: string; title: string; artist: string; provider: Provider; count: number }>;
  /** Plays per calendar day for the last 7 days, oldest first (label = short weekday name). */
  days: Array<{ label: string; count: number }>;
}

function playEventArtist(track: UnifiedTrack): string {
  return track.creators.find((name) => name.trim().length > 0)?.trim() ?? "Unknown artist";
}

/** Append a play to the on-device log (capped, FIFO). Called whenever a track starts. */
export function recordPlay(track: UnifiedTrack, at = Date.now()): void {
  const log = readJson<PlayEvent[]>(PLAY_LOG_KEY, []);
  log.push({
    key: `${track.provider}:${track.providerTrackId || track.id}`,
    title: track.title,
    artist: playEventArtist(track),
    provider: track.provider,
    at
  });
  writeJson(PLAY_LOG_KEY, log.length > PLAY_LOG_CAP ? log.slice(log.length - PLAY_LOG_CAP) : log);
}

/** Aggregate the play log into top artists/tracks + totals. All computed locally. */
export function loadListeningStats(topN = 8): ListeningStats {
  const log = readJson<PlayEvent[]>(PLAY_LOG_KEY, []);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const artists = new Map<string, number>();
  const tracks = new Map<string, { title: string; artist: string; provider: Provider; count: number }>();
  const providerSplit: Record<Provider, number> = {
    spotify: 0,
    soundcloud: 0,
    youtube: 0,
    local: 0
  };
  let weekPlays = 0;

  // Last 7 calendar days (local time), oldest first, so the Stats page can chart daily activity.
  const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short" });
  const days: Array<{ label: string; count: number; start: number; end: number }> = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - offset);
    const start = day.getTime();
    days.push({
      label: offset === 0 ? "Today" : dayFormatter.format(day),
      count: 0,
      start,
      end: start + 24 * 60 * 60 * 1000
    });
  }

  for (const event of log) {
    artists.set(event.artist, (artists.get(event.artist) ?? 0) + 1);
    const existing = tracks.get(event.key);
    if (existing) {
      existing.count += 1;
    } else {
      tracks.set(event.key, { title: event.title, artist: event.artist, provider: event.provider, count: 1 });
    }
    if (isProvider(event.provider)) {
      providerSplit[event.provider] += 1;
    }
    if (event.at >= weekAgo) {
      weekPlays += 1;
      const day = days.find((entry) => event.at >= entry.start && event.at < entry.end);
      if (day) {
        day.count += 1;
      }
    }
  }

  const topArtists = Array.from(artists.entries())
    .filter(([artist]) => artist !== "Unknown artist")
    .map(([artist, count]) => ({ artist, count }))
    .sort((a, b) => b.count - a.count || a.artist.localeCompare(b.artist))
    .slice(0, topN);

  const topTracks = Array.from(tracks.entries())
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, topN);

  return {
    totalPlays: log.length,
    weekPlays,
    providerSplit,
    topArtists,
    topTracks,
    days: days.map(({ label, count }) => ({ label, count }))
  };
}

/** Wipe the on-device listening history. */
export function clearListeningStats(): void {
  writeJson(PLAY_LOG_KEY, []);
  writeJson(RECENTS_KEY, []);
}
