import type { ProviderCollection, TrackCollection, UnifiedTrack } from "@amp/core";
import type { CacheStore } from "./CacheStore";
import type { GatewayResponse } from "./types";
import { StealthClient } from "./StealthClient";
import { createHmac, randomBytes } from "node:crypto";

interface SpotifyPartnerSearchResponse {
  data?: {
    searchV2?: {
      tracksV2?: {
        items?: Array<{
          item?: {
            data?: {
              uri?: string;
              name?: string;
              duration?: { totalMilliseconds?: number };
              explicit?: boolean;
              albumOfTrack?: {
                uri?: string;
                name?: string;
                coverArt?: { sources?: Array<{ url?: string }> };
              };
              artists?: {
                items?: Array<{ profile?: { name?: string }; uri?: string }>;
              };
            };
          };
        }>;
      };
    };
  };
}

interface SpotifyPartnerPlaylistResponse {
  data?: {
    playlistV2?: {
      name?: string;
      description?: string;
      images?: { items?: Array<{ sources?: Array<{ url?: string }> }> };
      ownerV2?: { data?: { name?: string } };
      content?: {
        totalCount?: number;
        items?: Array<{
          itemV2?: {
            data?: {
              uri?: string;
              name?: string;
              duration?: { totalMilliseconds?: number };
              explicit?: boolean;
              albumOfTrack?: {
                uri?: string;
                name?: string;
                coverArt?: { sources?: Array<{ url?: string }> };
              };
              artists?: {
                items?: Array<{ profile?: { name?: string }; uri?: string }>;
              };
            };
          };
        }>;
      };
    };
  };
}

interface SpotifyPartnerLibraryResponse {
  data?: {
    me?: {
      library?: {
        tracks?: {
          totalCount?: number;
          items?: Array<{
            track?: {
              uri?: string;
              name?: string;
              duration?: { totalMilliseconds?: number };
              explicit?: boolean;
              album?: {
                uri?: string;
                name?: string;
                coverArt?: { sources?: Array<{ url?: string }> };
              };
              artists?: {
                items?: Array<{ profile?: { name?: string }; uri?: string }>;
              };
            };
          }>;
        };
      };
    };
  };
}

interface SpotifyPartnerUserPlaylistsResponse {
  data?: {
    me?: {
      playlists?: {
        totalCount?: number;
        items?: Array<{
          data?: {
            uri?: string;
            name?: string;
            description?: string;
            images?: { items?: Array<{ sources?: Array<{ url?: string }> }> };
            ownerV2?: { data?: { name?: string } };
            content?: { totalCount?: number };
          };
        }>;
      };
    };
  };
}

interface OperationHashEntry {
  name: string;
  hash: string;
  fetchedAt: number;
}

interface SpotifyAnonymousSession {
  accessToken: string;
  clientId: string;
  clientToken: string;
  deviceId: string;
  clientVersion: string;
  expiresAt: number;
}

interface SpotifyTrackResponse {
  preview_url?: string;
}

const SPOTIFY_PARTNER_API_BASE = "https://api-partner.spotify.com/pathfinder/v1/query";
const SPOTIFY_CLIENT_TOKEN_API = "https://clienttoken.spotify.com/v1/clienttoken";
const SPOTIFY_WEB_APP_URL = "https://open.spotify.com";
const SPOTIFY_TOKEN_API = "https://open.spotify.com/api/token";
const HASH_CACHE_TTL_MS = 24 * 60 * 60_000;
const SEARCH_CACHE_TTL_MS = 90_000;
const COLLECTION_CACHE_TTL_MS = 2 * 60_000;
const ANONYMOUS_SESSION_TTL_MS = 55 * 60 * 1000; // 55 minutes

// TOTP secrets for Spotify anonymous token generation.
// These are reverse-engineered from Spotify's web player and may need updating.
const TOTP_SECRETS: Record<number, number[]> = {
  59: [123, 105, 79, 70, 110, 59, 52, 125, 60, 49, 80, 70, 89, 75, 80, 86, 63, 53, 123, 37, 117, 49, 52, 93, 77, 62, 47, 86, 48, 104, 68, 72],
  60: [79, 109, 69, 123, 90, 65, 46, 74, 94, 34, 58, 48, 70, 71, 92, 85, 122, 63, 91, 64, 87, 87],
  61: [44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102, 43, 69, 49, 120, 118, 80, 64, 78]
};

