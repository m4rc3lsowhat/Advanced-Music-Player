import { create } from "zustand";
import {
  QueueEngine,
  createEmptyPlaybackState,
  createPlaylistEntry,
  reorderPlaylistEntries,
  type OAuthProvider,
  type PlaybackState,
  type ProviderCollection,
  type ProjectTrack,
  type ProjectTrackSource,
  type Provider,
  type ProviderConnection,
  type TrackCollection,
  type UnifiedPlaylist,
  type UnifiedTrack
} from "@amp/core";
import { createDefaultConnections } from "@/lib/defaults";
import {
  clearStoredProviderSession as clearStoredProviderSessionBridge,
  connectSoundCloudViaBrowser as connectSoundCloudViaBrowserBridge,
  connectSoundCloudLocalProfile as connectSoundCloudLocalProfileBridge,
  downloadSoundCloudTrack as downloadSoundCloudTrackBridge,
  closeSoundCloudLocalBrowser as closeSoundCloudLocalBrowserBridge,
  openSoundCloudLocalSignin as openSoundCloudLocalSigninBridge,
  connectDesktopProvider,
  cancelConnectDesktopProvider,
  gatewayRequest,
  getDesktopConfig,
  getSoundCloudPublicClientId,
  getRuntimeInfo,
  listSoundCloudLocalProfiles,
  openConfigDirectory as openConfigDirectoryBridge,
  refreshStoredProviderSession,
  reloadDesktopRuntime,
  saveDesktopConfig as saveDesktopConfigBridge,
  setDiscordPresenceEnabled as pushDiscordPresenceEnabled,
  setSoundCloudLocalTrackLiked,
  setSoundCloudWebTrackLiked,
  soundCloudWebReload,
  soundCloudWebSignOut,
  type DesktopConfig,
  type ProviderOAuthResult,
  type RuntimeInfo,
  type SoundCloudBrowserProfile
} from "@/lib/desktopBridge";
import {
  deletePlaylist as deletePlaylistRecord,
  disconnectProvider as disconnectProviderRecord,
  loadAccentSource,
  loadBeatIntensity,
  loadDiscordPresenceEnabled,
  loadOnboardingComplete,
  loadPlaylists,
  loadProjectTracks,
  loadProviderConnections,
  loadProviderVolumes,
  loadRecentTracks,
  loadShuffle,
  loadTrackFeatures,
  loadVolume,
  recordPlay,
  saveTrackFeatures,
  replaceRecentTracks,
  saveAccentSource,
  saveBeatIntensity,
  saveDiscordPresenceEnabled,
  saveOnboardingComplete,
  saveProviderVolume,
  saveShuffle,
  saveVolume,
  upsertProjectTrack,
  upsertProjectTracks,
  upsertPlaylist,
  type AccentSource
} from "@/lib/localStore";
import { isTrackMatch } from "@/lib/utils";
import {
  buildDailyMixes,
  buildScoredStation,
  crossProviderKey,
  dedupeAcrossProviders,
  detectScript,
  excludeArtist,
  limitPerArtist,
  libraryMixFingerprint,
  localDateKey,
  normalizeArtist,
  pickBestTwin,
  primaryArtist,
  scoreStationCandidate,
  topArtistClusters,
  trackKey,
  type HomeMix,
  type ScriptTag,
  type StationSignals
} from "@/lib/mixes/composition";
import { normalizeGenres } from "@/lib/genreNormalize";
import {
  fetchDeezerFeatures,
  makeTrackFeatures,
  resolveTrackGenres,
  type TrackFeatureMap
} from "@/lib/trackFeatures";
import { SoundCloudPlaybackAdapter } from "@/lib/providers/soundcloudAdapter";
import { createSpotifyAdapter } from "@/lib/providers/createSpotifyAdapter";
import { createLocalAdapter, type HtmlAudioAdapter } from "@/lib/providers/htmlAudioAdapter";
import { YouTubeIframeAdapter } from "@/lib/providers/youtubeIframeAdapter";
import { teardownSpotifyWebDevice } from "@/lib/spotifyWebPlayer";
import {
  addLocalMusicFolder,
  listLocalMusicFolders,
  removeLocalMusicFolder,
  scanLocalMusic
} from "@/lib/desktopBridge";
import type {
  SpotifyAlbumSummary,
  SpotifyBaseAdapter
} from "@/lib/providers/spotifyBaseAdapter";

type SearchProvider = "all" | Provider;

interface LibrarySyncState {
  syncing: boolean;
  importedCount: number;
  lastImportedAt?: string;
}

interface LoadedState {
  playlists: UnifiedPlaylist[];
  recentTracks: UnifiedTrack[];
  connections: Record<Provider, ProviderConnection>;
  projectTracks: ProjectTrack[];
}

type SoundCloudLocalStatus =
  | "idle"
  | "selecting-profile"
  | "connecting"
  | "syncing"
  | "connected"
  | "error";

interface SoundCloudLocalError {
  code?: string;
  message: string;
}

/** Where the current queue came from — drives the "Playing from" link in the Now Playing panel. */
export interface QueueSource {
  kind: "station" | "mix" | "playlist" | "library" | "search" | "album" | "artist";
  label: string;
  /** Set for stations/mixes so the link can reopen the tracklist. */
  mixId?: string;
}

/** Artist profile view model for the /artist route. */
export interface ArtistView {
  status: "loading" | "ready" | "error";
  provider: Provider;
  name: string;
  imageUrl?: string;
  genres?: string[];
  followers?: number;
  externalUrl?: string;
  topTracks: UnifiedTrack[];
  /** Spotify only — SoundCloud artists publish playlists instead. */
  albums: SpotifyAlbumSummary[];
  playlists?: ProviderCollection[];
  error?: string;
}

/** Album tracklist view model for the /album route. */
export interface AlbumView {
  status: "loading" | "ready" | "error";
  provider: Provider;
  id?: string;
  name: string;
  artistNames: string[];
  imageUrl?: string;
  releaseYear?: string;
  tracks: UnifiedTrack[];
  error?: string;
}

