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

export interface SpotifyAdapterOptions {
  getConnection: () => ProviderConnection | undefined;
  refreshConnection: () => Promise<ProviderConnection | undefined>;
  onConnectionIssue: (issue: string, patch?: Partial<ProviderConnection>) => void;
  /** Effective starting volume after master and provider trim are applied. */
  initialVolume?: number;
}

interface SpotifyApiErrorResponse {
  error?: {
    status?: number;
    message?: string;
  };
}

interface CachedValue<T> {
  expiresAt: number;
  value: T;
}

interface SpotifyApiTrack {
  id?: string;
  uri?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  is_playable?: boolean;
  external_urls?: { spotify?: string };
  album?: { id?: string; name?: string; images?: Array<{ url?: string }> };
  artists?: Array<{ id?: string; name?: string }>;
}

interface SpotifyApiArtist {
  id?: string;
  name?: string;
  images?: Array<{ url?: string }>;
  genres?: string[];
  followers?: { total?: number };
  external_urls?: { spotify?: string };
}

interface SpotifyApiAlbum {
  id?: string;
  name?: string;
  album_type?: string;
  release_date?: string;
  total_tracks?: number;
  images?: Array<{ url?: string }>;
  external_urls?: { spotify?: string };
  artists?: Array<{ id?: string; name?: string }>;
}

export interface SpotifyArtistProfile {
  id: string;
  name: string;
  imageUrl?: string;
  genres: string[];
  followers?: number;
  externalUrl?: string;
}

export interface SpotifyAlbumSummary {
  id: string;
  name: string;
  albumType?: string;
  releaseYear?: string;
  totalTracks?: number;
  imageUrl?: string;
  externalUrl?: string;
  artistNames: string[];
}

export interface SpotifyAlbumDetail extends SpotifyAlbumSummary {
  tracks: UnifiedTrack[];
}

interface SpotifyApiPlaylist {
  id?: string;
  name?: string;
  description?: string;
  images?: Array<{ url?: string }>;
  owner?: { display_name?: string };
  tracks?: { total?: number };
  external_urls?: { spotify?: string };
}

const SPOTIFY_SAVED_TRACKS_COLLECTION_ID = "saved-tracks";
const SEARCH_CACHE_TTL_MS = 90_000;
const COLLECTION_CACHE_TTL_MS = 2 * 60_000;
// Artist/album pages are mostly static editorial data — cache much longer than search results.
const CATALOG_CACHE_TTL_MS = 10 * 60_000;

/**
 * Spotify functionality shared by playback and library code: search, collections, like state, the
 * authenticated request plumbing, caching, and event emission. The in-app Web Playback SDK adapter
 * extends this and implements the playback transport (play / pause / seek / setVolume / teardown).
 */
export abstract class SpotifyBaseAdapter implements PlaybackAdapter {
  readonly provider = "spotify" as const;

  protected listeners = new Set<PlaybackAdapterListener>();
  protected searchCache = new Map<string, CachedValue<UnifiedTrack[]>>();
  protected collectionsCache?: CachedValue<ProviderCollection[]>;
  protected collectionTrackCache = new Map<string, CachedValue<TrackCollection>>();
  protected artistCache = new Map<string, CachedValue<SpotifyArtistProfile>>();
  protected artistTopTracksCache = new Map<string, CachedValue<UnifiedTrack[]>>();
  protected artistAlbumsCache = new Map<string, CachedValue<SpotifyAlbumSummary[]>>();
  protected albumCache = new Map<string, CachedValue<SpotifyAlbumDetail>>();
  private rateLimitedUntil = 0;
  protected snapshot: PlaybackAdapterSnapshot = {
    provider: "spotify",
    status: "idle",
    positionMs: 0,
    durationMs: 0,
    volume: 0.8
  };

  constructor(protected options: SpotifyAdapterOptions) {
    if (options.initialVolume != null) {
      this.snapshot.volume = clampVolume(options.initialVolume);
    }
  }