export class SpotifyPartnerGateway {
  private client: StealthClient;
  private cache: CacheStore;
  private operationHashes = new Map<string, string>();
  private hashDiscoveryPromise: Promise<void> | undefined;
  private clientToken: string | undefined;
  private clientTokenExpiresAt = 0;
  private anonymousSession: SpotifyAnonymousSession | undefined;
  private anonymousSessionPromise: Promise<SpotifyAnonymousSession | undefined> | undefined;

  constructor(cache: CacheStore) {
    this.client = new StealthClient();
    this.client.setDefaultHeader("Origin", "https://open.spotify.com");
    this.client.setDefaultHeader("Referer", "https://open.spotify.com/");
    this.client.setDefaultHeader("Accept", "application/json");
    this.client.setDefaultHeader("app-platform", "WebPlayer");
    this.cache = cache;
  }

  async initialize(): Promise<void> {
    await this.discoverOperationHashes();
  }

  async search(query: string, accessToken: string): Promise<GatewayResponse<UnifiedTrack[]>> {
    const cacheKey = `spotify:search:${query.trim().toLowerCase()}`;
    const cached = this.cache.get<UnifiedTrack[]>(cacheKey);
    if (cached) {
      return { ok: true, data: cached, source: "cache" };
    }

    const hash = this.operationHashes.get("searchDesktop");
    if (!hash) {
      return { ok: false, error: "Spotify Partner API operation hashes not available.", source: "fallback" };
    }

    try {
      const clientToken = await this.ensureClientToken();
      const response = await this.client.request(SPOTIFY_PARTNER_API_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(clientToken ? { "client-token": clientToken } : {})
        },
        body: JSON.stringify({
          operationName: "searchDesktop",
          variables: {
            searchTerm: query,
            offset: 0,
            limit: 18,
            numberOfTopResults: 5,
            includeAudiobooks: false
          },
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: hash
            }
          }
        })
      });

      if (response.status !== 200) {
        return {
          ok: false,
          error: `Spotify Partner API returned ${response.status}`,
          source: "internal"
        };
      }

      const json = JSON.parse(response.body) as SpotifyPartnerSearchResponse;
      const tracks =
        json.data?.searchV2?.tracksV2?.items
          ?.map((item) => item.item?.data)
          .filter((track): track is PartnerTrackData => Boolean(track))
          .map(mapPartnerTrack) ?? [];

      this.cache.set(cacheKey, tracks, SEARCH_CACHE_TTL_MS);
      return { ok: true, data: tracks, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Spotify Partner search failed.",
        source: "internal"
      };
    }
  }

  async getCollections(accessToken: string): Promise<GatewayResponse<ProviderCollection[]>> {
    const cacheKey = "spotify:collections";
    const cached = this.cache.get<ProviderCollection[]>(cacheKey);
    if (cached) {
      return { ok: true, data: cached, source: "cache" };
    }

    const [savedTracksResult, playlistsResult] = await Promise.all([
      this.fetchSavedTracksCount(accessToken),
      this.fetchUserPlaylists(accessToken)
    ]);

    if (!savedTracksResult.ok && !playlistsResult.ok) {
      return {
        ok: false,
        error: savedTracksResult.error ?? playlistsResult.error ?? "Failed to fetch Spotify collections.",
        source: "internal"
      };
    }

    const collections: ProviderCollection[] = [
      {
        id: "saved-tracks",
        provider: "spotify",
        kind: "saved-tracks",
        title: "Saved Tracks",
        trackCount: savedTracksResult.ok ? (savedTracksResult.data ?? 0) : 0
      },
      ...(playlistsResult.ok
        ? (playlistsResult.data ?? []).map((playlist) => ({
            id: playlist.id,
            provider: "spotify" as const,
            kind: "playlist" as const,
            title: playlist.title,
            trackCount: playlist.trackCount,
            artworkUrl: playlist.artworkUrl,
            externalUrl: playlist.externalUrl,
            description: playlist.description,
            ownerName: playlist.ownerName
          }))
        : [])
    ];

    this.cache.set(cacheKey, collections, COLLECTION_CACHE_TTL_MS);
    return { ok: true, data: collections, source: "internal" };
  }

  async getCollectionTracks(
    collectionId: string,
    accessToken: string
  ): Promise<GatewayResponse<TrackCollection>> {
    const cacheKey = `spotify:collection:${collectionId}`;
    const cached = this.cache.get<TrackCollection>(cacheKey);
    if (cached) {
      return { ok: true, data: cached, source: "cache" };
    }

    if (collectionId === "saved-tracks") {
      return this.fetchSavedTracks(accessToken, cacheKey);
    }

    return this.fetchPlaylistTracks(collectionId, accessToken, cacheKey);
  }

  private async fetchSavedTracksCount(accessToken: string): Promise<GatewayResponse<number>> {
    const hash = this.operationHashes.get("fetchLibraryTracks");
    if (!hash) {
      return { ok: false, error: "Missing operation hash.", source: "internal" };
    }

    try {
      const clientToken = await this.ensureClientToken();
      const response = await this.client.request(SPOTIFY_PARTNER_API_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(clientToken ? { "client-token": clientToken } : {})
        },
        body: JSON.stringify({
          operationName: "fetchLibraryTracks",
          variables: { offset: 0, limit: 1 },
          extensions: {
            persistedQuery: { version: 1, sha256Hash: hash }
          }
        })
      });

      if (response.status !== 200) {
        return { ok: false, error: `HTTP ${response.status}`, source: "internal" };
      }

      const json = JSON.parse(response.body) as SpotifyPartnerLibraryResponse;
      const count = json.data?.me?.library?.tracks?.totalCount ?? 0;
      return { ok: true, data: count, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch saved tracks count.",
        source: "internal"
      };
    }
  }

  private async fetchUserPlaylists(
    accessToken: string
  ): Promise<GatewayResponse<ProviderCollection[]>> {
    const hash = this.operationHashes.get("fetchUserPlaylists");
    if (!hash) {
      return { ok: false, error: "Missing operation hash.", source: "internal" };
    }

    try {
      const clientToken = await this.ensureClientToken();
      const response = await this.client.request(SPOTIFY_PARTNER_API_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(clientToken ? { "client-token": clientToken } : {})
        },
        body: JSON.stringify({
          operationName: "fetchUserPlaylists",
          variables: { offset: 0, limit: 50 },
          extensions: {
            persistedQuery: { version: 1, sha256Hash: hash }
          }
        })
      });

      if (response.status !== 200) {
        return { ok: false, error: `HTTP ${response.status}`, source: "internal" };
      }

      const json = JSON.parse(response.body) as SpotifyPartnerUserPlaylistsResponse;
      const playlists =
        json.data?.me?.playlists?.items?.map((item) => {
          const data = item.data;
          const playlistId = data?.uri?.replace("spotify:playlist:", "") ?? "";
          return {
            id: playlistId,
            provider: "spotify" as const,
            kind: "playlist" as const,
            title: data?.name ?? "Untitled",
            trackCount: data?.content?.totalCount ?? 0,
            artworkUrl: data?.images?.items?.[0]?.sources?.[0]?.url,
            externalUrl: `https://open.spotify.com/playlist/${playlistId}`,
            description: data?.description ?? undefined,
            ownerName: data?.ownerV2?.data?.name
          };
        }) ?? [];

      return { ok: true, data: playlists, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch playlists.",
        source: "internal"
      };
    }
  }

  private async fetchSavedTracks(
    accessToken: string,
    cacheKey: string
  ): Promise<GatewayResponse<TrackCollection>> {
    const hash = this.operationHashes.get("fetchLibraryTracks");
    if (!hash) {
      return { ok: false, error: "Missing operation hash.", source: "internal" };
    }

    try {
      const clientToken = await this.ensureClientToken();
      const tracks: UnifiedTrack[] = [];
      let offset = 0;
      const limit = 50;

      while (true) {
        const response = await this.client.request(SPOTIFY_PARTNER_API_BASE, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...(clientToken ? { "client-token": clientToken } : {})
          },
          body: JSON.stringify({
            operationName: "fetchLibraryTracks",
            variables: { offset, limit },
            extensions: {
              persistedQuery: { version: 1, sha256Hash: hash }
            }
          })
        });

        if (response.status !== 200) {
          throw new Error(`Spotify saved tracks returned ${response.status}.`);
        }

        const json = JSON.parse(response.body) as SpotifyPartnerLibraryResponse;
        const items =
          json.data?.me?.library?.tracks?.items
            ?.map((item) => item.track)
            .filter((track): track is PartnerTrackData => Boolean(track))
            .map(mapPartnerLibraryTrack) ?? [];

        tracks.push(...items);
        if (items.length < limit) break;
        offset += limit;
      }

      const collection: TrackCollection = {
        id: "saved-tracks",
        provider: "spotify",
        kind: "saved-tracks",
        title: "Saved Tracks",
        items: tracks
      };

      this.cache.set(cacheKey, collection, COLLECTION_CACHE_TTL_MS);
      return { ok: true, data: collection, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch saved tracks.",
        source: "internal"
      };
    }
  }

  private async fetchPlaylistTracks(
    playlistId: string,
    accessToken: string,
    cacheKey: string
  ): Promise<GatewayResponse<TrackCollection>> {
    const hash = this.operationHashes.get("fetchPlaylist");
    if (!hash) {
      return { ok: false, error: "Missing operation hash.", source: "internal" };
    }

    try {
      const clientToken = await this.ensureClientToken();
      const response = await this.client.request(SPOTIFY_PARTNER_API_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...(clientToken ? { "client-token": clientToken } : {})
        },
        body: JSON.stringify({
          operationName: "fetchPlaylist",
          variables: { uri: `spotify:playlist:${playlistId}`, offset: 0, limit: 100 },
          extensions: {
            persistedQuery: { version: 1, sha256Hash: hash }
          }
        })
      });

      if (response.status !== 200) {
        return { ok: false, error: `HTTP ${response.status}`, source: "internal" };
      }

      const json = JSON.parse(response.body) as SpotifyPartnerPlaylistResponse;
      const playlist = json.data?.playlistV2;
      const tracks =
        playlist?.content?.items
          ?.map((item) => item.itemV2?.data)
          .filter((track): track is PartnerTrackData => Boolean(track))
          .map(mapPartnerTrack) ?? [];

      const collection: TrackCollection = {
        id: playlistId,
        provider: "spotify",
        kind: "playlist",
        title: playlist?.name ?? "Playlist",
        artworkUrl: playlist?.images?.items?.[0]?.sources?.[0]?.url,
        externalUrl: `https://open.spotify.com/playlist/${playlistId}`,
        description: playlist?.description ?? undefined,
        ownerName: playlist?.ownerV2?.data?.name,
        items: tracks
      };

      this.cache.set(cacheKey, collection, COLLECTION_CACHE_TTL_MS);
      return { ok: true, data: collection, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch playlist tracks.",
        source: "internal"
      };
    }
  }

  async getAnonymousSession(): Promise<SpotifyAnonymousSession | undefined> {
    if (this.anonymousSession && this.anonymousSession.expiresAt > Date.now() + 60_000) {
      return this.anonymousSession;
    }

    if (this.anonymousSessionPromise) {
      return this.anonymousSessionPromise;
    }

    this.anonymousSessionPromise = this.generateAnonymousSession();
    const session = await this.anonymousSessionPromise;
    this.anonymousSessionPromise = undefined;
    return session;
  }

  async getTrackPreviewUrl(trackId: string): Promise<GatewayResponse<string>> {
    const session = await this.getAnonymousSession();
    if (!session) {
      return { ok: false, error: "Could not generate anonymous Spotify session.", source: "fallback" };
    }

    try {
      const response = await this.client.request(`https://api.spotify.com/v1/tracks/${trackId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.accessToken}`
        }
      });

      if (response.status !== 200) {
        return {
          ok: false,
          error: `Spotify API returned ${response.status}`,
          source: "internal"
        };
      }

      const json = JSON.parse(response.body) as SpotifyTrackResponse;
      const previewUrl = json.preview_url;
      if (!previewUrl) {
        return {
          ok: false,
          error: "No preview available for this track.",
          source: "internal"
        };
      }

      return { ok: true, data: previewUrl, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch preview URL.",
        source: "internal"
      };
    }
  }

  private async generateAnonymousSession(): Promise<SpotifyAnonymousSession | undefined> {
    try {
      // Step 1: Fetch open.spotify.com to get device_id and client_version
      const htmlResponse = await this.client.request(SPOTIFY_WEB_APP_URL, {
        method: "GET",
        headers: { Accept: "text/html" }
      });

      if (htmlResponse.status !== 200) {
        throw new Error("Could not fetch Spotify web app.");
      }

      // Extract sp_t cookie (device_id)
      const setCookie = htmlResponse.headers["set-cookie"] ?? "";
      const deviceIdMatch = /sp_t=([^;]+)/.exec(setCookie);
      const deviceId = deviceIdMatch?.[1] ?? randomBytes(16).toString("hex");

      // Extract clientVersion
      let clientVersion = "";
      const appServerConfigMatch = /<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/.exec(htmlResponse.body);
      if (appServerConfigMatch) {
        try {
          const decoded = Buffer.from(appServerConfigMatch[1], "base64").toString("utf-8");
          const config = JSON.parse(decoded);
          clientVersion = config.clientVersion ?? "";
        } catch {
          // ignore
        }
      }
      if (!clientVersion) {
        const versionMatch = /"clientVersion":"([^"]+)"/.exec(htmlResponse.body);
        clientVersion = versionMatch?.[1] ?? "1.2.48.404";
      }

      // Step 2: Generate TOTP
      const totpVersion = 61;
      const secret = TOTP_SECRETS[totpVersion];
      if (!secret) {
        throw new Error("TOTP secret not available.");
      }
      const totp = SpotifyPartnerGateway.generateTOTP(secret);

      // Step 3: Get anonymous access token
      const tokenUrl = new URL(SPOTIFY_TOKEN_API);
      tokenUrl.searchParams.set("reason", "init");
      tokenUrl.searchParams.set("productType", "web-player");
      tokenUrl.searchParams.set("totp", totp);
      tokenUrl.searchParams.set("totpVer", String(totpVersion));
      tokenUrl.searchParams.set("totpServer", totp);

      const tokenResponse = await this.client.request(tokenUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });

      if (tokenResponse.status !== 200) {
        throw new Error(`Token endpoint returned ${tokenResponse.status}`);
      }

      const tokenData = JSON.parse(tokenResponse.body) as { accessToken?: string; clientId?: string };
      const accessToken = tokenData.accessToken;
      const clientId = tokenData.clientId;
      if (!accessToken || !clientId) {
        throw new Error("Anonymous token response missing required fields.");
      }

      // Step 4: Get client token using the anonymous clientId
      const clientToken = await this.fetchClientToken(clientVersion, clientId, deviceId);

      const session: SpotifyAnonymousSession = {
        accessToken,
        clientId,
        clientToken: clientToken ?? "",
        deviceId,
        clientVersion,
        // A session without a client token is degraded — expire it quickly so a transient
        // client-token fetch failure doesn't pin token-less requests for the full TTL.
        expiresAt: Date.now() + (clientToken ? ANONYMOUS_SESSION_TTL_MS : 5 * 60_000)
      };

      this.anonymousSession = session;
      return session;
    } catch (error) {
      console.error("Failed to generate anonymous Spotify session:", error);
      return undefined;
    }
  }

  private static generateTOTP(secret: number[]): string {
    const transformed = secret.map((e, t) => e ^ ((t % 33) + 9));
    const secretStr = transformed.map((n) => String(n)).join("");
    const secretBytes = Buffer.from(secretStr, "ascii");

    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigUInt64BE(BigInt.asUintN(64, BigInt(timeStep)), 0);

    const hmacResult = createHmac("sha1", secretBytes).update(timeBuffer).digest();

    const offset = hmacResult[hmacResult.length - 1] & 0x0f;
    const code =
      ((hmacResult[offset] & 0x7f) << 24) |
      ((hmacResult[offset + 1] & 0xff) << 16) |
      ((hmacResult[offset + 2] & 0xff) << 8) |
      (hmacResult[offset + 3] & 0xff);

    return String(code % 1_000_000).padStart(6, "0");
  }

  private async fetchClientToken(
    clientVersion: string,
    clientId: string,
    deviceId: string
  ): Promise<string | undefined> {
    try {
      const response = await this.client.request(SPOTIFY_CLIENT_TOKEN_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client_data: {
            client_id: clientId,
            client_version: clientVersion,
            js_sdk_data: {
              device_brand: "unknown",
              device_model: "unknown",
              os: "Windows",
              os_version: "NT 10.0",
              device_id: deviceId,
              device_type: "computer"
            }
          }
        })
      });

      if (response.status === 200) {
        const json = JSON.parse(response.body) as {
          granted_token?: { token?: string; expires_after_seconds?: number };
        };
        return json.granted_token?.token;
      }
    } catch {
      // Client token is optional for many endpoints.
    }
    return undefined;
  }

  private async ensureClientToken(): Promise<string | undefined> {
    if (this.clientToken && this.clientTokenExpiresAt > Date.now()) {
      return this.clientToken;
    }

    try {
      const response = await this.client.request(SPOTIFY_CLIENT_TOKEN_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client_data: {
            client_id: "d8a5ed958d274c2e8ee717e6a4b0971d",
            client_version: "1.2.48.404",
            js_sdk_data: {
              device_brand: "unknown",
              device_model: "unknown",
              os: "Windows",
              os_version: "NT 10.0"
            }
          }
        })
      });

      if (response.status === 200) {
        const json = JSON.parse(response.body) as { granted_token?: { token?: string; expires_after_seconds?: number } };
        const token = json.granted_token?.token;
        if (token) {
          this.clientToken = token;
          this.clientTokenExpiresAt = Date.now() + (json.granted_token?.expires_after_seconds ?? 3600) * 1000;
          return token;
        }
      }
    } catch {
      // Client token is optional for many endpoints.
    }

    return undefined;
  }

  private async discoverOperationHashes(): Promise<void> {
    if (this.hashDiscoveryPromise) {
      return this.hashDiscoveryPromise;
    }

    this.hashDiscoveryPromise = this.performHashDiscovery();
    return this.hashDiscoveryPromise;
  }

  private async performHashDiscovery(): Promise<void> {
    // Try to load cached hashes first
    const cached = this.cache.get<OperationHashEntry[]>("spotify:operation-hashes");
    if (cached && cached.length > 0 && cached[0].fetchedAt + HASH_CACHE_TTL_MS > Date.now()) {
      for (const entry of cached) {
        this.operationHashes.set(entry.name, entry.hash);
      }
      return;
    }

    try {
      // Fetch open.spotify.com HTML to find JS bundle URLs
      const htmlResponse = await this.client.request(SPOTIFY_WEB_APP_URL, {
        method: "GET",
        headers: { Accept: "text/html" }
      });

      if (htmlResponse.status !== 200) {
        throw new Error("Could not fetch Spotify web app.");
      }

      // Extract JS bundle URLs from HTML
      const jsUrls = this.extractJsUrls(htmlResponse.body, SPOTIFY_WEB_APP_URL);
      const hashes: OperationHashEntry[] = [];

      // Search bundles for operation hash mappings
      for (const url of jsUrls.slice(0, 8)) {
        try {
          const bundleResponse = await this.client.request(url, {
            method: "GET",
            timeoutMs: 10000
          });

          if (bundleResponse.status === 200) {
            const extracted = this.extractOperationHashes(bundleResponse.body);
            for (const [name, hash] of extracted) {
              if (!this.operationHashes.has(name)) {
                this.operationHashes.set(name, hash);
                hashes.push({ name, hash, fetchedAt: Date.now() });
              }
            }
          }
        } catch {
          // Bundle fetch failure is non-critical.
        }
      }

      if (hashes.length > 0) {
        this.cache.set("spotify:operation-hashes", hashes, HASH_CACHE_TTL_MS);
      }
    } catch {
      // If discovery fails, fall back to well-known hashes
    }

    // Merge well-known hashes for any operation discovery didn't find — a PARTIAL discovery
    // (e.g. searchDesktop found, fetchPlaylist missing) used to skip seeding entirely and the
    // missing operations failed with "Missing operation hash".
    this.seedWellKnownHashes();
  }

  private extractJsUrls(html: string, baseUrl: string): string[] {
    const urls: string[] = [];
    // Match script src attributes
    const scriptRegex = /<script[^>]+src="([^"]+\.js)"/g;
    let match: RegExpExecArray | null;
    while ((match = scriptRegex.exec(html)) !== null) {
      const src = match[1];
      if (src.startsWith("http")) {
        urls.push(src);
      } else if (src.startsWith("/")) {
        const base = new URL(baseUrl);
        urls.push(`${base.protocol}//${base.host}${src}`);
      }
    }
    return urls;
  }

  private extractOperationHashes(source: string): Map<string, string> {
    const hashes = new Map<string, string>();

    // Pattern 1: Object literal mapping operation names to hashes
    // e.g., {searchDesktop:"abc123",fetchPlaylist:"def456"}
    const objectPattern = /"(\w+)":"([a-f0-9]{64})"/g;
    let match: RegExpExecArray | null;
    while ((match = objectPattern.exec(source)) !== null) {
      const name = match[1];
      const hash = match[2];
      if (this.looksLikeOperationName(name)) {
        hashes.set(name, hash);
      }
    }

    // Pattern 2: persistedQuery references with hash nearby
    const persistedPattern = /operationName[:\s]*"(\w+)"[^}]{0,500}sha256Hash[:\s]*"([a-f0-9]{64})"/g;
    while ((match = persistedPattern.exec(source)) !== null) {
      const name = match[1];
      const hash = match[2];
      if (this.looksLikeOperationName(name)) {
        hashes.set(name, hash);
      }
    }

    return hashes;
  }

  private looksLikeOperationName(name: string): boolean {
    const knownPrefixes = ["search", "fetch", "get", "query", "mutation"];
    return knownPrefixes.some((prefix) => name.toLowerCase().startsWith(prefix));
  }

  private seedWellKnownHashes(): void {
    // These are community-documented hashes for the Spotify Partner API.
    // They may need updating as Spotify evolves their web app.
    // (fetchLibraryTracks/fetchUserPlaylists previously carried 65-char placeholder values —
    // not real sha256 hashes — which turned a clean "Missing operation hash" error into a
    // confusing bogus request, so they were removed.)
    const wellKnown: Record<string, string> = {
      searchDesktop:
        "dfd9874bab4757583f1327e0909b466789d5bd4f8e053232c2c85a2e8be4bb02",
      fetchPlaylist:
        "19ff1327c475e0615a4e836518fed44666b8f896a343ca95d25e3e9b8f0f1a15"
    };

    for (const [name, hash] of Object.entries(wellKnown)) {
      if (!this.operationHashes.has(name)) {
        this.operationHashes.set(name, hash);
      }
    }
  }
}