interface AppState {
  initialized: boolean;
  initializing: boolean;
  initializationError?: string;
  /** Human-readable boot stage + progress (0..1), updated during initialize() for the splash bar. */
  bootStage: string;
  bootProgress: number;
  runtime?: RuntimeInfo;
  desktopConfig: DesktopConfig;
  notice?: string;
  selectedPlaylistId?: string;
  connections: Record<Provider, ProviderConnection>;
  projectTracks: ProjectTrack[];
  playlists: UnifiedPlaylist[];
  recentTracks: UnifiedTrack[];
  /** Artist-anchored Daily Mixes for the current day, plus the date they were generated for. */
  dailyMixes: HomeMix[];
  dailyMixesDate?: string;
  dailyMixesLibraryFingerprint?: string;
  mixesStatus: "idle" | "loading" | "ready";
  /** The mix currently opened in the Mix detail view (Daily Mix, blend or station). */
  activeMix?: HomeMix;
  /** The most recently built station, so its tracklist stays reachable after it starts playing. */
  lastStation?: HomeMix;
  /** Where the current queue came from (station/mix/playlist/…), if known. */
  queueSource?: QueueSource;
  /** Artist profile opened in the /artist route. */
  activeArtist?: ArtistView;
  /** Album tracklist opened in the /album route. */
  activeAlbum?: AlbumView;
  /** Right-click track context menu: the target track, where to render, and what surface opened it. */
  trackMenu?: { track: UnifiedTrack; x: number; y: number; source?: "list" | "queue"; queueIndex?: number };
  providerCollections: Partial<Record<Provider, ProviderCollection[]>>;
  selectedCollectionIds: Partial<Record<Provider, string>>;
  libraries: Partial<Record<Provider, TrackCollection>>;
  librarySync: Record<Provider, LibrarySyncState>;
  searchProvider: SearchProvider;
  searchQuery: string;
  searchResults: UnifiedTrack[];
  /** Search lifecycle so the page can distinguish "type to search", in-flight, and zero results. */
  searchStatus: "idle" | "loading" | "ready" | "error";
  playback: PlaybackState;
  shuffle: boolean;
  accentSource: AccentSource;
  beatIntensity: number;
  discordPresenceEnabled: boolean;
  onboardingComplete: boolean;
  soundCloudLocalProfiles: SoundCloudBrowserProfile[];
  soundCloudLocalStatus: SoundCloudLocalStatus;
  soundCloudLocalError?: SoundCloudLocalError;
  spotifyLikedTrackIds: Set<string>;
  /** Per-track audio features (tempo/loudness/genre) keyed by crossProviderKey; powers the Library
   *  mood/genre chips and the radio scorer's vibe + genre signals. */
  trackFeatures: TrackFeatureMap;
  /** Whether a background feature-enrichment pass is currently running. */
  featuresStatus: "idle" | "enriching";
  /** Local music: scanned tracks, configured folders, and scan lifecycle. */
  localTracks: UnifiedTrack[];
  localFolders: string[];
  localScanStatus: "idle" | "scanning";
  initialize(): Promise<void>;
  saveDesktopConfig(config: DesktopConfig): Promise<void>;
  reloadRuntime(): Promise<void>;
  openConfigDirectory(): Promise<void>;
  clearStoredProviderSession(provider: Provider): Promise<void>;
  clearNotice(): void;
  selectPlaylist(id?: string): void;
  selectProviderCollection(provider: Provider, collectionId: string): Promise<void>;
  connectProvider(provider: OAuthProvider): Promise<void>;
  /** Abort an in-flight provider sign-in and return the card to its disconnected state. */
  cancelConnectProvider(provider: OAuthProvider): Promise<void>;
  disconnectProvider(provider: Provider): Promise<void>;
  refreshProviderConnection(provider: Provider): Promise<ProviderConnection | undefined>;
  hydrateLibraries(force?: boolean): Promise<void>;
  search(query: string, provider?: SearchProvider): Promise<void>;
  /** Switch the search provider scope; the page's debounced effect re-runs the query. */
  setSearchProvider(provider: SearchProvider): void;
  /** Load configured folders + scan them into localTracks (called on Library mount). */
  loadLocalMusic(): Promise<void>;
  /** Open the folder picker, add the chosen folder, and rescan. */
  addLocalFolder(): Promise<void>;
  /** Remove a folder and rescan the remainder. */
  removeLocalFolder(folder: string): Promise<void>;
  /** Re-scan the configured folders for new/changed files. */
  rescanLocalMusic(): Promise<void>;
  createPlaylist(title: string): Promise<string>;
  renamePlaylist(id: string, title: string): Promise<void>;
  deletePlaylist(id: string): Promise<void>;
  addTrackToPlaylist(playlistId: string, track: UnifiedTrack): Promise<void>;
  addTracksToPlaylist(playlistId: string, tracks: UnifiedTrack[]): Promise<void>;
  /** Copy a provider collection into a local playlist. Resolves true only on real success. */
  importCollectionAsPlaylist(provider: Provider, collectionId: string, title: string): Promise<boolean>;
  removeTrackFromPlaylist(playlistId: string, entryId: string): Promise<void>;
  setSoundCloudTrackLiked(track: UnifiedTrack, liked: boolean): Promise<void>;
  setSpotifyTrackLiked(track: UnifiedTrack, liked: boolean): Promise<void>;
  reorderPlaylist(playlistId: string, orderedEntryIds: string[]): Promise<void>;
  playTrack(track: UnifiedTrack, queue?: UnifiedTrack[], source?: QueueSource): Promise<void>;
  addToQueueNext(track: UnifiedTrack): Promise<void>;
  /** Download a free SoundCloud track as MP3 to the Music/AMP folder (no-op for Spotify). */
  downloadTrack(track: UnifiedTrack): Promise<void>;
  /** Drag-to-reorder the live queue without interrupting the current track. */
  reorderQueue(fromIndex: number, toIndex: number): void;
  /** Remove one upcoming/previous track from the live queue without interrupting playback. */
  removeFromQueue(index: number): void;
  /** Clear the queue down to just the currently playing track (playback keeps going). */
  clearQueue(): void;
  /** (Re)build artist-anchored Daily Mixes for today, discovering new cross-provider tracks. */
  generateDailyMixes(force?: boolean): Promise<void>;
  /** Start a song-seeded cross-provider station and begin playing it. */
  startStation(seed: UnifiedTrack): Promise<void>;
  /** Background-enrich library tracks with Deezer tempo/loudness + provider genres (throttled). */
  enrichLibraryFeatures(): Promise<void>;
  /** Open a mix (Daily Mix, blend or station) in the detail track-list view. */
  openMix(mix: HomeMix): void;
  /** Load the artist profile (/artist route) for a track's primary artist. */
  openArtist(track: UnifiedTrack): Promise<void>;
  /** Load the album tracklist (/album route) for a Spotify track's album. */
  openAlbumForTrack(track: UnifiedTrack): Promise<void>;
  /** Load the album tracklist (/album route) by Spotify album id (artist-page album cards). */
  openAlbumById(albumId: string): Promise<void>;
  /** Open/close the right-click track context menu. */
  openTrackMenu(
    track: UnifiedTrack,
    x: number,
    y: number,
    options?: { source?: "list" | "queue"; queueIndex?: number }
  ): void;
  closeTrackMenu(): void;
  playPlaylist(id: string): Promise<void>;
  togglePlayback(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  setProviderVolume(provider: Provider, volume: number): Promise<void>;
  toggleShuffle(): void;
  setAccentSource(source: AccentSource): void;
  /** Set the beat-pulse strength for "audio" accent mode (0–2, 1 = default). */
  setBeatIntensity(value: number): void;
  setDiscordPresenceEnabled(enabled: boolean): void;
  completeOnboarding(): void;
  restartOnboarding(): Promise<void>;
  loadSoundCloudLocalProfiles(): Promise<void>;
  /** Universal connect: sign into SoundCloud in the user's real browser (DataDome-safe, any OS). */
  connectSoundCloudViaBrowser(): Promise<void>;
  connectSoundCloudLocalProfile(profileId: string): Promise<void>;
  openSoundCloudLocalSignin(profileId: string): Promise<boolean>;
  closeSoundCloudLocalBrowser(profileId: string): Promise<void>;
}

const queueEngine = new QueueEngine();
const providerNames: Record<Provider, string> = {
  spotify: "Spotify",
  soundcloud: "SoundCloud",
  youtube: "YouTube",
  local: "Local"
};

const directSoundCloudProfileSources = new Set(["web-session", "local-connect"]);

function isDirectSoundCloudProfileConnection(connection: ProviderConnection | undefined): boolean {
  return (
    connection?.provider === "soundcloud" &&
    connection.status === "connected" &&
    directSoundCloudProfileSources.has(connection.metadata?.source ?? "")
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getPlaybackRequirementMessage(
  track: UnifiedTrack,
  connection: ProviderConnection | undefined
): string | undefined {
  if (track.provider === "spotify") {
    // Preview mode allows playback without OAuth connection.
    // Full playback requires OAuth + Premium.
    if (connection?.status === "connected" && connection.requiresPremium) {
      return "Spotify connected, but in-app Spotify playback still requires a Premium account.";
    }

    return undefined;
  }

  return undefined;
}

const emptyLibrarySync = (): Record<Provider, LibrarySyncState> => ({
  spotify: { syncing: false, importedCount: 0 },
  soundcloud: { syncing: false, importedCount: 0 },
  youtube: { syncing: false, importedCount: 0 },
  local: { syncing: false, importedCount: 0 }
});

// The OAuth/library-sync providers. Local + YouTube have no remote library to hydrate, so they are
// deliberately NOT in this list — their tracks come from the local scanner / live search instead.
const providers: OAuthProvider[] = ["spotify", "soundcloud"];

function getTrackKey(track: Pick<UnifiedTrack, "provider" | "providerTrackId" | "id">): string {
  return `${track.provider}:${track.providerTrackId || track.id}`;
}

function getProjectTrackKey(projectTrack: Pick<ProjectTrack, "provider" | "providerTrackId">): string {
  return `${projectTrack.provider}:${projectTrack.providerTrackId}`;
}

/** SoundCloud "artist page" = the uploader's user page; derive it from the track permalink. */
function soundCloudUserUrlFromTrack(track: UnifiedTrack): string | undefined {
  if (!track.externalUrl) {
    return undefined;
  }
  try {
    const url = new URL(track.externalUrl);
    const [user] = url.pathname.split("/").filter(Boolean);
    return user ? `${url.origin}/${user}` : undefined;
  } catch {
    return undefined;
  }
}

function dedupeTracks(tracks: UnifiedTrack[]): UnifiedTrack[] {
  const lookup = new Map<string, UnifiedTrack>();
  for (const track of tracks) {
    const key = track.projectTrackId ?? getTrackKey(track);
    if (!lookup.has(key)) {
      lookup.set(key, track);
    }
  }
  return [...lookup.values()];
}

function findQueueTrackIndex(queue: UnifiedTrack[], track: UnifiedTrack): number {
  const exactIndex = queue.findIndex(
    (item) =>
      item.id === track.id ||
      (track.projectTrackId !== undefined && item.projectTrackId === track.projectTrackId)
  );
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const providerIndex = queue.findIndex(
    (item) => item.provider === track.provider && item.providerTrackId === track.providerTrackId
  );
  return Math.max(0, providerIndex);
}

/** Fisher-Yates shuffle into a new array, used when the shuffle toggle is on. */
function shuffleTracks(tracks: UnifiedTrack[]): UnifiedTrack[] {
  const out = [...tracks];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sortProjectTracks(projectTracks: ProjectTrack[]): ProjectTrack[] {
  return [...projectTracks].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

function mergeProjectTrackLists(current: ProjectTrack[], incoming: ProjectTrack[]): ProjectTrack[] {
  const lookup = new Map<string, ProjectTrack>();
  for (const projectTrack of current) {
    lookup.set(getProjectTrackKey(projectTrack), projectTrack);
  }
  for (const projectTrack of incoming) {
    lookup.set(getProjectTrackKey(projectTrack), projectTrack);
  }
  return sortProjectTracks([...lookup.values()]);
}

function buildLibrarySyncState(
  projectTracks: ProjectTrack[],
  previous: Record<Provider, LibrarySyncState>
): Record<Provider, LibrarySyncState> {
  const next = emptyLibrarySync();

  for (const provider of ["spotify", "soundcloud"] as Provider[]) {
    const providerTracks = projectTracks.filter((item) => item.provider === provider);
    next[provider] = {
      syncing: previous[provider].syncing,
      importedCount: providerTracks.length,
      lastImportedAt: providerTracks[0]?.updatedAt ?? previous[provider].lastImportedAt
    };
  }

  return next;
}

function getDefaultProviderCollectionId(provider: Provider): string {
  return provider === "spotify" ? "saved-tracks" : "likes";
}

function getDefaultProviderCollectionKind(provider: Provider): ProviderCollection["kind"] {
  return provider === "spotify" ? "saved-tracks" : "likes";
}

function getDefaultProviderCollectionTitle(provider: Provider): string {
  return provider === "spotify" ? "Liked Songs" : "Liked tracks";
}

function getFallbackProviderLibraryState(
  provider: Provider,
  projectTracks: ProjectTrack[],
  connection: ProviderConnection
): {
  library?: TrackCollection;
  collections: ProviderCollection[];
  selectedCollectionId?: string;
} {
  const defaultCollectionId = getDefaultProviderCollectionId(provider);
  const defaultCollectionKind = getDefaultProviderCollectionKind(provider);
  // The Library shows your SAVED collection only — Spotify Liked Songs / SoundCloud Likes — not
  // every track you happened to play or search. Those come in with other sources.
  const savedSources: ProjectTrackSource[] = ["library-sync", "legacy-migration"];
  const importedTracks = dedupeTracks(
    projectTracks
      .filter((item) => item.provider === provider && savedSources.includes(item.source))
      .map((item) => item.track)
  );

  if (importedTracks.length > 0) {
    const title = getDefaultProviderCollectionTitle(provider);
    return {
      selectedCollectionId: defaultCollectionId,
      collections: [
        {
          id: defaultCollectionId,
          provider,
          kind: defaultCollectionKind,
          title,
          trackCount: importedTracks.length
        }
      ],
      library: {
        id: defaultCollectionId,
        provider,
        kind: defaultCollectionKind,
        title,
        items: importedTracks
      }
    };
  }

  // Honest empty state: when a provider isn't connected (or returned nothing),
  // show no tracks rather than fabricating a "sample library" of songs the user
  // never saved or liked.
  return {
    collections: [],
    selectedCollectionId: undefined,
    library: undefined
  };
}

function buildFallbackLibraryState(
  projectTracks: ProjectTrack[],
  connections: Record<Provider, ProviderConnection>
): {
  libraries: Partial<Record<Provider, TrackCollection>>;
  providerCollections: Partial<Record<Provider, ProviderCollection[]>>;
  selectedCollectionIds: Partial<Record<Provider, string>>;
} {
  const libraries: Partial<Record<Provider, TrackCollection>> = {};
  const providerCollections: Partial<Record<Provider, ProviderCollection[]>> = {};
  const selectedCollectionIds: Partial<Record<Provider, string>> = {};

  for (const provider of providers) {
    const fallback = getFallbackProviderLibraryState(
      provider,
      projectTracks,
      connections[provider]
    );
    providerCollections[provider] = fallback.collections;
    libraries[provider] = fallback.library;
    if (fallback.selectedCollectionId) {
      selectedCollectionIds[provider] = fallback.selectedCollectionId;
    }
  }

  return {
    libraries,
    providerCollections,
    selectedCollectionIds
  };
}

function getDefaultSearchResults(_projectTracks: ProjectTrack[]): UnifiedTrack[] {
  // With no query, show nothing (the Search page prompts you to type) instead of a mix of
  // imported tracks — which previously leaked Spotify songs onto the SoundCloud tab.
  return [];
}

export const useAppStore = create<AppState>((set, get) => {
  let playbackReady = false;
  let activeSearchRequest = 0;
  // Same stale-response discipline as search(): the most recently opened artist/album wins no
  // matter which network call settles last (rapid "Go to artist" clicks must never flip back).
  let activeArtistRequest = 0;
  let activeAlbumRequest = 0;
  let activePlayRequest = 0;
  const providerSessionGeneration: Record<Provider, number> = {
    spotify: 0,
    soundcloud: 0,
    youtube: 0,
    local: 0
  };
  const providerCollectionRequest: Record<Provider, number> = {
    spotify: 0,
    soundcloud: 0,
    youtube: 0,
    local: 0
  };
  let lastLibraryHydrateSignature = "";
  let spotifyAdapter: SpotifyBaseAdapter | null = null;
  let soundCloudAdapter: SoundCloudPlaybackAdapter | null = null;
  let youTubeAdapter: YouTubeIframeAdapter | null = null;
  let localAdapter: HtmlAudioAdapter | null = null;
  // A play qualifies for history only after meaningful listening, not on the adapter's first
  // "playing" event. Position deltas ignore seeks and survive pause/resume.
  let statsTrackKey = "";
  let statsQueueIndex = -1;
  let statsListenedMs = 0;
  let statsLastPositionMs = 0;
  let statsPlayLogged = false;
  // In-flight guards: `force` may bypass the freshness check but never overlaps a running build.
  let dailyMixesBuilding = false;
  let stationRequestId = 0;

  const persistPlaylist = async (playlist: UnifiedPlaylist) => {
    await upsertPlaylist(playlist);
    const playlists = get().playlists.filter((item) => item.id !== playlist.id);
    set({ playlists: [playlist, ...playlists] });
  };

  const playlistMutationQueues = new Map<string, Promise<unknown>>();
  const runPlaylistMutation = async <T>(playlistId: string, mutation: () => Promise<T>): Promise<T | undefined> => {
    const previous = playlistMutationQueues.get(playlistId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(mutation);
    playlistMutationQueues.set(playlistId, run);
    try {
      return await run;
    } catch (error) {
      set({ notice: getErrorMessage(error, "Could not save the playlist change.") });
      return undefined;
    } finally {
      if (playlistMutationQueues.get(playlistId) === run) {
        playlistMutationQueues.delete(playlistId);
      }
    }
  };

  const syncDesktopRuntime = async () => {
    const [runtime, desktopConfig] = await Promise.all([getRuntimeInfo(), getDesktopConfig()]);
    set({ runtime, desktopConfig });
    return { runtime, desktopConfig };
  };

  const loadLocalState = async (): Promise<LoadedState> => {
    const [playlists, recentTracks, connections, projectTracks] = await Promise.all([
      loadPlaylists(),
      loadRecentTracks(),
      loadProviderConnections(),
      loadProjectTracks()
    ]);

    return {
      playlists,
      recentTracks: dedupeTracks(recentTracks),
      connections,
      projectTracks: sortProjectTracks(projectTracks)
    };
  };

  const applyLoadedState = (loadedState: LoadedState) => {
    const fallbackLibraryState = buildFallbackLibraryState(
      loadedState.projectTracks,
      loadedState.connections
    );
    set((state) => ({
      selectedPlaylistId: loadedState.playlists.some((playlist) => playlist.id === state.selectedPlaylistId)
        ? state.selectedPlaylistId
        : undefined,
      playlists: loadedState.playlists,
      recentTracks: loadedState.recentTracks,
      connections: loadedState.connections,
      projectTracks: loadedState.projectTracks,
      libraries: fallbackLibraryState.libraries,
      providerCollections: fallbackLibraryState.providerCollections,
      selectedCollectionIds: fallbackLibraryState.selectedCollectionIds,
      librarySync: buildLibrarySyncState(loadedState.projectTracks, state.librarySync),
      searchResults:
        state.searchQuery.trim().length > 0
          ? state.searchResults
          : getDefaultSearchResults(loadedState.projectTracks)
    }));
  };

  const commitProjectTracks = (incoming: ProjectTrack[], replace = false) => {
    let nextProjectTracks: ProjectTrack[] = [];
    set((state) => {
      nextProjectTracks = replace
        ? sortProjectTracks(incoming)
        : mergeProjectTrackLists(state.projectTracks, incoming);

      const nextLibraries = { ...state.libraries };
      const nextProviderCollections = { ...state.providerCollections };
      const nextSelectedCollectionIds = { ...state.selectedCollectionIds };

      for (const provider of providers) {
        const shouldUseFallback =
          state.connections[provider].status !== "connected" ||
          (state.providerCollections[provider]?.length ?? 0) === 0;

        if (!shouldUseFallback) {
          continue;
        }

        const fallback = getFallbackProviderLibraryState(
          provider,
          nextProjectTracks,
          state.connections[provider]
        );

        nextLibraries[provider] = fallback.library;
        nextProviderCollections[provider] = fallback.collections;

        if (fallback.selectedCollectionId) {
          nextSelectedCollectionIds[provider] = fallback.selectedCollectionId;
        } else {
          delete nextSelectedCollectionIds[provider];
        }
      }

      return {
        projectTracks: nextProjectTracks,
        libraries: nextLibraries,
        providerCollections: nextProviderCollections,
        selectedCollectionIds: nextSelectedCollectionIds,
        librarySync: buildLibrarySyncState(nextProjectTracks, state.librarySync),
        searchResults:
          state.searchQuery.trim().length > 0
            ? state.searchResults
            : getDefaultSearchResults(nextProjectTracks)
      };
    });
    return nextProjectTracks;
  };

  const ensurePlayback = () => {
    if (playbackReady) {
      return;
    }

    const initialVolume = loadVolume();
    const initialProviderVolumes = loadProviderVolumes();

    spotifyAdapter = createSpotifyAdapter({
      getConnection: () => get().connections.spotify,
      refreshConnection: () => get().refreshProviderConnection("spotify"),
      initialVolume: initialVolume * initialProviderVolumes.spotify,
      onConnectionIssue: (issue, patch) => {
        set((state) => ({
          notice: issue,
          connections: {
            ...state.connections,
            spotify: {
              ...state.connections.spotify,
              ...patch,
              issue
            }
          }
        }));
      }
    });

    soundCloudAdapter = new SoundCloudPlaybackAdapter({
      getConnection: () => get().connections.soundcloud,
      refreshConnection: () => get().refreshProviderConnection("soundcloud"),
      initialVolume: initialVolume * initialProviderVolumes.soundcloud,
      onConnectionIssue: (issue, patch) => {
        set((state) => ({
          notice: issue,
          connections: {
            ...state.connections,
            soundcloud: {
              ...state.connections.soundcloud,
              ...patch,
              issue
            }
          }
        }));
      }
    });

    youTubeAdapter = new YouTubeIframeAdapter(initialVolume * initialProviderVolumes.youtube);
    localAdapter = createLocalAdapter(initialVolume * initialProviderVolumes.local);

    queueEngine.registerAdapter(spotifyAdapter);
    queueEngine.registerAdapter(soundCloudAdapter);
    queueEngine.registerAdapter(youTubeAdapter);
    queueEngine.registerAdapter(localAdapter);
    queueEngine.subscribe((playback) => {
      set((state) => ({
        playback,
        notice:
          playback.lastError && playback.lastError !== state.playback.lastError
            ? playback.lastError
            : state.notice
      }));

      // Listening stats + Recently played, recorded when a track ACTUALLY starts playing. Living
      // here (not in playTrack) means queue auto-advance and next/previous skips count too —
      // logging only manual plays badly undercounted top artists/tracks.
      const current = playback.queue[playback.currentIndex];
      if (current) {
        const key = getTrackKey(current);
        if (key !== statsTrackKey || playback.currentIndex !== statsQueueIndex) {
          statsTrackKey = key;
          statsQueueIndex = playback.currentIndex;
          statsListenedMs = 0;
          statsLastPositionMs = playback.positionMs;
          statsPlayLogged = false;
        }

        if (playback.status === "playing") {
          const positionDelta = playback.positionMs - statsLastPositionMs;
          if (positionDelta > 0 && positionDelta <= 5_000) {
            statsListenedMs += positionDelta;
          }
          statsLastPositionMs = playback.positionMs;
        }

        const qualifiedAtMs =
          playback.durationMs > 0 ? Math.min(30_000, playback.durationMs * 0.5) : 30_000;
        if (!statsPlayLogged && statsListenedMs >= qualifiedAtMs) {
          statsPlayLogged = true;
          recordPlay(current);
          const nextRecentTracks = dedupeTracks([current, ...get().recentTracks]).slice(0, 12);
          set({ recentTracks: nextRecentTracks });
          void replaceRecentTracks(nextRecentTracks);
        }
      }
    });

    // Seed the engine with the saved master volume and provider trims. The engine re-applies the
    // effective value to whichever adapter becomes active on the first play.
    void queueEngine.setProviderVolume("spotify", initialProviderVolumes.spotify);
    void queueEngine.setProviderVolume("soundcloud", initialProviderVolumes.soundcloud);
    void queueEngine.setVolume(initialVolume);

    playbackReady = true;
  };

  const getProviderAdapter = (provider: Provider) =>
    provider === "spotify" ? spotifyAdapter : soundCloudAdapter;

  const applyFallbackStateForProvider = (
    provider: Provider,
    connections = get().connections,
    projectTracks = get().projectTracks
  ) => {
    const fallback = getFallbackProviderLibraryState(
      provider,
      projectTracks,
      connections[provider]
    );

    set((state) => {
      const nextSelectedCollectionIds = { ...state.selectedCollectionIds };
      if (fallback.selectedCollectionId) {
        nextSelectedCollectionIds[provider] = fallback.selectedCollectionId;
      } else {
        delete nextSelectedCollectionIds[provider];
      }

      return {
        libraries: {
          ...state.libraries,
          [provider]: fallback.library
        },
        providerCollections: {
          ...state.providerCollections,
          [provider]: fallback.collections
        },
        selectedCollectionIds: nextSelectedCollectionIds
      };
    });
  };

  const loadProviderCollection = async (provider: Provider, collectionId: string, requestId: number) => {
    const adapter = getProviderAdapter(provider);
    const sessionGeneration = providerSessionGeneration[provider];
    if (!adapter) {
      if (requestId === providerCollectionRequest[provider]) {
        applyFallbackStateForProvider(provider);
      }
      return;
    }

    const collection = await adapter.getCollectionTracks(collectionId);
    if (
      requestId !== providerCollectionRequest[provider] ||
      sessionGeneration !== providerSessionGeneration[provider]
    ) {
      return;
    }
    const importedTracks = await ingestTracks(collection.items, "library-sync");
    if (
      requestId !== providerCollectionRequest[provider] ||
      sessionGeneration !== providerSessionGeneration[provider]
    ) {
      return;
    }

    set((state) => ({
      libraries: {
        ...state.libraries,
        [provider]: {
          ...collection,
          items: importedTracks
        }
      },
      providerCollections: {
        ...state.providerCollections,
        [provider]: (state.providerCollections[provider] ?? []).map((item) =>
          item.id === collectionId
            ? {
                // Keep the real provider total (e.g. 2,399 liked songs) — don't replace it
                // with how many we've loaded into view.
                ...item,
                artworkUrl: collection.artworkUrl ?? item.artworkUrl,
                description: collection.description ?? item.description,
                externalUrl: collection.externalUrl ?? item.externalUrl,
                ownerName: collection.ownerName ?? item.ownerName
              }
            : item
        )
      },
      selectedCollectionIds: {
        ...state.selectedCollectionIds,
        [provider]: collectionId
      }
    }));
  };

  const getMissingProviderConfigurationMessage = (
    provider: OAuthProvider,
    runtime?: RuntimeInfo
  ): string | undefined => {
    if (!runtime || runtime.platform === "browser") {
      return undefined;
    }

    if (!runtime.oauth[provider].configured) {
      return runtime.oauth[provider].message;
    }

    return undefined;
  };

  const restoreProviderSessions = async () => {
    for (const provider of providers) {
      const shouldAttemptRestore =
        get().runtime?.oauth[provider].hasStoredSession ||
        get().connections[provider].status === "connected";
      if (!shouldAttemptRestore) {
        continue;
      }

      const restored = await get().refreshProviderConnection(provider);
      if (!restored?.accessToken) {
        const nextConnections = {
          ...get().connections,
          [provider]: {
            ...createDefaultConnections()[provider],
            issue: get().connections[provider].issue
          }
        };
        set({ connections: nextConnections });
        applyFallbackStateForProvider(provider, nextConnections, get().projectTracks);
      }
    }
  };

  const ensureProjectTrack = async (
    track: UnifiedTrack,
    source: ProjectTrackSource
  ): Promise<UnifiedTrack> => {
    // YouTube + local tracks are ephemeral: never persist them into projectTracks. That pool seeds
    // Daily Mixes / stations and the Library "liked" view — persisting a searched YouTube result or
    // a scanned local file (which is rebuilt from disk each launch) would pollute it with entries
    // that can't be enriched or re-searched and go stale when a folder is removed. Playlists still
    // work: they store the track snapshot inline, independent of projectTracks.
    if (track.provider === "youtube" || track.provider === "local") {
      return track;
    }
    if (track.projectTrackId) {
      return track;
    }

    const lookupKey = getTrackKey(track);
    const existing = get().projectTracks.find((item) => getProjectTrackKey(item) === lookupKey);
    if (existing) {
      return existing.track;
    }

    const projectTrack = await upsertProjectTrack(track, source);
    commitProjectTracks([projectTrack]);
    return projectTrack.track;
  };

  /** Fetch a Spotify album and publish it as the active /album view. Throws on failure. */
  const loadAlbumIntoView = async (albumId: string, requestId: number) => {
    const spotify = spotifyAdapter;
    if (!spotify || get().connections.spotify.status !== "connected") {
      throw new Error("Connect Spotify to browse albums.");
    }
    const detail = await spotify.getAlbumWithTracks(albumId);
    if (requestId !== activeAlbumRequest) {
      return;
    }
    set({
      activeAlbum: {
        status: "ready",
        provider: "spotify",
        id: detail.id,
        name: detail.name,
        artistNames: detail.artistNames,
        imageUrl: detail.imageUrl,
        releaseYear: detail.releaseYear,
        tracks: detail.tracks
      }
    });
  };

  const ingestTracks = async (
    tracks: UnifiedTrack[],
    source: ProjectTrackSource
  ): Promise<UnifiedTrack[]> => {
    if (tracks.length === 0) {
      return [];
    }

    const uniqueTracks = dedupeTracks(tracks);
    const incomingProjectTracks = await upsertProjectTracks(uniqueTracks, source);
    const lookup = new Map(
      incomingProjectTracks.map((projectTrack) => [getProjectTrackKey(projectTrack), projectTrack.track])
    );
    const mergedProjectTracks = commitProjectTracks(incomingProjectTracks);
    const mergedLookup = new Map(
      mergedProjectTracks.map((projectTrack) => [getProjectTrackKey(projectTrack), projectTrack.track])
    );

    return tracks.map((track) => {
      const key = getTrackKey(track);
      return lookup.get(key) ?? mergedLookup.get(key) ?? track;
    });
  };

  // Shared by both SoundCloud sign-in paths (public profile URL + web session): ingest the
  // returned tracks into the library and mark SoundCloud connected.
  const applySoundCloudProfile = async (
    profile: {
      displayName: string;
      likes?: UnifiedTrack[];
      uploads?: UnifiedTrack[];
      playlists?: ProviderCollection[];
      subscriptionTier?: "unknown" | "free" | "go" | "go-plus";
    },
    options: {
      source: "web-session" | "local-connect";
      profileUrl?: string;
      notify?: boolean;
      connection?: ProviderOAuthResult;
      stats?: {
        likesCount?: number;
        playlistsCount?: number;
        lastSyncedAt?: string;
      };
      sessionGeneration?: number;
    }
  ) => {
    const likeTracks = profile.likes ?? [];

    // Only likes go into the library — not the profile's own uploads — so the Library tab is
    // strictly your liked songs.
    const importedLikes = await ingestTracks(likeTracks, "library-sync");

    const likesTitle = "Liked tracks";
    const likesCollection: ProviderCollection = {
      id: "likes",
      provider: "soundcloud",
      kind: "likes",
      title: likesTitle,
      trackCount: likeTracks.length
    };
    // The resolved profile carries the user's playlists too (it's even counted into
    // playlistsCount metadata below) — but they were being dropped here, so SoundCloud playlists
    // never appeared to browse/import. Surface them alongside Likes as selectable collections.
    const playlistCollections = (profile.playlists ?? []).filter(
      (collection) => collection.id !== "likes"
    );
    const library: TrackCollection = {
      id: "likes",
      provider: "soundcloud",
      kind: "likes",
      title: likesTitle,
      items: importedLikes
    };
    const now = new Date().toISOString();
    const connectionMetadata = options.connection?.metadata ?? {};
    const statsMetadata = {
      likesCount: String(options.stats?.likesCount ?? likeTracks.length),
      playlistsCount: String(options.stats?.playlistsCount ?? profile.playlists?.length ?? 0),
      lastSyncedAt: options.stats?.lastSyncedAt ?? connectionMetadata.lastSyncedAt ?? now
    };

    if (
      options.sessionGeneration !== undefined &&
      options.sessionGeneration !== providerSessionGeneration.soundcloud
    ) {
      return false;
    }

    set((current) => ({
      connections: {
        ...current.connections,
        soundcloud: {
          provider: "soundcloud",
          status: "connected",
          accessToken: options.connection?.accessToken,
          expiresAt: options.connection?.expiresAt,
          displayName: options.connection?.displayName ?? profile.displayName,
          connectedAt: options.connection?.connectedAt ?? now,
          requiresPremium: options.connection?.requiresPremium,
          subscriptionTier: profile.subscriptionTier ?? options.connection?.subscriptionTier,
          sessionSource: options.connection?.sessionSource ?? "memory",
          storageMode: options.connection?.storageMode ?? "none",
          metadata: {
            ...connectionMetadata,
            source: options.source,
            ...statsMetadata,
            ...(options.profileUrl ? { profileUrl: options.profileUrl } : {})
          },
          issue: undefined
        }
      },
      providerCollections: {
        ...current.providerCollections,
        soundcloud: [likesCollection, ...playlistCollections]
      },
      libraries: {
        ...current.libraries,
        soundcloud: library
      },
      selectedCollectionIds: {
        ...current.selectedCollectionIds,
        soundcloud: "likes"
      },
      notice:
        options.notify === false
          ? current.notice
          : `Loaded ${likeTracks.length} liked track${likeTracks.length === 1 ? "" : "s"} from SoundCloud.`
    }));
    return true;
  };

  const setSoundCloudConnecting = () => {
    set((current) => ({
      connections: {
        ...current.connections,
        soundcloud: { ...current.connections.soundcloud, status: "connecting", issue: undefined }
      },
      notice: undefined
    }));
  };

  const setSoundCloudError = (error: unknown, fallback: string) => {
    set((current) => ({
      connections: {
        ...current.connections,
        soundcloud: {
          ...createDefaultConnections().soundcloud,
          status: "error",
          issue: error instanceof Error ? error.message : fallback
        }
      },
      notice: error instanceof Error ? error.message : fallback
    }));
  };

  const restoreSoundCloudLibrary = async () => {
    const currentConnection = get().connections.soundcloud;
    if (
      currentConnection.status === "connected" &&
      currentConnection.metadata?.source === "local-connect" &&
      currentConnection.accessToken
    ) {
      const profile = await gatewayRequest<{
        displayName: string;
        likes: UnifiedTrack[];
        uploads: UnifiedTrack[];
        playlists: ProviderCollection[];
      }>({
        provider: "soundcloud",
        operation: "resolveAuthenticatedProfile",
        variables: { oauthToken: currentConnection.accessToken }
      });
      if (profile.ok && profile.data) {
        const lastSyncedAt = new Date().toISOString();
        await applySoundCloudProfile(profile.data, {
          source: "local-connect",
          notify: false,
          connection: {
            provider: "soundcloud",
            accessToken: currentConnection.accessToken,
            expiresAt: currentConnection.expiresAt,
            displayName: currentConnection.displayName,
            requiresPremium: currentConnection.requiresPremium,
            metadata: {
              ...currentConnection.metadata,
              likesCount: String(profile.data.likes.length),
              playlistsCount: String(profile.data.playlists.length),
              lastSyncedAt
            },
            connectedAt: currentConnection.connectedAt ?? lastSyncedAt,
            sessionSource: currentConnection.sessionSource ?? "local",
            storageMode: currentConnection.storageMode ?? "local-secure"
          },
          stats: {
            likesCount: profile.data.likes.length,
            playlistsCount: profile.data.playlists.length,
            lastSyncedAt
          }
        });
      }
      return;
    }

    if (currentConnection.status === "connected") {
      return;
    }

    try {
      const web = await soundCloudWebReload();
      if (web.ok && web.data) {
        await applySoundCloudProfile(web.data, { source: "web-session", notify: false });
      }
    } catch {
      // No stored web session — the user connects via browser sign-in or Local Connect instead.
    }
  };

  return {
    initialized: false,
    initializing: false,
    initializationError: undefined,
    bootStage: "Starting AMP",
    bootProgress: 0,
    desktopConfig: {
      spotifyClientId: "",
      soundCloudClientId: "",
      soundCloudClientSecret: "",
      soundCloudClientSecretConfigured: false
    },
    connections: createDefaultConnections(),
    projectTracks: [],
    playlists: [],
    recentTracks: [],
    dailyMixes: [],
    dailyMixesDate: undefined,
    dailyMixesLibraryFingerprint: undefined,
    mixesStatus: "idle",
    activeMix: undefined,
    trackMenu: undefined,
    ...buildFallbackLibraryState([], createDefaultConnections()),
    librarySync: emptyLibrarySync(),
    searchProvider: "all",
    searchQuery: "",
    searchResults: [],
    searchStatus: "idle",
    playback: createEmptyPlaybackState(),
    shuffle: loadShuffle(),
    accentSource: loadAccentSource(),
    beatIntensity: loadBeatIntensity(),
    discordPresenceEnabled: loadDiscordPresenceEnabled(),
    onboardingComplete: loadOnboardingComplete() === true,
    soundCloudLocalProfiles: [],
    soundCloudLocalStatus: "idle",
    soundCloudLocalError: undefined,
    spotifyLikedTrackIds: new Set<string>(),
    trackFeatures: loadTrackFeatures(),
    featuresStatus: "idle",
    localTracks: [],
    localFolders: [],
    localScanStatus: "idle",

    async initialize() {
      if (get().initializing || get().initialized) {
        return;
      }

      set({
        initializing: true,
        initializationError: undefined,
        bootStage: "Starting AMP",
        bootProgress: 0.06
      });
      ensurePlayback();
      let initializationSucceeded = false;

      try {
        set({ bootStage: "Connecting to desktop runtime", bootProgress: 0.18 });
        await syncDesktopRuntime();
        set({ bootStage: "Loading your library", bootProgress: 0.38 });
        const loadedState = await loadLocalState();
        applyLoadedState(loadedState);
        set({ bootStage: "Restoring provider sessions", bootProgress: 0.58 });
        await restoreProviderSessions();
        set({ bootStage: "Syncing Spotify & SoundCloud", bootProgress: 0.78 });
        await get().hydrateLibraries(true);
        set({ bootStage: "Loading your SoundCloud likes", bootProgress: 0.92 });
        await restoreSoundCloudLibrary();
        set({ bootStage: "Ready", bootProgress: 1 });
        initializationSucceeded = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "AMP failed to initialize.";
        set({
          notice: message,
          initializationError: message
        });
      } finally {
        // First-run detection (tri-state flag). true = already finished setup → main app. false =
        // user chose Start over → keep showing setup until they finish it, even across relaunches.
        // undefined = never set → only guide brand-new installs; anyone who already connected a
        // provider, imported tracks, or made a playlist has used AMP before, so auto-skip them
        // (and remember it) instead of sending them back through onboarding after an update.
        const state = get();
        const storedOnboarding = loadOnboardingComplete();
        const hasPriorUse =
          state.connections.spotify.status === "connected" ||
          state.connections.soundcloud.status === "connected" ||
          state.projectTracks.length > 0 ||
          state.playlists.length > 0 ||
          Boolean(state.runtime?.oauth.spotify.hasStoredSession) ||
          Boolean(state.runtime?.oauth.soundcloud.hasStoredSession);
        const onboardingComplete =
          storedOnboarding === true ? true : storedOnboarding === false ? false : hasPriorUse;
        if (onboardingComplete && storedOnboarding === undefined) {
          saveOnboardingComplete(true);
        }
        set({
          initialized: initializationSucceeded,
          initializing: false,
          onboardingComplete
        });
      }
    },

    async saveDesktopConfig(config) {
      const savedConfig = await saveDesktopConfigBridge(config);
      const runtime = await reloadDesktopRuntime();

      set({
        desktopConfig: savedConfig,
        runtime,
        notice: "Desktop config saved. Provider sign-in updates are ready immediately."
      });
    },

    async reloadRuntime() {
      const runtime = await reloadDesktopRuntime();
      const desktopConfig = await getDesktopConfig();
      set({
        runtime,
        desktopConfig,
        notice: "Runtime status refreshed."
      });
    },

    async openConfigDirectory() {
      await openConfigDirectoryBridge();
    },

    async clearStoredProviderSession(provider) {
      await clearStoredProviderSessionBridge(provider);
      const runtime = await reloadDesktopRuntime();
      set((state) => ({
        runtime,
        connections: {
          ...state.connections,
          [provider]:
            state.connections[provider].status === "connected"
              ? state.connections[provider]
              : createDefaultConnections()[provider]
        },
        notice: `${providerNames[provider]} local session was cleared.`
      }));
    },

    clearNotice() {
      set({ notice: undefined });
    },

    selectPlaylist(id) {
      set({ selectedPlaylistId: id });
    },

    async selectProviderCollection(provider, collectionId) {
      const requestId = ++providerCollectionRequest[provider];
      const connection = get().connections[provider];
      if (connection.status !== "connected") {
        set((state) => ({
          selectedCollectionIds: {
            ...state.selectedCollectionIds,
            [provider]: collectionId
          }
        }));
        return;
      }

      // Profile-based SoundCloud modes already load likes directly into state. Re-select locally
      // instead of calling collection endpoints that only work with official API tokens.
      if (provider === "soundcloud" && isDirectSoundCloudProfileConnection(connection)) {
        set((state) => ({
          selectedCollectionIds: {
            ...state.selectedCollectionIds,
            soundcloud: collectionId
          }
        }));
        return;
      }

      set((state) => ({
        librarySync: {
          ...state.librarySync,
          [provider]: {
            ...state.librarySync[provider],
            syncing: true
          }
        }
      }));

      try {
        await loadProviderCollection(provider, collectionId, requestId);
      } catch (error) {
        if (requestId !== providerCollectionRequest[provider]) {
          return;
        }
        set({
          notice:
            error instanceof Error
              ? error.message
              : `${providerNames[provider]} collection could not be opened.`
        });
      } finally {
        if (requestId !== providerCollectionRequest[provider]) {
          return;
        }
        set((state) => ({
          librarySync: {
            ...state.librarySync,
            [provider]: {
              ...state.librarySync[provider],
              syncing: false
            }
          }
        }));
      }
    },

    async connectProvider(provider) {
      const sessionGeneration = ++providerSessionGeneration[provider];
      const state = get();
      const missingConfigMessage = getMissingProviderConfigurationMessage(provider, state.runtime);

      if (missingConfigMessage) {
        set((current) => ({
          connections: {
            ...current.connections,
            [provider]: {
              ...createDefaultConnections()[provider],
              status: "error",
              issue: missingConfigMessage
            }
          },
          notice: missingConfigMessage
        }));
        return;
      }

      set((current) => ({
        connections: {
          ...current.connections,
          [provider]: {
            ...current.connections[provider],
            status: "connecting",
            issue: undefined
          }
        },
        notice: undefined
      }));

      try {
        const result = await connectDesktopProvider({ provider });
        if (sessionGeneration !== providerSessionGeneration[provider]) {
          return;
        }

        const nextConnection: ProviderConnection = {
          provider,
          status: "connected",
          accessToken: result.accessToken,
          expiresAt: result.expiresAt,
          displayName: result.displayName,
          connectedAt: result.connectedAt ?? new Date().toISOString(),
          requiresPremium: result.requiresPremium,
          metadata: result.metadata,
          sessionSource: result.sessionSource,
          storageMode: result.storageMode
        };

        if (provider === "spotify") {
          spotifyAdapter?.clearAccountCaches();
          set({ spotifyLikedTrackIds: new Set() });
        }

        set((current) => {
          const nextConnections = {
            ...current.connections,
            [provider]: nextConnection
          };
          const nextSelectedCollectionIds = { ...current.selectedCollectionIds };
          delete nextSelectedCollectionIds[provider];
          return {
            connections: nextConnections,
            libraries: {
              ...current.libraries,
              [provider]: undefined
            },
            providerCollections: {
              ...current.providerCollections,
              [provider]: []
            },
            selectedCollectionIds: nextSelectedCollectionIds,
            notice:
              provider === "spotify" && result.requiresPremium
                ? "Spotify connected. Library import is ready, but in-app playback still needs Premium."
                : `${providerNames[provider]} connected. Importing your collections now.`
          };
        });

        const runtime = await reloadDesktopRuntime();
        if (sessionGeneration !== providerSessionGeneration[provider]) {
          return;
        }
        set({ runtime });
        await get().hydrateLibraries(true);
      } catch (error) {
        if (sessionGeneration !== providerSessionGeneration[provider]) {
          return;
        }
        const message = error instanceof Error ? error.message : "Connection failed.";
        // A user-cancelled sign-in isn't an error worth a red banner — just return the card to its
        // clean disconnected state so they can try again.
        const cancelled = /cancel/i.test(message);
        set((current) => ({
          connections: {
            ...current.connections,
            [provider]: cancelled
              ? createDefaultConnections()[provider]
              : {
                  ...createDefaultConnections()[provider],
                  status: "error",
                  issue: message
                }
          },
          notice: cancelled ? undefined : message
        }));
      }
    },

    async cancelConnectProvider(provider) {
      providerSessionGeneration[provider] += 1;
      providerCollectionRequest[provider] += 1;
      await cancelConnectDesktopProvider(provider);
      set((state) => ({
        connections: {
          ...state.connections,
          [provider]: createDefaultConnections()[provider]
        },
        librarySync: {
          ...state.librarySync,
          [provider]: { ...state.librarySync[provider], syncing: false }
        }
      }));
    },

    async disconnectProvider(provider) {
      providerSessionGeneration[provider] += 1;
      providerCollectionRequest[provider] += 1;
      if (get().playback.activeProvider === provider) {
        await queueEngine.pause().catch(() => undefined);
      }
      if (provider === "spotify") {
        spotifyAdapter?.clearAccountCaches();
        await spotifyAdapter?.teardown().catch(() => undefined);
        teardownSpotifyWebDevice();
      } else {
        await soundCloudAdapter?.teardown().catch(() => undefined);
      }
      try {
        if (provider === "soundcloud") {
          // If this was a legacy browser sign-in, clear that stored SoundCloud web session too.
          if (get().connections.soundcloud.metadata?.source === "web-session") {
            await soundCloudWebSignOut();
          }
        }
        await clearStoredProviderSessionBridge(provider);
        await disconnectProviderRecord(provider);
      } catch (error) {
        // Still fall through to the local disconnect below — the UI must never stay stuck
        // "connected" because an IPC hiccup kept the stored session from clearing.
        set({ notice: getErrorMessage(error, `${providerNames[provider]} session cleanup failed.`) });
      }
      const runtime = await reloadDesktopRuntime();
      const nextConnections = {
        ...get().connections,
        [provider]: createDefaultConnections()[provider]
      };

      set((state) => ({
        runtime,
        connections: nextConnections,
        ...(provider === "spotify" ? { spotifyLikedTrackIds: new Set<string>() } : {}),
        librarySync: {
          ...state.librarySync,
          [provider]: {
            ...state.librarySync[provider],
            syncing: false
          }
        },
        ...(provider === "soundcloud"
          ? {
              soundCloudLocalStatus: "idle" as const,
              soundCloudLocalError: undefined
            }
          : {}),
        notice: `${providerNames[provider]} disconnected. Imported tracks stay in AMP.`
      }));
      applyFallbackStateForProvider(provider, nextConnections, get().projectTracks);
    },

    async refreshProviderConnection(provider) {
      const sessionGeneration = providerSessionGeneration[provider];
      const refreshed = await refreshStoredProviderSession({ provider });
      if (sessionGeneration !== providerSessionGeneration[provider]) {
        return get().connections[provider];
      }

      const normalized = refreshed?.accessToken
        ? {
            provider,
            status: "connected" as const,
            accessToken: refreshed.accessToken,
            expiresAt: refreshed.expiresAt,
            displayName: refreshed.displayName,
            connectedAt: refreshed.connectedAt ?? get().connections[provider].connectedAt,
            requiresPremium: refreshed.requiresPremium,
            metadata: refreshed.metadata,
            sessionSource: refreshed.sessionSource,
            storageMode: refreshed.storageMode
          }
        : null;

      if (normalized?.accessToken) {
        set((state) => {
          const nextConnections = {
            ...state.connections,
            [provider]: {
              ...state.connections[provider],
              ...normalized,
              status: "connected" as const
            }
          };
          return {
            connections: nextConnections
          };
        });
      }

      const runtime = await reloadDesktopRuntime();
      if (sessionGeneration !== providerSessionGeneration[provider]) {
        return get().connections[provider];
      }
      set({ runtime });
      return normalized ?? get().connections[provider];
    },

    async hydrateLibraries(force = false) {
      const librarySignature = providers
        .map((provider) => {
          const connection = get().connections[provider];
          return `${provider}:${connection.status}:${connection.metadata?.source ?? ""}`;
        })
        .join("|");
      if (!force && librarySignature === lastLibraryHydrateSignature) {
        return;
      }
      lastLibraryHydrateSignature = librarySignature;
      ensurePlayback();

      for (const provider of providers) {
        const collectionRequestId = ++providerCollectionRequest[provider];
        const connection = get().connections[provider];
        set((state) => ({
          librarySync: {
            ...state.librarySync,
            [provider]: {
              ...state.librarySync[provider],
              syncing: connection.status === "connected"
            }
          }
        }));

        if (connection.status !== "connected") {
          applyFallbackStateForProvider(provider);
          set((state) => ({
            librarySync: {
              ...state.librarySync,
              [provider]: {
                ...state.librarySync[provider],
                syncing: false
              }
            }
          }));
          continue;
        }

        // Profile-based SoundCloud modes already load likes directly into state. Keep those
        // tracks instead of calling collection endpoints that only work with official API tokens.
        if (provider === "soundcloud" && isDirectSoundCloudProfileConnection(connection)) {
          set((state) => ({
            librarySync: {
              ...state.librarySync,
              soundcloud: { ...state.librarySync.soundcloud, syncing: false }
            }
          }));
          continue;
        }

        try {
          const adapter = getProviderAdapter(provider);
          if (!adapter) {
            throw new Error(`${providerNames[provider]} adapter is unavailable.`);
          }

          const collections = await adapter.getCollections();
          if (collectionRequestId !== providerCollectionRequest[provider]) {
            continue;
          }
          const currentSelection = get().selectedCollectionIds[provider];
          const nextSelection = collections.some((item) => item.id === currentSelection)
            ? currentSelection
            : collections[0]?.id;

          set((state) => {
            const nextSelectedCollectionIds = { ...state.selectedCollectionIds };
            if (nextSelection) {
              nextSelectedCollectionIds[provider] = nextSelection;
            } else {
              delete nextSelectedCollectionIds[provider];
            }

            return {
              providerCollections: {
                ...state.providerCollections,
                [provider]: collections
              },
              selectedCollectionIds: nextSelectedCollectionIds,
              libraries: {
                ...state.libraries,
                [provider]:
                  nextSelection ? state.libraries[provider] : undefined
              }
            };
          });

          if (nextSelection) {
            await loadProviderCollection(provider, nextSelection, collectionRequestId);
          }
          if (collectionRequestId !== providerCollectionRequest[provider]) {
            continue;
          }

          const importedCount = get().projectTracks.filter(
            (item) => item.provider === provider
          ).length;
          set((state) => ({
            librarySync: {
              ...state.librarySync,
              [provider]: {
                syncing: false,
                importedCount,
                lastImportedAt:
                  importedCount > 0
                    ? new Date().toISOString()
                    : state.librarySync[provider].lastImportedAt
              }
            }
          }));
        } catch (error) {
          if (collectionRequestId !== providerCollectionRequest[provider]) {
            continue;
          }
          applyFallbackStateForProvider(provider);
          set((state) => ({
            librarySync: {
              ...state.librarySync,
              [provider]: {
                ...state.librarySync[provider],
                syncing: false
              }
            },
            notice:
              error instanceof Error
                ? error.message
                : `${providerNames[provider]} collection import failed.`
          }));
        }
      }

      // Populate Spotify "Liked Songs" state for the heart toggles (non-blocking).
      if (get().connections.spotify.status === "connected" && spotifyAdapter) {
        const sessionGeneration = providerSessionGeneration.spotify;
        void spotifyAdapter
          .getSavedTrackIds()
          .then((ids) => {
            if (
              sessionGeneration === providerSessionGeneration.spotify &&
              get().connections.spotify.status === "connected"
            ) {
              set({ spotifyLikedTrackIds: new Set(ids.map((id) => `spotify:${id}`)) });
            }
          })
          .catch(() => undefined);
      }
    },

    async search(query, provider = get().searchProvider) {
      ensurePlayback();
      const trimmedQuery = query.trim();
      const requestId = ++activeSearchRequest;
      set({ searchQuery: query, searchProvider: provider });

      if (!trimmedQuery) {
        if (requestId === activeSearchRequest) {
          set({
            searchResults: getDefaultSearchResults(get().projectTracks),
            searchStatus: "idle"
          });
        }
        return;
      }

      set({ searchStatus: "loading", searchResults: [] });
      // Live network providers to query. Local files aren't a network target — they're matched
      // from the already-scanned library below (offline, instant).
      const networkTargets: Provider[] =
        provider === "all"
          ? ([
              ...(get().connections.spotify.status === "connected" ? (["spotify"] as Provider[]) : []),
              "soundcloud",
              "youtube"
            ] as Provider[])
          : provider === "local"
            ? []
            : [provider];
      const includeLocal = provider === "all" || provider === "local";

      const catalogProviders: Provider[] = provider === "all" ? ["spotify", "soundcloud"] : [provider];
      const catalogResults = dedupeTracks(
        get()
          .projectTracks.filter((item) => catalogProviders.includes(item.provider))
          .map((item) => item.track)
          .filter((track) => isTrackMatch(track, trimmedQuery))
      );

      const localResults = includeLocal
        ? get().localTracks.filter((track) => isTrackMatch(track, trimmedQuery))
        : [];

      const results: UnifiedTrack[] = [...localResults];
      let failedTargets = 0;

      const adapterFor = (target: Provider) =>
        target === "spotify"
          ? spotifyAdapter
          : target === "soundcloud"
            ? soundCloudAdapter
            : target === "youtube"
              ? youTubeAdapter
              : null;

      // Providers are independent; running them concurrently keeps all-provider search latency at
      // the slowest provider instead of the sum of Spotify + SoundCloud + YouTube.
      const providerSearches = await Promise.allSettled(
        networkTargets.map(async (target) => {
          const adapter = adapterFor(target);
          if (!adapter) {
            throw new Error(`${providerNames[target]} search isn't available right now.`);
          }
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const tracks = await Promise.race([
              adapter.search(trimmedQuery),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error(`${providerNames[target]} search timed out. Try again.`)),
                  10_000
                );
              })
            ]);
            return { target, tracks: tracks ?? [] };
          } finally {
            if (timeout) {
              clearTimeout(timeout);
            }
          }
        })
      );

      if (requestId !== activeSearchRequest) {
        return;
      }

      const liveResults: UnifiedTrack[] = [];
      let lastSearchError: string | undefined;
      for (let index = 0; index < providerSearches.length; index += 1) {
        const outcome = providerSearches[index];
        if (outcome.status === "rejected") {
          failedTargets += 1;
          lastSearchError =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : `${providerNames[networkTargets[index]]} search failed. No results to show.`;
          continue;
        }
        liveResults.push(...outcome.value.tracks);
      }

      if (requestId !== activeSearchRequest) {
        return;
      }
      // Search is read-only discovery. Persist a result only when the user plays, likes, or saves it;
      // otherwise arbitrary queries overwrite library provenance and bloat local storage.
      results.push(...liveResults, ...catalogResults.slice(0, 50));
      if (lastSearchError) {
        set({ notice: lastSearchError });
      }

      if (requestId === activeSearchRequest) {
        const deduped = dedupeTracks(results).slice(0, 200);
        set({
          searchResults: deduped,
          // "error" only when every network provider failed AND nothing matched at all — partial
          // results (or offline local hits) still count as a successful search.
          searchStatus:
            networkTargets.length > 0 && failedTargets === networkTargets.length && deduped.length === 0
              ? "error"
              : "ready"
        });
      }
    },

    async loadLocalMusic() {
      if (get().localScanStatus === "scanning") {
        return;
      }
      set({ localScanStatus: "scanning" });
      try {
        const folders = await listLocalMusicFolders();
        set({ localFolders: folders });
        if (folders.length === 0) {
          set({ localTracks: [] });
          return;
        }
        const result = await scanLocalMusic();
        if (result.ok) {
          set({ localTracks: result.tracks });
        } else if (result.error) {
          set({ notice: result.error });
        }
      } finally {
        set({ localScanStatus: "idle" });
      }
    },

    async addLocalFolder() {
      const folders = await addLocalMusicFolder();
      set({ localFolders: folders });
      await get().rescanLocalMusic();
    },

    async removeLocalFolder(folder) {
      const folders = await removeLocalMusicFolder(folder);
      set({ localFolders: folders });
      await get().rescanLocalMusic();
    },

    async rescanLocalMusic() {
      if (get().localScanStatus === "scanning") {
        return;
      }
      set({ localScanStatus: "scanning" });
      try {
        const result = await scanLocalMusic();
        if (result.ok) {
          set({ localTracks: result.tracks });
        } else if (result.error) {
          set({ notice: result.error });
        }
      } finally {
        set({ localScanStatus: "idle" });
      }
    },

    setSearchProvider(provider) {
      set({ searchProvider: provider });
    },

    async createPlaylist(title) {
      const playlist: UnifiedPlaylist = {
        id: crypto.randomUUID(),
        ownerId: "local-user",
        title,
        coverArtUrl: undefined,
        entries: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await persistPlaylist(playlist);
      set({ selectedPlaylistId: playlist.id });
      return playlist.id;
    },

    async renamePlaylist(id, title) {
      await runPlaylistMutation(id, async () => {
        const playlist = get().playlists.find((item) => item.id === id);
        if (!playlist) {
          return;
        }
        await persistPlaylist({
          ...playlist,
          title,
          updatedAt: new Date().toISOString()
        });
      });
    },

    async deletePlaylist(id) {
      await runPlaylistMutation(id, async () => {
        await deletePlaylistRecord(id);
        set((state) => ({
          playlists: state.playlists.filter((playlist) => playlist.id !== id),
          selectedPlaylistId: state.selectedPlaylistId === id ? undefined : state.selectedPlaylistId
        }));
      });
    },

    async addTrackToPlaylist(playlistId, track) {
      const saved = await runPlaylistMutation(playlistId, async () => {
        const linkedTrack = await ensureProjectTrack(track, "playlist");
        const playlist = get().playlists.find((item) => item.id === playlistId);
        if (!playlist) {
          throw new Error("Playlist not found.");
        }
        const entry = createPlaylistEntry(playlistId, linkedTrack, playlist.entries.length);
        await persistPlaylist({
          ...playlist,
          coverArtUrl: playlist.coverArtUrl ?? linkedTrack.artworkUrl,
          entries: [...playlist.entries, entry],
          updatedAt: new Date().toISOString()
        });
        set({ notice: `Added "${linkedTrack.title}" to ${playlist.title}.` });
        return true;
      });
      if (!saved) {
        throw new Error("Could not save the playlist change.");
      }
    },

    async addTracksToPlaylist(playlistId, tracks) {
      if (tracks.length === 0) {
        return;
      }
      const saved = await runPlaylistMutation(playlistId, async () => {
        const tracksToLink = tracks.filter(
          (track) => !track.projectTrackId && track.provider !== "youtube" && track.provider !== "local"
        );
        const linkedTracks = await ingestTracks(tracksToLink, "playlist");
        const linkedLookup = new Map(linkedTracks.map((track) => [getTrackKey(track), track]));
        const resolvedTracks = tracks.map((track) => linkedLookup.get(getTrackKey(track)) ?? track);
        const playlist = get().playlists.find((item) => item.id === playlistId);
        if (!playlist) {
          throw new Error("Playlist not found.");
        }
        const entries = [...playlist.entries];
        let coverArtUrl = playlist.coverArtUrl;
        for (const linkedTrack of resolvedTracks) {
          entries.push(createPlaylistEntry(playlistId, linkedTrack, entries.length));
          coverArtUrl = coverArtUrl ?? linkedTrack.artworkUrl;
        }
        await persistPlaylist({
          ...playlist,
          coverArtUrl,
          entries,
          updatedAt: new Date().toISOString()
        });
        set({
          notice: `Added ${tracks.length} track${tracks.length === 1 ? "" : "s"} to ${playlist.title}.`
        });
        return true;
      });
      if (!saved) {
        throw new Error("Could not save the playlist change.");
      }
    },

    async importCollectionAsPlaylist(provider, collectionId, title) {
      const adapter = getProviderAdapter(provider);
      if (!adapter) {
        set({ notice: `Connect ${provider} to import playlists.` });
        return false;
      }

      try {
        const collection = await adapter.getCollectionTracks(collectionId);
        if (!collection.items.length) {
          set({ notice: "That playlist has no importable tracks yet." });
          return false;
        }
        const playlistId = await get().createPlaylist(title || collection.title || "Imported playlist");
        try {
          await get().addTracksToPlaylist(playlistId, collection.items);
          return true;
        } catch (error) {
          await deletePlaylistRecord(playlistId).catch(() => undefined);
          set((state) => ({
            playlists: state.playlists.filter((playlist) => playlist.id !== playlistId),
            selectedPlaylistId:
              state.selectedPlaylistId === playlistId ? undefined : state.selectedPlaylistId
          }));
          throw error;
        }
      } catch (error) {
        set({ notice: error instanceof Error ? error.message : "Could not import that playlist." });
        return false;
      }
    },

    async removeTrackFromPlaylist(playlistId, entryId) {
      await runPlaylistMutation(playlistId, async () => {
        const playlist = get().playlists.find((item) => item.id === playlistId);
        if (!playlist) {
          return;
        }
        const removedEntry = playlist.entries.find((entry) => entry.id === entryId);
        const nextEntries = reorderPlaylistEntries(
          playlist.entries.filter((entry) => entry.id !== entryId)
        );
        await persistPlaylist({
          ...playlist,
          coverArtUrl: nextEntries[0]?.track.artworkUrl,
          entries: nextEntries,
          updatedAt: new Date().toISOString()
        });
        if (removedEntry) {
          set({ notice: `Removed "${removedEntry.track.title}" from ${playlist.title}.` });
        }
      });
    },

    async setSpotifyTrackLiked(track, liked) {
      if (track.provider !== "spotify") {
        return;
      }
      if (!spotifyAdapter || get().connections.spotify.status !== "connected") {
        set({ notice: "Connect Spotify in Settings to update your Liked Songs." });
        return;
      }
      const sessionGeneration = providerSessionGeneration.spotify;
      try {
        await spotifyAdapter.setSaved(track, liked);
        if (
          sessionGeneration !== providerSessionGeneration.spotify ||
          get().connections.spotify.status !== "connected"
        ) {
          return;
        }
        set((state) => {
          const next = new Set(state.spotifyLikedTrackIds);
          const key = `spotify:${track.providerTrackId || track.id}`;
          if (liked) {
            next.add(key);
          } else {
            next.delete(key);
          }
          return { spotifyLikedTrackIds: next };
        });
      } catch (error) {
        set({ notice: getErrorMessage(error, "Could not update your Spotify Liked Songs.") });
      }
    },

    async setSoundCloudTrackLiked(track, liked) {
      if (track.provider !== "soundcloud") {
        return;
      }

      const connection = get().connections.soundcloud;
      const sessionGeneration = providerSessionGeneration.soundcloud;
      if (
        connection.status !== "connected" ||
        (!["web-session", "local-connect"].includes(connection.metadata?.source ?? "") && !connection.accessToken)
      ) {
        set({
          notice: "Connect SoundCloud in Settings to update likes on your account."
        });
        return;
      }

      const result =
        connection.metadata?.source === "web-session"
          ? await setSoundCloudWebTrackLiked(track, liked)
          : connection.metadata?.source === "local-connect"
            ? await setSoundCloudLocalTrackLiked(track, liked)
          : await gatewayRequest<{ liked: boolean }>({
              provider: "soundcloud",
              operation: "setTrackLiked",
              variables: {
                accessToken: connection.accessToken,
                track,
                liked
              }
            });
      if (!result.ok) {
        if (sessionGeneration !== providerSessionGeneration.soundcloud) {
          return;
        }
        set((state) => ({
          notice: result.error ?? "SoundCloud like update failed.",
          connections: {
            ...state.connections,
            soundcloud: {
              ...state.connections.soundcloud,
              issue: result.error ?? "SoundCloud like update failed."
            }
          }
        }));
        return;
      }

      if (
        sessionGeneration !== providerSessionGeneration.soundcloud ||
        get().connections.soundcloud.status !== "connected"
      ) {
        return;
      }

      const linkedTrack = liked ? await ensureProjectTrack(track, "library-sync") : track;
      if (sessionGeneration !== providerSessionGeneration.soundcloud) {
        return;
      }
      const targetKey = getTrackKey(linkedTrack);

      set((state) => {
        const currentLibrary = state.libraries.soundcloud;
        const currentItems = currentLibrary?.items ?? [];
        const wasLiked = currentItems.some((item) => getTrackKey(item) === targetKey);
        const nextItems = liked
          ? [linkedTrack, ...currentItems.filter((item) => getTrackKey(item) !== targetKey)]
          : currentItems.filter((item) => getTrackKey(item) !== targetKey);

        const nextLibrary: TrackCollection | undefined = currentLibrary
          ? {
              ...currentLibrary,
              items: nextItems
            }
          : liked
            ? {
                id: "likes",
                provider: "soundcloud",
                kind: "likes",
                title: "Liked tracks",
                items: nextItems
              }
            : undefined;

        let foundLikesCollection = false;
        const trackCountDelta = liked && !wasLiked ? 1 : !liked && wasLiked ? -1 : 0;
        const nextSoundCloudCollections = (state.providerCollections.soundcloud ?? []).map((collection) => {
          if (collection.id !== "likes") {
            return collection;
          }
          foundLikesCollection = true;
          return {
            ...collection,
            trackCount: Math.max(0, collection.trackCount + trackCountDelta)
          };
        });

        if (liked && !foundLikesCollection) {
          nextSoundCloudCollections.unshift({
            id: "likes",
            provider: "soundcloud",
            kind: "likes",
            title: "Liked tracks",
            trackCount: 1
          });
        }

        const nextSelectedCollectionIds = { ...state.selectedCollectionIds };
        if (liked) {
          nextSelectedCollectionIds.soundcloud = "likes";
        }

        return {
          libraries: {
            ...state.libraries,
            soundcloud: nextLibrary
          },
          providerCollections: {
            ...state.providerCollections,
            soundcloud: nextSoundCloudCollections
          },
          selectedCollectionIds: nextSelectedCollectionIds,
          searchResults: liked
            ? state.searchResults.map((item) => (getTrackKey(item) === targetKey ? linkedTrack : item))
            : state.searchResults,
          notice: liked
            ? `Liked "${linkedTrack.title}" on SoundCloud.`
            : `Unliked "${linkedTrack.title}" on SoundCloud.`
        };
      });
    },

    async reorderPlaylist(playlistId, orderedEntryIds) {
      await runPlaylistMutation(playlistId, async () => {
        const playlist = get().playlists.find((item) => item.id === playlistId);
        if (!playlist) {
          return;
        }
        const lookup = new Map(playlist.entries.map((entry) => [entry.id, entry]));
        const orderedIds = new Set(orderedEntryIds);
        if (
          orderedEntryIds.length !== playlist.entries.length ||
          orderedIds.size !== playlist.entries.length ||
          playlist.entries.some((entry) => !orderedIds.has(entry.id))
        ) {
          throw new Error("Could not reorder the playlist because its contents changed.");
        }
        const reordered = reorderPlaylistEntries(
          orderedEntryIds.map((id) => lookup.get(id)).filter(Boolean) as typeof playlist.entries
        );
        await persistPlaylist({
          ...playlist,
          entries: reordered,
          updatedAt: new Date().toISOString()
        });
      });
    },

    async playTrack(track, queue, source) {
      const requestId = ++activePlayRequest;
      ensurePlayback();
      const connection = get().connections[track.provider];
      const playbackRequirementMessage = getPlaybackRequirementMessage(track, connection);

      if (playbackRequirementMessage) {
        set({ notice: playbackRequirementMessage });
        return;
      }

      const sourceQueue = queue && queue.length > 0 ? queue : [track];
      const startIndex = findQueueTrackIndex(sourceQueue, track);
      // A queue is transient context. Persist only the song the user actually chose; importing an
      // entire album/radio/search queue here inflated storage and polluted Daily Mix seeds with
      // tracks that had never played.
      const linkedTrack = await ensureProjectTrack(track, "playback");
      if (requestId !== activePlayRequest) {
        return;
      }
      const selectedTrackKey = getTrackKey(track);
      const linkedQueue = sourceQueue.map((queueTrack) =>
        getTrackKey(queueTrack) === selectedTrackKey ? linkedTrack : queueTrack
      );
      // Shuffle on: play the chosen track first, then everything else from the source in random
      // order. Off: keep the full source queue selected at the chosen song, so playlist and queue
      // context stays intact for next/previous and the Now Playing queue.
      const shuffle = get().shuffle;
      const playQueue = shuffle
        ? [
            linkedQueue[startIndex] ?? linkedQueue[0],
            ...shuffleTracks(linkedQueue.filter((_, index) => index !== startIndex))
          ]
        : linkedQueue;
      const playIndex = shuffle ? 0 : startIndex;

      if (requestId !== activePlayRequest) {
        return;
      }
      // Track where this queue came from only after this request has won the async linking race.
      set({ queueSource: source });
      queueEngine.setQueue(playQueue, playIndex);

      try {
        // Recently-played + listening stats are recorded centrally in the queue subscription (the
        // first "playing" emit), so auto-advance and manual plays are counted the same way.
        // Re-arm history qualification so deliberately replaying the same queue item is a new
        // listening session once it reaches the threshold again.
        statsTrackKey = "";
        statsQueueIndex = -1;
        statsListenedMs = 0;
        statsLastPositionMs = 0;
        statsPlayLogged = false;
        await queueEngine.playAt(playIndex);
      } catch (error) {
        set({
          notice: getErrorMessage(error, `Could not start ${providerNames[track.provider]} playback.`)
        });
      }
    },

    async addToQueueNext(track) {
      ensurePlayback();
      const linked = await ensureProjectTrack(track, "playback");
      queueEngine.addNext(linked);
      set({ notice: `"${track.title}" will play next.` });
    },

    async downloadTrack(track) {
      if (track.provider !== "soundcloud") {
        set({ notice: "Downloads are available for SoundCloud tracks only." });
        return;
      }
      set({ notice: `Downloading "${track.title}"…` });
      const result = await downloadSoundCloudTrackBridge(track);
      set({
        notice: result.ok
          ? `Saved "${track.title}" to your Music/AMP folder.`
          : result.error ?? "Download failed."
      });
    },

    reorderQueue(fromIndex, toIndex) {
      const { queue, currentIndex } = get().playback;
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= queue.length ||
        toIndex >= queue.length
      ) {
        return;
      }
      const next = [...queue];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      // Keep pointing at the song that's actually playing as it shifts position.
      let nextCurrent = currentIndex;
      if (currentIndex === fromIndex) {
        nextCurrent = toIndex;
      } else if (fromIndex < currentIndex && toIndex >= currentIndex) {
        nextCurrent = currentIndex - 1;
      } else if (fromIndex > currentIndex && toIndex <= currentIndex) {
        nextCurrent = currentIndex + 1;
      }
      queueEngine.reorderQueue(next, nextCurrent);
    },

    removeFromQueue(index) {
      queueEngine.removeAt(index);
    },

    clearQueue() {
      const { queue, currentIndex } = get().playback;
      const current = queue[currentIndex];
      if (!current || queue.length <= 1) {
        return;
      }
      queueEngine.reorderQueue([current], 0);
      set({ notice: "Queue cleared — current track keeps playing." });
    },

    async generateDailyMixes(force = false) {
      // A build is already in flight (the Home mount effect can fire repeatedly during library
      // sync) — never kick off a second overlapping discovery pass, forced or not.
      if (dailyMixesBuilding) {
        return;
      }
      const library = get().projectTracks.map((item) => item.track);
      const today = localDateKey();
      const libraryFingerprint = libraryMixFingerprint(library);
      if (
        !force &&
        get().dailyMixesDate === today &&
        get().dailyMixesLibraryFingerprint === libraryFingerprint &&
        get().dailyMixes.length > 0
      ) {
        return; // Already built for today — stable for the whole day.
      }
      if (library.length < 4) {
        set({
          dailyMixes: [],
          dailyMixesDate: today,
          dailyMixesLibraryFingerprint: libraryFingerprint,
          mixesStatus: "ready"
        });
        return;
      }

      dailyMixesBuilding = true;
      let rebuildFromCurrentLibrary = false;
      set({ mixesStatus: "loading" });
      try {
        const ownedKeys = new Set(library.map(crossProviderKey));
        const clusters = topArtistClusters(library, 6, 2);

        // Discover SIMILAR artists for each anchor — not more of the same artist. SoundCloud's
        // related-tracks endpoint is the discovery engine (it surfaces adjacent/underground artists).
        // We pool related results from a few of the artist's songs, then drop the anchor artist itself,
        // already-owned tracks, and over-represented neighbours so the mix is a real blend.
        const discovered = new Map<string, UnifiedTrack[]>();
        await Promise.all(
          clusters.map(async (cluster) => {
            // Seeds for related-tracks: the artist's own SoundCloud songs, or — if the cluster is
            // Spotify-only — SoundCloud equivalents resolved by searching the artist name.
            let seeds = cluster.tracks.filter((track) => track.provider === "soundcloud").slice(0, 3);
            if (seeds.length === 0) {
              const scHits = (await soundCloudAdapter?.search(cluster.artist).catch(() => [])) ?? [];
              const anchorArtist = normalizeArtist(cluster.artist);
              seeds = scHits
                .filter((track) => normalizeArtist(primaryArtist(track)) === anchorArtist)
                .slice(0, 2);
            }
            const relatedPools = await Promise.all(
              seeds.map((seed) => soundCloudAdapter?.relatedTracks(seed).catch(() => []) ?? [])
            );
            const pool = dedupeTracks(relatedPools.flat()).filter(
              (track) => track.playable && !ownedKeys.has(crossProviderKey(track))
            );
            discovered.set(cluster.artist, limitPerArtist(excludeArtist(pool, cluster.artist), 3));
          })
        );

        const currentFingerprint = libraryMixFingerprint(
          get().projectTracks.map((item) => item.track)
        );
        if (currentFingerprint !== libraryFingerprint) {
          rebuildFromCurrentLibrary = true;
          return;
        }
        const mixes = buildDailyMixes(library, { date: today, count: 6, size: 30, discovered });
        set({
          dailyMixes: mixes,
          dailyMixesDate: today,
          dailyMixesLibraryFingerprint: libraryFingerprint,
          mixesStatus: "ready"
        });
      } catch (error) {
        // An unexpected throw used to leave mixesStatus stuck on "loading" (spinner forever).
        set({
          mixesStatus: "ready",
          notice: getErrorMessage(error, "Couldn't build Daily Mixes right now.")
        });
      } finally {
        dailyMixesBuilding = false;
        if (rebuildFromCurrentLibrary) {
          void get().generateDailyMixes(true);
        }
      }
    },

    async startStation(seed) {
      // Station discovery is a multi-hop network fan-out — rapid double clicks used to launch
      // overlapping builds that raced each other for lastStation/playback.
      const requestId = ++stationRequestId;
      const isCurrentRequest = () => requestId === stationRequestId;
      ensurePlayback();
      set({ notice: `Building a station from "${seed.title}"…` });
      try {
      // SoundCloud related-tracks is the only true similarity engine left (Spotify retired its
      // recommendations API). Resolve a SoundCloud "twin" of the seed, then expand TWO hops out:
      // related(seed), plus related() of a few artist-diverse first-hop tracks. That turns ~20
      // neighbours into ~100 while staying anchored to the seed's neighbourhood.
      let scSeed: UnifiedTrack | undefined = seed.provider === "soundcloud" ? seed : undefined;
      if (!scSeed) {
        // Pick the BEST title+artist+duration match, not the top text hit, so the station isn't
        // anchored on a cover / remix / wrong-language upload with a similar name (the "it just
        // searched the name" drift). Fall back to an artist-only match, then the raw top hit.
        const query = `${primaryArtist(seed)} ${seed.title}`.trim();
        const titleHits = (await soundCloudAdapter?.search(query).catch(() => [])) ?? [];
        scSeed = pickBestTwin(seed, titleHits);
        if (!scSeed) {
          const artistHits = (await soundCloudAdapter?.search(primaryArtist(seed)).catch(() => [])) ?? [];
          scSeed = pickBestTwin(seed, artistHits, 2);
        }
      }

      if (!isCurrentRequest()) {
        return;
      }

      const hop1 = dedupeTracks(
        scSeed ? ((await soundCloudAdapter?.relatedTracks(scSeed).catch(() => [])) ?? []) : []
      );
      // Widen the hop-2 fan-out a little: with the genre/language gates below, more candidates is
      // safe and gives the scorer more in-lane material to choose from.
      const hop2Seeds = limitPerArtist(hop1, 1).slice(0, 8);
      const hop2Pools = await Promise.all(
        hop2Seeds.map((track) => soundCloudAdapter?.relatedTracks(track).catch(() => []) ?? [])
      );
      if (!isCurrentRequest()) {
        return;
      }
      const hop1Keys = new Set(hop1.map(trackKey));
      const hop2 = dedupeTracks(hop2Pools.flat()).filter((track) => !hop1Keys.has(trackKey(track)));

      // Rank the seed's artist neighbourhood — artists that keep appearing across the related
      // pools are the strongest "similar artist" signal we have. Hop-1 appearances count double.
      const neighbourArtistWeight = new Map<string, number>();
      const bumpArtist = (track: UnifiedTrack, weight: number) => {
        const artist = normalizeArtist(primaryArtist(track));
        if (artist === "unknown") {
          return;
        }
        neighbourArtistWeight.set(artist, (neighbourArtistWeight.get(artist) ?? 0) + weight);
      };
      hop1.forEach((track) => bumpArtist(track, 2));
      hop2.forEach((track) => bumpArtist(track, 1));

      // Spotify lane: targeted artist: searches for the seed artist + strongest neighbours, so the
      // Spotify side of the station is drawn from the same neighbourhood instead of fuzzy matches.
      const seedArtistName = primaryArtist(seed);
      const neighbourNames = [
        ...new Map(
          [...hop1, ...hop2].map((track) => [normalizeArtist(primaryArtist(track)), primaryArtist(track)])
        ).entries()
      ]
        .filter(([norm]) => norm !== "unknown" && norm !== normalizeArtist(seedArtistName))
        .sort((a, b) => (neighbourArtistWeight.get(b[0]) ?? 0) - (neighbourArtistWeight.get(a[0]) ?? 0))
        .slice(0, 4)
        .map(([, display]) => display);
      const spotify = spotifyAdapter;
      const spotifyPools =
        spotify && get().connections.spotify.status === "connected"
          ? await Promise.all(
              [seedArtistName, ...neighbourNames].map((artist) =>
                spotify.search(`artist:"${artist}"`).catch(() => [])
              )
            )
          : [];
      if (!isCurrentRequest()) {
        return;
      }

      // Build the candidate pool first — the vibe/genre/language signals below need every candidate.
      const rawPool = dedupeTracks([...hop1, ...hop2, ...spotifyPools.flat()]).filter(
        (track) => track.playable && trackKey(track) !== trackKey(seed)
      );

      // ---- Shared enrichment signals: tempo/loudness (Deezer) + normalized genres + language. ----
      const featureMap = get().trackFeatures;
      let seedFeatureRecord = featureMap[crossProviderKey(seed)];
      if (!seedFeatureRecord && scSeed) {
        seedFeatureRecord = featureMap[crossProviderKey(scSeed)];
      }
      let seedFeature = seedFeatureRecord
        ? { bpm: seedFeatureRecord.bpm, loudness: seedFeatureRecord.loudness }
        : undefined;
      if (!seedFeature) {
        // The seed drives vibe distance; fetch it once (cached) even if it isn't in the library.
        const fetched = await fetchDeezerFeatures(seed).catch(() => null);
        if (fetched?.ok) {
          seedFeature = { bpm: fetched.bpm, loudness: fetched.loudness };
        }
      }
      const seedGenres = new Set<string>(seedFeatureRecord?.genres ?? []);
      for (const genre of normalizeGenres([seed.genre, scSeed?.genre])) {
        seedGenres.add(genre);
      }
      const seedScript = detectScript(`${seed.title} ${seedArtistName}`);
      const scriptCounts = new Map<ScriptTag, number>();
      for (const item of get().projectTracks) {
        const itemScript = detectScript(`${item.track.title} ${primaryArtist(item.track)}`);
        scriptCounts.set(itemScript, (scriptCounts.get(itemScript) ?? 0) + 1);
      }
      const libraryScripts = new Set<ScriptTag>();
      for (const [script, count] of scriptCounts) {
        if (script !== "other" && count >= 3) {
          libraryScripts.add(script);
        }
      }
      const candidateFeatures = new Map<string, { bpm: number | null; loudness: number | null }>();
      const candidateGenres = new Map<string, Set<string>>();
      for (const track of rawPool) {
        const record = featureMap[crossProviderKey(track)];
        if (!record) {
          continue;
        }
        candidateFeatures.set(trackKey(track), { bpm: record.bpm, loudness: record.loudness });
        if (record.genres.length > 0) {
          candidateGenres.set(trackKey(track), new Set(record.genres));
        }
      }

      // Score every candidate against the seed, then collapse cross-provider duplicates (the same
      // song on both platforms) keeping the seed's provider and the GROUP's best score — so a
      // Spotify twin of a hop-1 SoundCloud neighbour inherits the hop-1 provenance.
      const seedForSignals = scSeed && !seed.genre ? { ...seed, genre: scSeed.genre } : seed;
      const signals: StationSignals = {
        seed: seedForSignals,
        hop1Keys,
        hop2Keys: new Set(hop2.map(trackKey)),
        neighbourArtistWeight,
        libraryArtists: new Set(
          get().projectTracks.map((item) => normalizeArtist(primaryArtist(item.track)))
        ),
        seedScript,
        libraryScripts,
        seedGenres,
        candidateGenres,
        seedFeature,
        candidateFeatures
      };
      // The Spotify lane came from targeted artist searches on the seed's neighbourhood, so those
      // tracks carry real provenance the SoundCloud-graph scorer can't see. Credit it, or hop-1/2
      // membership buries every Spotify candidate (the 48-vs-2 station skew).
      const spotifyLaneKeys = new Set(spotifyPools.flat().map(trackKey));
      const scoreByCrossKey = new Map<string, number>();
      for (const track of rawPool) {
        const key = crossProviderKey(track);
        let score = scoreStationCandidate(track, signals);
        if (spotifyLaneKeys.has(trackKey(track))) {
          score += 1.75;
        }
        scoreByCrossKey.set(key, Math.max(scoreByCrossKey.get(key) ?? -Infinity, score));
      }
      const candidates = limitPerArtist(dedupeAcrossProviders(rawPool, seed.provider), 3);
      const scores = new Map(
        candidates.map((track) => [trackKey(track), scoreByCrossKey.get(crossProviderKey(track)) ?? 0])
      );

      const station = buildScoredStation(seed, candidates, scores, { size: 50 });
      if (!isCurrentRequest()) {
        return;
      }
      set({ lastStation: station });
      if (station.tracks.length <= 1) {
        set({ notice: `Couldn't find related tracks for "${seed.title}" right now.` });
        return;
      }
      await get().playTrack(station.tracks[0], station.tracks, {
        kind: "station",
        label: station.title,
        mixId: station.id
      });
      set({ notice: `Station started from "${seed.title}".` });
      } catch (error) {
        if (isCurrentRequest()) {
          set({ notice: getErrorMessage(error, `Couldn't build a station from "${seed.title}".`) });
        }
      }
    },

    async enrichLibraryFeatures() {
      if (get().featuresStatus === "enriching") {
        return;
      }
      const state = get();
      const libraryTracks = [
        ...(state.libraries.spotify?.items ?? []),
        ...(state.libraries.soundcloud?.items ?? [])
      ];
      if (libraryTracks.length === 0) {
        return;
      }

      // De-dupe by cross-provider key and skip tracks already probed (terminal records persist).
      const existing = get().trackFeatures;
      const pending = new Map<string, UnifiedTrack>();
      for (const track of libraryTracks) {
        const key = crossProviderKey(track);
        if (!existing[key] && !pending.has(key)) {
          pending.set(key, track);
        }
      }
      if (pending.size === 0) {
        return;
      }

      set({ featuresStatus: "enriching" });
      try {
        const pendingTracks = [...pending.values()];

        // Batch-fetch Spotify artist genres up front (artist-level, ≤50/call) so each Spotify track
        // resolves its genre without a per-track call.
        let spotifyArtistGenres = new Map<string, string[]>();
        const spotify = spotifyAdapter;
        if (spotify && get().connections.spotify.status === "connected") {
          const artistIds = Array.from(
            new Set(
              pendingTracks
                .filter((track) => track.provider === "spotify")
                .map((track) => track.creatorIds?.find(Boolean))
                .filter((id): id is string => Boolean(id))
            )
          );
          if (artistIds.length > 0) {
            spotifyArtistGenres = await spotify
              .getArtistGenres(artistIds)
              .catch(() => new Map<string, string[]>());
          }
        }

        // Throttled batches to stay under Deezer's ~50 req / 5s limit. Each track costs up to 2 calls
        // (search + detail), so 4 tracks/sec ≈ 8 calls/sec — comfortably under the ceiling.
        const BATCH_SIZE = 4;
        const BATCH_GAP_MS = 1000;
        const PERSIST_EVERY = 60;
        const now = Date.now();
        let sincePersist = 0;

        for (let i = 0; i < pendingTracks.length; i += BATCH_SIZE) {
          const batch = pendingTracks.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (track) => {
              const deezer = await fetchDeezerFeatures(track).catch(() => ({
                ok: false,
                bpm: null,
                loudness: null,
                matched: false
              }));
              if (!deezer.ok) {
                // Transient (e.g. quota) — leave unfetched so a later pass retries it.
                return undefined;
              }
              return makeTrackFeatures(track, deezer, resolveTrackGenres(track, spotifyArtistGenres), now);
            })
          );

          const batchUpdate: TrackFeatureMap = {};
          for (const features of results) {
            if (features) {
              batchUpdate[features.key] = features;
            }
          }
          if (Object.keys(batchUpdate).length > 0) {
            const merged = { ...get().trackFeatures, ...batchUpdate };
            set({ trackFeatures: merged });
            sincePersist += Object.keys(batchUpdate).length;
            if (sincePersist >= PERSIST_EVERY) {
              saveTrackFeatures(merged);
              sincePersist = 0;
            }
          }

          if (i + BATCH_SIZE < pendingTracks.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, BATCH_GAP_MS));
          }
        }
        saveTrackFeatures(get().trackFeatures);
      } finally {
        set({ featuresStatus: "idle" });
      }
    },

    openMix(mix) {
      set({ activeMix: mix });
    },

    async openArtist(track) {
      const requestId = ++activeArtistRequest;
      const provider = track.provider;
      const name = primaryArtist(track);
      set({ activeArtist: { status: "loading", provider, name, topTracks: [], albums: [] } });
      try {
        if (provider === "spotify") {
          const spotify = spotifyAdapter;
          if (!spotify || get().connections.spotify.status !== "connected") {
            throw new Error("Connect Spotify to browse artists.");
          }
          // Tracks parsed before creatorIds existed fall back to a name lookup.
          const artistId = track.creatorIds?.find(Boolean);
          const profile = artistId ? await spotify.getArtist(artistId) : await spotify.searchArtist(name);
          if (!profile) {
            throw new Error(`Couldn't find "${name}" on Spotify.`);
          }
          const [topTracks, albums] = await Promise.all([
            spotify.getArtistTopTracks(profile.id).catch(() => [] as UnifiedTrack[]),
            spotify.getArtistAlbums(profile.id).catch(() => [] as SpotifyAlbumSummary[])
          ]);
          if (requestId !== activeArtistRequest) {
            return;
          }
          set({
            activeArtist: {
              status: "ready",
              provider,
              name: profile.name,
              imageUrl: profile.imageUrl,
              genres: profile.genres,
              followers: profile.followers,
              externalUrl: profile.externalUrl,
              topTracks,
              albums
            }
          });
        } else {
          if (!soundCloudAdapter) {
            throw new Error("SoundCloud isn't available right now.");
          }
          const userUrl = soundCloudUserUrlFromTrack(track);
          if (!userUrl) {
            throw new Error("Couldn't resolve the SoundCloud artist page for this track.");
          }
          const profile = await soundCloudAdapter.resolveProfile(userUrl);
          if (requestId !== activeArtistRequest) {
            return;
          }
          set({
            activeArtist: {
              status: "ready",
              provider,
              name: profile.displayName || name,
              externalUrl: userUrl,
              topTracks: profile.uploads.slice(0, 25),
              albums: [],
              playlists: profile.playlists
            }
          });
        }
      } catch (error) {
        if (requestId !== activeArtistRequest) {
          return;
        }
        set({
          activeArtist: {
            status: "error",
            provider,
            name,
            topTracks: [],
            albums: [],
            error: getErrorMessage(error, "Couldn't load that artist.")
          }
        });
      }
    },

    async openAlbumForTrack(track) {
      if (track.provider !== "spotify") {
        set({ notice: "Albums live on Spotify — SoundCloud artists publish playlists instead." });
        return;
      }
      const requestId = ++activeAlbumRequest;
      const name = track.album ?? track.title;
      set({
        activeAlbum: {
          status: "loading",
          provider: "spotify",
          name,
          artistNames: track.creators,
          imageUrl: track.artworkUrl,
          tracks: []
        }
      });
      try {
        const spotify = spotifyAdapter;
        if (!spotify || get().connections.spotify.status !== "connected") {
          throw new Error("Connect Spotify to browse albums.");
        }
        // Tracks parsed before albumId existed fall back to an album search.
        const albumId =
          track.albumId ??
          (track.album ? await spotify.searchAlbum(track.album, primaryArtist(track)) : undefined);
        if (!albumId) {
          throw new Error("Couldn't find that album on Spotify.");
        }
        await loadAlbumIntoView(albumId, requestId);
      } catch (error) {
        if (requestId !== activeAlbumRequest) {
          return;
        }
        set({
          activeAlbum: {
            status: "error",
            provider: "spotify",
            name,
            artistNames: track.creators,
            imageUrl: track.artworkUrl,
            tracks: [],
            error: getErrorMessage(error, "Couldn't load that album.")
          }
        });
      }
    },

    async openAlbumById(albumId) {
      const requestId = ++activeAlbumRequest;
      set({
        activeAlbum: {
          status: "loading",
          provider: "spotify",
          name: "Album",
          artistNames: [],
          tracks: []
        }
      });
      try {
        await loadAlbumIntoView(albumId, requestId);
      } catch (error) {
        if (requestId !== activeAlbumRequest) {
          return;
        }
        set({
          activeAlbum: {
            status: "error",
            provider: "spotify",
            name: "Album",
            artistNames: [],
            tracks: [],
            error: getErrorMessage(error, "Couldn't load that album.")
          }
        });
      }
    },

    openTrackMenu(track, x, y, options) {
      set({ trackMenu: { track, x, y, source: options?.source ?? "list", queueIndex: options?.queueIndex } });
    },

    closeTrackMenu() {
      set({ trackMenu: undefined });
    },

    async playPlaylist(id) {
      const playlist = get().playlists.find((item) => item.id === id);
      if (!playlist || playlist.entries.length === 0) {
        return;
      }

      const queue = playlist.entries.map((entry) => entry.track);
      // With shuffle on, start from a random track (playTrack then randomizes the rest).
      const startTrack = get().shuffle ? queue[Math.floor(Math.random() * queue.length)] : queue[0];
      await get().playTrack(startTrack, queue, { kind: "playlist", label: playlist.title });
    },

    async togglePlayback() {
      try {
        await queueEngine.togglePlayback();
      } catch (error) {
        set({
          notice: getErrorMessage(error, "Playback could not be toggled.")
        });
      }
    },

    async next() {
      try {
        await queueEngine.next();
      } catch (error) {
        set({
          notice: getErrorMessage(error, "The next track could not start.")
        });
      }
    },

    async previous() {
      try {
        await queueEngine.previous();
      } catch (error) {
        set({
          notice: getErrorMessage(error, "The previous track could not start.")
        });
      }
    },

    async seek(positionMs) {
      try {
        await queueEngine.seek(positionMs);
      } catch (error) {
        set({
          notice: getErrorMessage(error, "Seeking failed for the active track.")
        });
      }
    },

    async setVolume(volume) {
      // Persist immediately (even if the active adapter's apply fails) so the saved master volume
      // always matches the slider the user just moved.
      saveVolume(volume);
      try {
        await queueEngine.setVolume(volume);
      } catch (error) {
        set({
          notice: getErrorMessage(error, "Volume control failed for the active track.")
        });
      }
    },

    async setProviderVolume(provider, volume) {
      saveProviderVolume(provider, volume);
      try {
        await queueEngine.setProviderVolume(provider, volume);
      } catch (error) {
        set({
          notice: getErrorMessage(error, `${providerNames[provider]} volume control failed.`)
        });
      }
    },

    toggleShuffle() {
      const shuffle = !get().shuffle;
      saveShuffle(shuffle);
      set({ shuffle });
      // Turning shuffle on mid-playback reshuffles only "up next", leaving the current track playing.
      if (shuffle) {
        queueEngine.reshuffleUpcoming();
      }
    },

    setAccentSource(source) {
      saveAccentSource(source);
      set({ accentSource: source });
    },

    setBeatIntensity(value) {
      saveBeatIntensity(value);
      const clamped = loadBeatIntensity();
      set({ beatIntensity: clamped });
    },

    setDiscordPresenceEnabled(enabled) {
      saveDiscordPresenceEnabled(enabled);
      set({ discordPresenceEnabled: enabled });
      void pushDiscordPresenceEnabled(enabled);
    },

    completeOnboarding() {
      saveOnboardingComplete(true);
      set({ onboardingComplete: true });
    },

    async restartOnboarding() {
      // A genuine "start over": disconnect BOTH providers so the setup screen is a real clean slate
      // to reconnect from, then re-show it. Each disconnect clears that provider's stored session
      // (so it won't auto-reconnect next launch). Imported tracks/playlists are left in AMP.
      // Wrapped so a hiccup on one provider still resets the rest of the flow.
      try {
        await queueEngine.teardown();
      } catch {
        // best-effort
      }
      try {
        await get().disconnectProvider("spotify");
      } catch {
        // best-effort
      }
      try {
        await get().disconnectProvider("soundcloud");
      } catch {
        // best-effort
      }
      saveOnboardingComplete(false);
      set({ onboardingComplete: false });
    },

    async loadSoundCloudLocalProfiles() {
      set({
        soundCloudLocalStatus: "selecting-profile",
        soundCloudLocalError: undefined
      });

      const result = await listSoundCloudLocalProfiles();
      if (!result.ok || !result.data) {
        const message = result.error ?? "Could not find supported browser profiles on this device.";
        set({
          soundCloudLocalProfiles: [],
          soundCloudLocalStatus: "error",
          soundCloudLocalError: {
            message
          },
          notice: message
        });
        return;
      }

      set({
        soundCloudLocalProfiles: result.data,
        soundCloudLocalStatus: "selecting-profile",
        soundCloudLocalError: undefined
      });
    },

    async connectSoundCloudViaBrowser() {
      ensurePlayback();
      const sessionGeneration = ++providerSessionGeneration.soundcloud;
      setSoundCloudConnecting();
      set({ soundCloudLocalStatus: "connecting", soundCloudLocalError: undefined });

      const result = await connectSoundCloudViaBrowserBridge();
      if (sessionGeneration !== providerSessionGeneration.soundcloud) {
        return;
      }
      if (!result.ok || !result.data) {
        const message = result.error ?? "SoundCloud sign-in failed.";
        // A cancelled sign-in isn't an error worth a red banner — just return to idle.
        if (/cancel/i.test(message)) {
          set({ soundCloudLocalStatus: "idle", soundCloudLocalError: undefined });
          return;
        }
        setSoundCloudError(new Error(message), message);
        set({
          soundCloudLocalStatus: "error",
          soundCloudLocalError: { message }
        });
        return;
      }

      set({ soundCloudLocalStatus: "syncing" });
      const applied = await applySoundCloudProfile(result.data.profile, {
        source: "local-connect",
        connection: result.data.connection,
        sessionGeneration,
        stats: {
          likesCount: result.data.likesCount,
          playlistsCount: result.data.playlistsCount,
          lastSyncedAt: result.data.lastSyncedAt
        }
      });
      if (!applied || sessionGeneration !== providerSessionGeneration.soundcloud) {
        return;
      }
      const runtime = await reloadDesktopRuntime();
      if (sessionGeneration !== providerSessionGeneration.soundcloud) {
        return;
      }
      set({
        runtime,
        soundCloudLocalStatus: "connected",
        soundCloudLocalError: undefined
      });
    },

    async connectSoundCloudLocalProfile(profileId) {
      if (!profileId) {
        return;
      }

      ensurePlayback();
      const sessionGeneration = ++providerSessionGeneration.soundcloud;
      setSoundCloudConnecting();
      set({
        soundCloudLocalStatus: "connecting",
        soundCloudLocalError: undefined
      });

      const result = await connectSoundCloudLocalProfileBridge(profileId);
      if (sessionGeneration !== providerSessionGeneration.soundcloud) {
        return;
      }
      if (!result.ok || !result.data) {
        const errorData = result.data as unknown as { code?: string } | undefined;
        const message = result.error ?? "SoundCloud Local Connect failed.";
        setSoundCloudError(new Error(message), message);
        set({
          soundCloudLocalStatus: "error",
          soundCloudLocalError: {
            code: errorData?.code,
            message
          }
        });
        return;
      }

      set({ soundCloudLocalStatus: "syncing" });
      const applied = await applySoundCloudProfile(result.data.profile, {
        source: "local-connect",
        connection: result.data.connection,
        sessionGeneration,
        stats: {
          likesCount: result.data.likesCount,
          playlistsCount: result.data.playlistsCount,
          lastSyncedAt: result.data.lastSyncedAt
        }
      });
      if (!applied || sessionGeneration !== providerSessionGeneration.soundcloud) {
        return;
      }
      const runtime = await reloadDesktopRuntime();
      if (sessionGeneration !== providerSessionGeneration.soundcloud) {
        return;
      }
      set({
        runtime,
        soundCloudLocalStatus: "connected",
        soundCloudLocalError: undefined
      });
    },

    async openSoundCloudLocalSignin(profileId) {
      if (!profileId) {
        return false;
      }
      const result = await openSoundCloudLocalSigninBridge(profileId);
      if (!result.ok) {
        set({
          soundCloudLocalError: {
            code: "validation-failed",
            message: result.error ?? "Could not open the browser sign-in page."
          }
        });
        return false;
      }
      return true;
    },

    async closeSoundCloudLocalBrowser(profileId) {
      if (!profileId) {
        return;
      }
      set({ soundCloudLocalStatus: "connecting", soundCloudLocalError: undefined });
      const result = await closeSoundCloudLocalBrowserBridge(profileId);
      if (!result.ok) {
        const message = result.error ?? "Could not close the browser.";
        set({
          soundCloudLocalStatus: "error",
          soundCloudLocalError: { code: "browser-running", message }
        });
        return;
      }
      // Browser closed — finish the connection automatically.
      await get().connectSoundCloudLocalProfile(profileId);
    },

  };
});