  subscribe(listener: PlaybackAdapterListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clearAccountCaches(): void {
    this.searchCache.clear();
    this.collectionsCache = undefined;
    this.collectionTrackCache.clear();
    this.artistCache.clear();
    this.artistTopTracksCache.clear();
    this.artistAlbumsCache.clear();
    this.albumCache.clear();
  }

  // ---- Playback transport — implemented per engine ----
  abstract play(track: UnifiedTrack, context: { positionMs?: number }): Promise<void>;
  abstract pause(): Promise<void>;
  abstract seek(positionMs: number): Promise<void>;
  abstract setVolume(volume: number): Promise<void>;
  abstract teardown(): Promise<void>;

  // ---- Data / library (engine-agnostic) ----

  async search(query: string): Promise<UnifiedTrack[]> {
    const cacheKey = query.trim().toLowerCase();
    const cached = this.getCachedValue(this.searchCache, cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this.request(
      `/search?q=${encodeURIComponent(query)}&type=track&limit=18`
    );
    if (!response.ok) {
      throw await this.createSpotifyApiError(response, "Spotify search failed.");
    }

    const json = (await response.json()) as { tracks?: { items?: SpotifyApiTrack[] } };
    const tracks = (json.tracks?.items ?? []).map(mapSpotifyApiTrack);
    this.setCachedValue(this.searchCache, cacheKey, tracks, SEARCH_CACHE_TTL_MS);
    return tracks;
  }

  async getCollections(): Promise<ProviderCollection[]> {
    if (this.collectionsCache && this.collectionsCache.expiresAt > Date.now()) {
      return this.collectionsCache.value;
    }

    const collections: ProviderCollection[] = [];

    try {
      const savedResponse = await this.request("/me/tracks?limit=1");
      if (savedResponse.ok) {
        const savedJson = (await savedResponse.json()) as { total?: number };
        collections.push({
          id: SPOTIFY_SAVED_TRACKS_COLLECTION_ID,
          provider: "spotify",
          kind: "saved-tracks",
          title: "Liked Songs",
          trackCount: savedJson.total ?? 0
        });
      }
    } catch {
      // Saved tracks are best-effort; a failure here should not block playlists.
    }

    try {
      let nextUrl: string | undefined = "/me/playlists?limit=50";
      const visited = new Set<string>();
      while (nextUrl && !visited.has(nextUrl) && visited.size < 20) {
        visited.add(nextUrl);
        const playlistResponse = await this.request(nextUrl);
        if (!playlistResponse.ok) {
          break;
        }
        const playlistJson = (await playlistResponse.json()) as {
          items?: SpotifyApiPlaylist[];
          next?: string | null;
        };
        for (const playlist of playlistJson.items ?? []) {
          if (!playlist.id) {
            continue;
          }
          collections.push({
            id: playlist.id,
            provider: "spotify",
            kind: "playlist",
            title: playlist.name?.trim() || "Playlist",
            trackCount: playlist.tracks?.total ?? 0,
            artworkUrl: playlist.images?.[0]?.url,
            externalUrl: playlist.external_urls?.spotify,
            description: playlist.description?.trim() || undefined,
            ownerName: playlist.owner?.display_name
          });
        }
        nextUrl = playlistJson.next ?? undefined;
      }
    } catch {
      // Playlists are best-effort.
    }

    if (collections.length === 0) {
      throw new Error("Could not load your Spotify library yet. Try Sync again in a moment.");
    }

    this.collectionsCache = {
      value: collections,
      expiresAt: Date.now() + COLLECTION_CACHE_TTL_MS
    };
    return collections;
  }

  async getCollectionTracks(collectionId: string): Promise<TrackCollection> {
    const cached = this.getCachedValue(this.collectionTrackCache, collectionId);
    if (cached) {
      return cached;
    }

    let collection: TrackCollection;

    if (collectionId === SPOTIFY_SAVED_TRACKS_COLLECTION_ID) {
      const apiTracks: SpotifyApiTrack[] = [];
      let nextUrl: string | undefined = "/me/tracks?limit=50";
      let page = 0;
      const visitedPages = new Set<string>();
      while (nextUrl) {
        if (page >= 400 || visitedPages.has(nextUrl)) {
          throw new Error("Spotify returned an invalid Liked Songs pagination cursor.");
        }
        visitedPages.add(nextUrl);
        const response = await this.request(nextUrl);
        if (!response.ok) {
          if (page === 0) {
            throw await this.createSpotifyApiError(response, "Failed to load your Liked Songs.");
          }
          throw await this.createSpotifyApiError(
            response,
            "Spotify stopped while loading your Liked Songs. Try Sync again."
          );
        }
        const json = (await response.json()) as {
          items?: Array<{ track?: SpotifyApiTrack }>;
          next?: string | null;
        };
        const batch = (json.items ?? [])
          .map((entry) => entry.track)
          .filter((track): track is SpotifyApiTrack => Boolean(track));
        apiTracks.push(...batch);
        nextUrl = json.next ?? undefined;
        page += 1;
        if (batch.length === 0) {
          break;
        }
      }
      collection = {
        id: collectionId,
        provider: "spotify",
        kind: "saved-tracks",
        title: "Liked Songs",
        items: apiTracks.map(mapSpotifyApiTrack)
      };
    } else {
      const response = await this.request(`/playlists/${encodeURIComponent(collectionId)}`);
      if (!response.ok) {
        throw await this.createSpotifyApiError(response, "Failed to load that playlist.");
      }
      const json = (await response.json()) as {
        name?: string;
        description?: string;
        external_urls?: { spotify?: string };
        owner?: { display_name?: string };
        tracks?: {
          items?: Array<{ track?: SpotifyApiTrack }>;
          next?: string | null;
        };
      };
      const playlistTracks = (json.tracks?.items ?? [])
        .map((entry) => entry.track)
        .filter((track): track is SpotifyApiTrack => Boolean(track));
      let nextUrl = json.tracks?.next ?? undefined;
      const visitedPages = new Set<string>();
      while (nextUrl) {
        if (visitedPages.size >= 400 || visitedPages.has(nextUrl)) {
          throw new Error("Spotify returned an invalid playlist pagination cursor.");
        }
        visitedPages.add(nextUrl);
        const pageResponse = await this.request(nextUrl);
        if (!pageResponse.ok) {
          throw await this.createSpotifyApiError(
            pageResponse,
            "Spotify stopped while loading that playlist. Try again."
          );
        }
        const pageJson = (await pageResponse.json()) as {
          items?: Array<{ track?: SpotifyApiTrack }>;
          next?: string | null;
        };
        playlistTracks.push(
          ...(pageJson.items ?? [])
            .map((entry) => entry.track)
            .filter((track): track is SpotifyApiTrack => Boolean(track))
        );
        nextUrl = pageJson.next ?? undefined;
      }
      collection = {
        id: collectionId,
        provider: "spotify",
        kind: "playlist",
        title: json.name?.trim() || "Playlist",
        description: json.description?.trim() || undefined,
        externalUrl: json.external_urls?.spotify,
        ownerName: json.owner?.display_name,
        items: playlistTracks.map(mapSpotifyApiTrack)
      };
    }

    this.setCachedValue(this.collectionTrackCache, collectionId, collection, COLLECTION_CACHE_TTL_MS);
    return collection;
  }

  async getLibrary(): Promise<TrackCollection> {
    return this.getCollectionTracks(SPOTIFY_SAVED_TRACKS_COLLECTION_ID);
  }

  /** Save or remove a track in the user's Spotify library (Liked Songs). */
  async setSaved(track: UnifiedTrack, saved: boolean): Promise<void> {
    const id = track.providerTrackId;
    if (!id) {
      throw new Error("Could not resolve the Spotify track id.");
    }
    const response = await this.request(`/me/tracks?ids=${encodeURIComponent(id)}`, {
      method: saved ? "PUT" : "DELETE"
    });
    if (!response.ok) {
      throw await this.createSpotifyApiError(response, "Could not update your Spotify library.");
    }
    this.collectionsCache = undefined;
    this.collectionTrackCache.delete(SPOTIFY_SAVED_TRACKS_COLLECTION_ID);
  }

  /** Fetches the user's saved-track ids (Liked Songs), capped, to drive like-state. */
  async getSavedTrackIds(cap = 20_000): Promise<string[]> {
    const ids: string[] = [];
    let next: string | null = "/me/tracks?limit=50";
    const visitedPages = new Set<string>();
    while (next && ids.length < cap) {
      if (visitedPages.size >= 400 || visitedPages.has(next)) {
        throw new Error("Spotify returned an invalid Liked Songs pagination cursor.");
      }
      visitedPages.add(next);
      const response = await this.request(next, { method: "GET" });
      if (!response.ok) {
        throw await this.createSpotifyApiError(response, "Could not load all of your Liked Songs.");
      }
      const json = (await response.json()) as {
        items?: Array<{ track?: { id?: string | null } | null }>;
        next?: string | null;
      };
      for (const item of json.items ?? []) {
        if (item.track?.id) {
          ids.push(item.track.id);
        }
      }
      next = json.next ?? null;
    }
    if (next) {
      throw new Error("Your Spotify library is too large to load safely in one pass.");
    }
    return ids;
  }

  // ---- Catalog: artists & albums (engine-agnostic) ----

  /** Resolve an artist by display name — the fallback for tracks cached before creatorIds existed. */
  async searchArtist(name: string): Promise<SpotifyArtistProfile | undefined> {
    const cacheKey = `name:${name.trim().toLowerCase()}`;
    const cached = this.getCachedValue(this.artistCache, cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this.request(
      `/search?q=${encodeURIComponent(name)}&type=artist&limit=5`
    );
    if (!response.ok) {
      throw await this.createSpotifyApiError(response, "Spotify artist lookup failed.", "catalog");
    }
    const json = (await response.json()) as { artists?: { items?: SpotifyApiArtist[] } };
    const items = (json.artists?.items ?? []).filter((artist) => artist.id && artist.name);
    if (items.length === 0) {
      return undefined;
    }
    // Prefer the exact (case-insensitive) name match; Spotify's own ranking breaks ties.
    const wanted = name.trim().toLowerCase();
    const match = items.find((artist) => artist.name?.trim().toLowerCase() === wanted) ?? items[0];
    const profile = mapSpotifyApiArtist(match);
    this.setCachedValue(this.artistCache, cacheKey, profile, CATALOG_CACHE_TTL_MS);
    this.setCachedValue(this.artistCache, `id:${profile.id}`, profile, CATALOG_CACHE_TTL_MS);
    return profile;
  }

  async getArtist(artistId: string): Promise<SpotifyArtistProfile> {
    const cacheKey = `id:${artistId}`;
    const cached = this.getCachedValue(this.artistCache, cacheKey);
    if (cached) {
      return cached;
    }
    const response = await this.request(`/artists/${encodeURIComponent(artistId)}`);
    if (!response.ok) {
      throw await this.createSpotifyApiError(response, "Failed to load that artist.", "catalog");
    }
    const profile = mapSpotifyApiArtist((await response.json()) as SpotifyApiArtist);
    this.setCachedValue(this.artistCache, cacheKey, profile, CATALOG_CACHE_TTL_MS);
    return profile;
  }

  /**
   * Batch-fetch genres for many artist ids via `/artists?ids=` (≤50 per call). Spotify carries
   * genres at the artist level, so this is how the Library's genre chips and the radio genre gate
   * learn a Spotify track's genre (its tracks expose none). Per-artist cached like getArtist.
   */
  async getArtistGenres(artistIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const missing: string[] = [];
    for (const id of artistIds) {
      if (!id) {
        continue;
      }
      const cached = this.getCachedValue(this.artistCache, `id:${id}`);
      if (cached) {
        result.set(id, cached.genres);
      } else if (!result.has(id)) {
        missing.push(id);
      }
    }

    const unique = Array.from(new Set(missing));
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      let response: Response;
      try {
        response = await this.request(`/artists?ids=${batch.map(encodeURIComponent).join(",")}`);
      } catch {
        continue; // A failed batch just leaves those artists without genres — never fatal.
      }
      if (!response.ok) {
        continue;
      }
      const json = (await response.json()) as { artists?: SpotifyApiArtist[] };
      for (const artist of json.artists ?? []) {
        if (!artist?.id) {
          continue;
        }
        const profile = mapSpotifyApiArtist(artist);
        this.setCachedValue(this.artistCache, `id:${profile.id}`, profile, CATALOG_CACHE_TTL_MS);
        result.set(artist.id, profile.genres);
      }
    }
    return result;
  }

  async getArtistTopTracks(artistId: string): Promise<UnifiedTrack[]> {
    const cached = this.getCachedValue(this.artistTopTracksCache, artistId);
    if (cached) {
      return cached;
    }
    const response = await this.request(
      `/artists/${encodeURIComponent(artistId)}/top-tracks?market=from_token`
    );
    if (!response.ok) {
      throw await this.createSpotifyApiError(response, "Failed to load the artist's top tracks.", "catalog");
    }
    const json = (await response.json()) as { tracks?: SpotifyApiTrack[] };
    const tracks = (json.tracks ?? []).map(mapSpotifyApiTrack);
    this.setCachedValue(this.artistTopTracksCache, artistId, tracks, CATALOG_CACHE_TTL_MS);
    return tracks;
  }

  async getArtistAlbums(artistId: string): Promise<SpotifyAlbumSummary[]> {
    const cached = this.getCachedValue(this.artistAlbumsCache, artistId);
    if (cached) {
      return cached;
    }
    const response = await this.request(
      `/artists/${encodeURIComponent(artistId)}/albums?include_groups=album,single&market=from_token&limit=50`
    );
    if (!response.ok) {
      throw await this.createSpotifyApiError(response, "Failed to load the artist's albums.", "catalog");
    }
    const json = (await response.json()) as { items?: SpotifyApiAlbum[] };
    // Spotify lists near-duplicate releases (regional editions, re-issues) — keep the first of
    // each name, which is the most relevant per their own ranking.
    const seen = new Set<string>();
    const albums: SpotifyAlbumSummary[] = [];
    for (const album of json.items ?? []) {
      if (!album.id || !album.name) {
        continue;
      }
      const nameKey = album.name.trim().toLowerCase();
      if (seen.has(nameKey)) {
        continue;
      }
      seen.add(nameKey);
      albums.push(mapSpotifyApiAlbum(album));
    }
    this.setCachedValue(this.artistAlbumsCache, artistId, albums, CATALOG_CACHE_TTL_MS);
    return albums;
  }

  async getAlbumWithTracks(albumId: string): Promise<SpotifyAlbumDetail> {
    const cached = this.getCachedValue(this.albumCache, albumId);
    if (cached) {
      return cached;
    }
    const response = await this.request(
      `/albums/${encodeURIComponent(albumId)}?market=from_token`
    );
    if (!response.ok) {
      throw await this.createSpotifyApiError(response, "Failed to load that album.", "catalog");
    }
    const json = (await response.json()) as SpotifyApiAlbum & {
      tracks?: { items?: SpotifyApiTrack[]; next?: string | null };
    };
    const summary = mapSpotifyApiAlbum(json);
    const apiTracks = json.tracks?.items ?? [];
    let nextUrl = json.tracks?.next ?? undefined;
    while (nextUrl) {
      const pageResponse = await this.request(nextUrl);
      if (!pageResponse.ok) {
        break;
      }
      const pageJson = (await pageResponse.json()) as {
        items?: SpotifyApiTrack[];
        next?: string | null;
      };
      apiTracks.push(...(pageJson.items ?? []));
      nextUrl = pageJson.next ?? undefined;
    }
    const detail: SpotifyAlbumDetail = {
      ...summary,
      // Album-tracks payloads omit the album object — graft this album's art/name onto each track.
      tracks: apiTracks.map((track) =>
        mapSpotifyApiTrack({
          ...track,
          album: { id: summary.id, name: summary.name, images: [{ url: summary.imageUrl }] }
        })
      )
    };
    this.setCachedValue(this.albumCache, albumId, detail, CATALOG_CACHE_TTL_MS);
    return detail;
  }

  /** Resolve an album id by name + artist — the fallback for tracks cached before albumId existed. */
  async searchAlbum(albumName: string, artistName?: string): Promise<string | undefined> {
    const query = artistName ? `album:"${albumName}" artist:"${artistName}"` : `album:"${albumName}"`;
    const response = await this.request(
      `/search?q=${encodeURIComponent(query)}&type=album&limit=3`
    );
    if (!response.ok) {
      return undefined;
    }
    const json = (await response.json()) as { albums?: { items?: SpotifyApiAlbum[] } };
    return (json.albums?.items ?? []).find((album) => album.id)?.id;
  }

  // ---- Shared plumbing (used by data methods and by engine subclasses) ----

  protected async request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const cooldown = this.rateLimitedUntil - Date.now();
    if (cooldown > 0) {
      await this.delay(cooldown);
    }
    let token = await this.getAccessToken();
    if (!token) {
      throw new Error("Connect Spotify before requesting Spotify data.");
    }

    let response = await this.executeRequest(pathOrUrl, token, init);
    if (response.status === 401) {
      const refreshed = await this.options.refreshConnection();
      if (!refreshed?.accessToken) {
        throw new Error("Spotify session expired.");
      }

      token = refreshed.accessToken;
      response = await this.executeRequest(pathOrUrl, refreshed.accessToken, init);
    }

    const method = (init.method ?? "GET").toUpperCase();
    if (response.status === 429 && (method === "GET" || method === "HEAD")) {
      const retryAfter = response.headers.get("retry-after");
      const numericSeconds = Number(retryAfter);
      const dateDelay = retryAfter ? Date.parse(retryAfter) - Date.now() : Number.NaN;
      const waitMs = Math.min(
        30_000,
        Math.max(
          1_000,
          Number.isFinite(numericSeconds)
            ? numericSeconds * 1_000
            : Number.isFinite(dateDelay)
              ? dateDelay
              : 5_000
        )
      );
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + waitMs);
      await this.delay(waitMs + Math.floor(Math.random() * 250));
      response = await this.executeRequest(pathOrUrl, token, init);
    }

    return response;
  }