interface PartnerTrackData {
  uri?: string;
  name?: string;
  duration?: { totalMilliseconds?: number };
  explicit?: boolean;
  albumOfTrack?: {
    uri?: string;
    name?: string;
    coverArt?: { sources?: Array<{ url?: string }> };
  };
  album?: {
    uri?: string;
    name?: string;
    coverArt?: { sources?: Array<{ url?: string }> };
  };
  artists?: {
    items?: Array<{ profile?: { name?: string }; uri?: string }>;
  };
}

function mapPartnerTrack(track: PartnerTrackData): UnifiedTrack {
  const trackId = track.uri?.replace("spotify:track:", "") ?? "";
  return {
    id: `spotify:${trackId}`,
    provider: "spotify",
    providerTrackId: trackId,
    providerUri: track.uri,
    title: track.name ?? "Unknown",
    creators: (track.artists?.items ?? [])
      .map((artist: { profile?: { name?: string } }) => artist.profile?.name)
      .filter(Boolean) as string[],
    album: track.albumOfTrack?.name ?? track.album?.name,
    artworkUrl: track.albumOfTrack?.coverArt?.sources?.[0]?.url ?? track.album?.coverArt?.sources?.[0]?.url,
    durationMs: track.duration?.totalMilliseconds ?? 0,
    explicit: track.explicit ?? false,
    externalUrl: `https://open.spotify.com/track/${trackId}`,
    playable: true
  };
}

function mapPartnerLibraryTrack(track: PartnerTrackData): UnifiedTrack {
  const trackId = track.uri?.replace("spotify:track:", "") ?? "";
  return {
    id: `spotify:${trackId}`,
    provider: "spotify",
    providerTrackId: trackId,
    providerUri: track.uri,
    title: track.name ?? "Unknown",
    creators: (track.artists?.items ?? [])
      .map((artist: { profile?: { name?: string } }) => artist.profile?.name)
      .filter(Boolean) as string[],
    album: track.album?.name,
    artworkUrl: track.album?.coverArt?.sources?.[0]?.url,
    durationMs: track.duration?.totalMilliseconds ?? 0,
    explicit: track.explicit ?? false,
    externalUrl: `https://open.spotify.com/track/${trackId}`,
    playable: true
  };
}