  protected async executeRequest(
    pathOrUrl: string,
    token: string,
    init: RequestInit
  ): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${token}`);

    const url = new URL(
      pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.spotify.com/v1${pathOrUrl}`
    );
    if (url.protocol !== "https:" || url.hostname !== "api.spotify.com") {
      throw new Error("Spotify returned an untrusted API URL.");
    }

    return fetch(url.toString(), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(12_000)
    });
  }

  protected async createSpotifyApiError(
    response: Response,
    fallback: string,
    // The 404/5xx copy below was written for the playback transport; catalog (artist/album
    // browsing) failures must not claim "playback is not ready" when nothing is playing.
    context: "playback" | "catalog" = "playback"
  ): Promise<Error> {
    const rawBody = await response.text();
    let status = response.status;
    let message = rawBody.trim();

    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as SpotifyApiErrorResponse;
        status = parsed.error?.status ?? status;
        message = parsed.error?.message?.trim() || message;
      } catch {
        // Spotify sometimes returns plain text.
      }
    }

    if (status === 403 && /premium/i.test(message)) {
      return new Error("Spotify playback requires a Premium account.");
    }

    if (status === 404) {
      return new Error(
        context === "playback"
          ? "Spotify playback is not ready yet. Wait a moment, then try again."
          : fallback
      );
    }

    if (status === 429) {
      return new Error("Spotify is rate limiting AMP right now. Wait a moment, then try again.");
    }

    if (status >= 500) {
      return new Error(
        context === "playback"
          ? "Spotify accepted AMP's connection, but playback did not start."
          : "Spotify had a temporary problem. Try again in a moment."
      );
    }

    return new Error(message || fallback);
  }

  protected isOAuthConnected(): boolean {
    return this.options.getConnection()?.status === "connected";
  }

  protected async getAccessToken(): Promise<string | undefined> {
    const connection = this.options.getConnection();
    const expiresSoon =
      connection?.expiresAt && new Date(connection.expiresAt).getTime() - Date.now() < 60_000;

    if (connection?.accessToken && !expiresSoon) {
      return connection.accessToken;
    }

    const refreshed = await this.options.refreshConnection();
    return refreshed?.accessToken ?? connection?.accessToken;
  }

  protected getCachedValue<T>(cache: Map<string, CachedValue<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  protected setCachedValue<T>(
    cache: Map<string, CachedValue<T>>,
    key: string,
    value: T,
    ttlMs: number
  ): void {
    if (!cache.has(key) && cache.size >= 100) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
  }

  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected emit(event: PlaybackAdapterEvent): void {
    this.snapshot = event.snapshot;
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export function mapSpotifyApiTrack(track: SpotifyApiTrack): UnifiedTrack {
  const id = track.id ?? "";
  // Keep creators and creatorIds aligned index-for-index so "go to artist" can trust the pairing.
  const artists = (track.artists ?? []).filter((artist): artist is { id?: string; name: string } =>
    Boolean(artist.name)
  );
  const creators = artists.map((artist) => artist.name).slice(0, 3);
  const creatorIds = artists.map((artist) => artist.id ?? "").slice(0, 3);

  return {
    id: `spotify:${id}`,
    provider: "spotify",
    providerTrackId: id,
    providerUri: track.uri ?? (id ? `spotify:track:${id}` : undefined),
    title: track.name ?? "Unknown",
    creators,
    creatorIds: creatorIds.some(Boolean) ? creatorIds : undefined,
    album: track.album?.name,
    albumId: track.album?.id,
    artworkUrl: track.album?.images?.[0]?.url,
    durationMs: track.duration_ms ?? 0,
    explicit: Boolean(track.explicit),
    externalUrl: track.external_urls?.spotify,
    playable: track.is_playable !== false
  };
}

function mapSpotifyApiArtist(artist: SpotifyApiArtist): SpotifyArtistProfile {
  return {
    id: artist.id ?? "",
    name: artist.name ?? "Unknown artist",
    imageUrl: artist.images?.[0]?.url,
    genres: artist.genres ?? [],
    followers: artist.followers?.total,
    externalUrl: artist.external_urls?.spotify
  };
}

function mapSpotifyApiAlbum(album: SpotifyApiAlbum): SpotifyAlbumSummary {
  return {
    id: album.id ?? "",
    name: album.name ?? "Unknown album",
    albumType: album.album_type,
    releaseYear: album.release_date?.slice(0, 4),
    totalTracks: album.total_tracks,
    imageUrl: album.images?.[0]?.url,
    externalUrl: album.external_urls?.spotify,
    artistNames: (album.artists ?? [])
      .map((artist) => artist.name)
      .filter((name): name is string => Boolean(name))
  };
}
