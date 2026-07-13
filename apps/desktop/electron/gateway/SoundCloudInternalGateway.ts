/*
 * ─── SOUNDCLOUD PLAYBACK — GROUND TRUTH (do NOT re-litigate; entitlement is not the issue) ───
 * NO track here requires Go+. Every liked track (incl. "DRM"/major-label ones like
 * Pop 1685274354) plays fine for THIS account in Chrome/Brave/Safari/Edge — no pay,
 * no Go+, never a problem. So a 403 in AMP is NEVER entitlement; it is a request-
 * context delta vs. a real browser (DataDome/anti-bot, cookies/session, CDM, headers).
 * The real browser request is the working reference — match it.
 */
import type { ProviderCollection, TrackCollection, UnifiedTrack } from "@amp/core";
import type { CacheStore } from "./CacheStore";
import type { GatewayResponse } from "./types";
import { StealthClient } from "./StealthClient";
import { resolveMediaInPage, probeNativePlaybackOnce } from "../SoundCloudResolverWindow";
import { appendFileSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const RESOLVE_LOG_PATH = path.join(process.env.TEMP ?? os.tmpdir(), "amp-soundcloud-resolve.log");
// Sync file I/O on the stream-resolve hot path is debug tooling — opt in via env var.
const RESOLVE_LOG_ENABLED = process.env.AMP_DEBUG_RESOLVE_LOG === "1";
const RESOLVE_LOG_MAX_BYTES = 2 * 1024 * 1024;

function logResolve(message: string, data?: unknown): void {
  if (!RESOLVE_LOG_ENABLED) {
    return;
  }
  const line = `[${new Date().toISOString()}] ${message}${data ? ` | ${JSON.stringify(data)}` : ""}\n`;
  try {
    if ((statSync(RESOLVE_LOG_PATH, { throwIfNoEntry: false })?.size ?? 0) > RESOLVE_LOG_MAX_BYTES) {
      unlinkSync(RESOLVE_LOG_PATH);
    }
    appendFileSync(RESOLVE_LOG_PATH, line, "utf8");
  } catch {
    // ignore
  }
}

function parseJsonBody<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

interface SoundCloudInternalTrack {
  id?: number;
  urn?: string;
  title?: string;
  duration?: number;
  artwork_url?: string | null;
  permalink_url?: string;
  stream_url?: string;
  streamable?: boolean;
  access?: "playable" | "preview" | "blocked";
  description?: string;
  genre?: string;
  track_authorization?: string;
  media?: {
    transcodings?: Array<{
      preset?: string;
      url?: string;
      format?: { protocol?: string; mime_type?: string };
    }>;
  };
  user?: {
    username?: string;
    full_name?: string;
  };
  publisher_metadata?: { artist?: string };
  policy?: string;
}

interface SoundCloudInternalSearchResponse {
  collection?: SoundCloudInternalTrack[];
  total_results?: number;
  next_href?: string;
}

interface SoundCloudTranscoding {
  preset?: string;
  url?: string;
  format?: { protocol?: string; mime_type?: string };
}

interface SoundCloudInternalPlaylist {
  id?: number;
  urn?: string;
  title?: string;
  description?: string;
  permalink_url?: string;
  artwork_url?: string | null;
  track_count?: number;
  tracks?: SoundCloudInternalTrack[];
  user?: { username?: string; full_name?: string };
}

interface SoundCloudInternalPaginatedResponse<T> {
  collection?: T[];
  next_href?: string;
}

interface SoundCloudInternalStreamResponse {
  url?: string;
  // Encrypted (DRM) renditions return a per-stream token the license request must carry.
  licenseAuthToken?: string;
}

interface SoundCloudStreamDrm {
  system: "widevine";
  licenseUrl: string;
  licenseAuthToken?: string;
  /** The SoundCloud OAuth token that was used to resolve the stream. Passed to the renderer so
   * the license request can include the same auth context the official player uses. */
  oauthToken?: string;
  /** The track-level authorization token from the track object (not the stream response).
   *  Required by the license server for monetized tracks. */
  trackAuthorization?: string;
}

export interface SoundCloudStreamResult {
  url: string;
  drm?: SoundCloudStreamDrm;
}

interface SoundCloudInternalUser {
  id?: number;
  kind?: string;
  username?: string;
  full_name?: string;
}

interface SoundCloudTrackLikeItem {
  track?: SoundCloudInternalTrack;
}

export interface SoundCloudProfileResultDTO {
  displayName: string;
  likes: UnifiedTrack[];
  uploads: UnifiedTrack[];
  playlists: ProviderCollection[];
  /** Detected subscription tier from the /me endpoint. */
  subscriptionTier?: "unknown" | "free" | "go" | "go-plus";
}

interface SoundCloudAssetBundle {
  clientId: string;
  appVersion: string;
  appLocale: string;
  signingKey?: string;
  fetchedAt: number;
}

const SOUNDCLOUD_OFFICIAL_API_BASE = "https://api.soundcloud.com";
const SOUNDCLOUD_PUBLIC_API_BASE = "https://api-v2.soundcloud.com";
const SOUNDCLOUD_WEB_URL = "https://soundcloud.com";
const SOUNDCLOUD_MOBILE_URL = "https://m.soundcloud.com";
// SoundCloud's Widevine license server (reverse-engineered from their player JS: drm_license_host
// + "/playback/widevine"). Monetized tracks (policy=MONETIZE) only stream as CENC ctr-encrypted-hls.
const SOUNDCLOUD_WIDEVINE_LICENSE_URL = "https://license.media-streaming.soundcloud.cloud/playback/widevine";
const SEARCH_CACHE_TTL_MS = 90_000;
const TRACK_CACHE_TTL_MS = 10 * 60_000;
const STREAM_CACHE_TTL_MS = 2 * 60_000;
const COLLECTION_CACHE_TTL_MS = 2 * 60_000;
const BUNDLE_CACHE_TTL_MS = 30 * 60_000;
// Likes/uploads change rarely; cache the resolved library so relaunching doesn't re-fetch it all.
const PROFILE_CACHE_TTL_MS = 30 * 60_000;

export class SoundCloudInternalGateway {
  private client: StealthClient;
  private cache: CacheStore;
  private assetBundle: SoundCloudAssetBundle | undefined;
  private bundlePromise: Promise<SoundCloudAssetBundle> | undefined;
  private publicRateLimitedUntil = 0;
  private authenticatedUserIds = new Map<string, number>();
  /** The signed-in user's SoundCloud oauth_token, captured when their profile/likes load.
   *  Sent as `Authorization: OAuth …` on stream resolution so monetized / ad-supported tracks
   *  (which 404 for anonymous client_id requests) play for the logged-in user. */
  private soundCloudOAuthToken: string | undefined;

  constructor(cache: CacheStore) {
    // Cookie-less: SoundCloud's anonymous api-v2 + media endpoints need no cookies, and a shared
    // jar accumulating session cookies was poisoning the media endpoint (404s on stream resolve).
    this.client = new StealthClient(undefined, { disableCookies: true });
    this.client.setDefaultHeader("Origin", "https://soundcloud.com");
    this.client.setDefaultHeader("Referer", "https://soundcloud.com/");
    this.cache = cache;
  }

  async initialize(): Promise<void> {
    await this.ensureAssetBundle();
  }

  clearSession(): void {
    this.soundCloudOAuthToken = undefined;
    this.authenticatedUserIds.clear();
    this.cache.invalidate(/^soundcloud:/);
  }

  /** The current scraped public client_id — needed for in-page api-v2 calls (e.g. the like window). */
  async resolveClientId(): Promise<string> {
    return (await this.ensureAssetBundle()).clientId;
  }

  async search(query: string): Promise<GatewayResponse<UnifiedTrack[]>> {
    // One canonical query string for BOTH the cache key and the request, so "song " and "song"
    // hit the same cache entry instead of firing separate API variants.
    const normalizedQuery = query.trim();
    const cacheKey = `soundcloud:search:${normalizedQuery.toLowerCase()}`;
    const cached = this.cache.get<UnifiedTrack[]>(cacheKey);
    if (cached) {
      return { ok: true, data: cached, source: "cache" };
    }

    if (this.publicRateLimitedUntil > Date.now()) {
      return {
        ok: false,
        error: "SoundCloud is cooling down after a rate limit.",
        source: "internal"
      };
    }

    try {
      const bundle = await this.ensureAssetBundle();
      const url = new URL(`${SOUNDCLOUD_PUBLIC_API_BASE}/search/tracks`);
      url.searchParams.set("q", normalizedQuery);
      url.searchParams.set("limit", "18");
      url.searchParams.set("linked_partitioning", "1");
      url.searchParams.set("client_id", bundle.clientId);
      url.searchParams.set("app_version", bundle.appVersion);
      url.searchParams.set("app_locale", bundle.appLocale);

      const response = await this.client.request(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01"
        }
      });

      if (!this.isSuccessStatus(response.status)) {
        if (response.status === 429) {
          this.publicRateLimitedUntil = Date.now() + 60_000;
        }
        return {
          ok: false,
          error: `SoundCloud search returned ${response.status}`,
          source: "internal"
        };
      }

      const json = JSON.parse(response.body) as SoundCloudInternalSearchResponse;
      const tracks =
        (json.collection ?? [])
          .map(mapInternalTrack)
          .filter((track) => track.playable) ?? [];

      this.cache.set(cacheKey, tracks, SEARCH_CACHE_TTL_MS);
      this.publicRateLimitedUntil = 0;
      return { ok: true, data: tracks, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "SoundCloud search failed.",
        source: "internal"
      };
    }
  }

  /**
   * Discover tracks related to a given SoundCloud track via api-v2's `/tracks/{id}/related`
   * endpoint (the same one the web player uses for "next up"/autoplay). This is real cross-track
   * discovery — the backbone of song-seeded Stations and the SoundCloud side of Daily Mixes.
   */
  async relatedTracks(track: UnifiedTrack, limit = 20): Promise<GatewayResponse<UnifiedTrack[]>> {
    // The related endpoint needs the BARE numeric id, but a unified track carries the SoundCloud URN
    // (e.g. "soundcloud:tracks:1685274354") as its providerTrackId. Extract the numeric id or the
    // request 404s and discovery silently returns nothing.
    const numericId = extractSoundCloudNumericTrackId(track);
    if (!numericId) {
      return { ok: false, error: "No SoundCloud numeric id for related lookup.", source: "fallback" };
    }
    const cacheKey = `soundcloud:related:${numericId}:${limit}`;
    const cached = this.cache.get<UnifiedTrack[]>(cacheKey);
    if (cached) {
      return { ok: true, data: cached, source: "cache" };
    }

    if (this.publicRateLimitedUntil > Date.now()) {
      return { ok: false, error: "SoundCloud is cooling down after a rate limit.", source: "internal" };
    }

    try {
      const bundle = await this.ensureAssetBundle();
      const url = new URL(`${SOUNDCLOUD_PUBLIC_API_BASE}/tracks/${numericId}/related`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("linked_partitioning", "1");
      url.searchParams.set("client_id", bundle.clientId);
      url.searchParams.set("app_version", bundle.appVersion);
      url.searchParams.set("app_locale", bundle.appLocale);

      const response = await this.client.request(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json, text/javascript, */*; q=0.01" }
      });

      if (!this.isSuccessStatus(response.status)) {
        if (response.status === 429) {
          this.publicRateLimitedUntil = Date.now() + 60_000;
        }
        return { ok: false, error: `SoundCloud related returned ${response.status}`, source: "internal" };
      }

      const json = JSON.parse(response.body) as SoundCloudInternalSearchResponse;
      const tracks = (json.collection ?? []).map(mapInternalTrack).filter((track) => track.playable);

      this.cache.set(cacheKey, tracks, SEARCH_CACHE_TTL_MS);
      this.publicRateLimitedUntil = 0;
      return { ok: true, data: tracks, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "SoundCloud related lookup failed.",
        source: "internal"
      };
    }
  }

  async resolveStream(track: UnifiedTrack): Promise<GatewayResponse<SoundCloudStreamResult>> {
    const cacheKey = `soundcloud:stream:v2:${track.providerTrackId}`;
    // Skip the stream cache during a DataDome validation run so every play re-resolves and mints a
    // fresh license_token with the test headers (otherwise a stale, pre-DataDome token is reused).
    const cached = process.env.SC_TEST_DATADOME_CLIENTID
      ? undefined
      : this.cache.get<SoundCloudStreamResult>(cacheKey);
    if (cached) {
      logResolve("resolveStream CACHE HIT", { title: track.title, id: track.providerTrackId, url: cached.url.slice(0, 120), hasDrm: !!cached.drm });
      return { ok: true, data: cached, source: "cache" };
    }

    try {
      // Authenticate as the signed-in user when we have their token: monetized tracks
      // (policy=MONETIZE) 404 on the plain stream endpoint for anonymous client_id requests.
      const authHeaders: Record<string, string> = this.soundCloudOAuthToken
        ? { Authorization: `OAuth ${this.soundCloudOAuthToken}` }
        : {};

      // TEST (DataDome validation, env-gated — no secret in the repo): the working browser sends an
      // `x-datadome-clientid` header on the /media resolve,
      // which mints a DataDome-validated license_token the license server will then accept. When
      // SC_TEST_DATADOME_CLIENTID is set, send it here exactly like the web player. SC_TEST_OAUTH_TOKEN
      // optionally overrides the OAuth token to match a specific captured session.
      const testDatadomeClientId = process.env.SC_TEST_DATADOME_CLIENTID;
      if (testDatadomeClientId) {
        authHeaders["x-datadome-clientid"] = testDatadomeClientId;
      }
      const testOAuthToken = process.env.SC_TEST_OAUTH_TOKEN;
      if (testOAuthToken) {
        authHeaders["Authorization"] = `OAuth ${testOAuthToken}`;
      }
      // The datadome client-id header is only half the DataDome pair — the web player also sends the
      // matching `datadome` cookie (same-site, .soundcloud.com) on the resolve. StealthClient runs
      // disableCookies, so inject it explicitly here when SC_TEST_DATADOME_COOKIE is set so the
      // minted license_token is validated against the full DataDome context.
      const testDatadomeCookie = process.env.SC_TEST_DATADOME_COOKIE;
      if (testDatadomeCookie) {
        authHeaders["Cookie"] = `datadome=${testDatadomeCookie}`;
      }

      const trackResponse = await this.resolveTrackData(track, authHeaders);
      if (!trackResponse.ok || !trackResponse.data) {
        return { ok: false, error: trackResponse.error ?? "Could not resolve track.", source: "internal" };
      }

      const trackData = trackResponse.data;
      if (trackData.access === "blocked") {
        return { ok: false, error: "Track is blocked.", source: "internal" };
      }

      const transcodings = trackData.media?.transcodings ?? [];
      logResolve("resolveStream trackData", {
        title: track.title,
        id: track.providerTrackId,
        access: trackData.access,
        hasTrackAuth: !!trackData.track_authorization,
        transcodings: transcodings.map((t) => ({
          protocol: t.format?.protocol,
          preset: t.preset
        })),
        hasAuth: !!this.soundCloudOAuthToken
      });

      const bundle = await this.ensureAssetBundle();
      const buildStreamUrl = (rawUrl: string): string => {
        const streamUrl = new URL(rawUrl);
        streamUrl.searchParams.set("client_id", bundle.clientId);
        streamUrl.searchParams.set("app_version", bundle.appVersion);
        streamUrl.searchParams.set("app_locale", bundle.appLocale);
        if (trackData.track_authorization) {
          streamUrl.searchParams.set("track_authorization", trackData.track_authorization);
        }
        return streamUrl.toString();
      };

      // 0) Direct stream_url fallback — some tracks expose a plain MP3 via this field
      //    even when the transcodings array only lists DRM formats.
      if (trackData.stream_url) {
        try {
          const streamUrl = new URL(trackData.stream_url);
          streamUrl.searchParams.set("client_id", bundle.clientId);
          const response = await this.client.request(streamUrl.toString(), {
            method: "GET",
            headers: authHeaders,
            redirect: "manual"
          });
          logResolve("resolveStream try stream_url", {
            title: track.title,
            status: response.status,
            hasLocation: !!response.headers["location"]
          });
          if (response.status >= 300 && response.status < 400 && response.headers["location"]) {
            const result: SoundCloudStreamResult = { url: response.headers["location"] };
            this.cache.setMemoryOnly(cacheKey, result, STREAM_CACHE_TTL_MS);
            logResolve("resolveStream SUCCESS stream_url", { title: track.title, url: result.url.slice(0, 120) });
            return { ok: true, data: result, source: "internal" };
          }
        } catch {
          // ignore and fall through to transcoding candidates
        }
      }

      // 1) Plain (non-DRM) transcodings first — these play via <audio>/hls.js directly. Some
      //    individual transcodings intermittently 404, so try each and use the first that resolves.
      const candidates = this.orderedPlayableTranscodings(transcodings);
      let lastStatus = 0;
      for (const transcoding of candidates) {
        const response = await this.client.request(buildStreamUrl(transcoding.url!), {
          method: "GET",
          headers: authHeaders
        });
        const json = parseJsonBody<SoundCloudInternalStreamResponse>(response.body);
        logResolve("resolveStream try plain", {
          title: track.title,
          protocol: transcoding.format?.protocol,
          preset: transcoding.preset,
          status: response.status,
          hasUrl: !!json?.url
        });
        if (!this.isSuccessStatus(response.status)) {
          lastStatus = response.status;
          continue;
        }
        if (!json?.url) {
          continue;
        }
        const result: SoundCloudStreamResult = { url: json.url };
        this.cache.setMemoryOnly(cacheKey, result, STREAM_CACHE_TTL_MS);
        logResolve("resolveStream SUCCESS plain", { title: track.title, url: json.url.slice(0, 120) });
        return { ok: true, data: result, source: "internal" };
      }

      // 2) Monetized tracks only stream as Widevine CENC (ctr-encrypted-hls). Resolve that with the
      //    user's auth and hand the renderer the license info so it can play via hls.js EME.
      const widevine = transcodings.find(
        (transcoding) => transcoding.url && (transcoding.format?.protocol ?? "").includes("ctr-encrypted-hls")
      );
      if (this.soundCloudOAuthToken && widevine?.url) {
        const mediaUrl = buildStreamUrl(widevine.url);
        // Mint the license_token from INSIDE a real soundcloud.com page (DataDome-validated session).
        // Only an in-page-minted token is accepted by the license server — raw StealthClient tokens
        // 403. Fall back to the raw client if the
        // hidden window is unavailable so non-DRM behaviour is unaffected.
        let response: { status: number; body: string };
        try {
          response = await resolveMediaInPage({ url: mediaUrl, oauthToken: this.soundCloudOAuthToken });
        } catch (error) {
          logResolve("resolveStream drm hidden-window failed; falling back to client", {
            title: track.title,
            error: (error as Error)?.message
          });
          response = await this.client.request(mediaUrl, { method: "GET", headers: authHeaders });
        }
        const json = parseJsonBody<SoundCloudInternalStreamResponse>(response.body);
        // One-shot diagnostic (fire-and-forget): let SoundCloud's own player attempt this track in a
        // hidden window, so we can observe whether the genuine license POST 200s or 403s in our
        // (Electron + castLabs CDM) environment — the decisive castLabs-vs-context signal.
        void probeNativePlaybackOnce((track as { externalUrl?: string }).externalUrl, this.soundCloudOAuthToken);
        logResolve("resolveStream try drm", {
          title: track.title,
          status: response.status,
          hasUrl: !!json?.url,
          hasLicenseToken: !!json?.licenseAuthToken
        });
        if (this.isSuccessStatus(response.status)) {
          if (json?.url) {
            const result: SoundCloudStreamResult = {
              url: json.url,
              drm: {
                system: "widevine",
                licenseUrl: SOUNDCLOUD_WIDEVINE_LICENSE_URL,
                licenseAuthToken: json.licenseAuthToken,
                oauthToken: this.soundCloudOAuthToken,
                trackAuthorization: trackData.track_authorization
              }
            };
            this.cache.setMemoryOnly(cacheKey, result, STREAM_CACHE_TTL_MS);
            logResolve("resolveStream SUCCESS drm", { title: track.title, url: json.url.slice(0, 120) });
            return { ok: true, data: result, source: "internal" };
          }
        } else {
          lastStatus = response.status;
        }
      }

      const error =
        candidates.length === 0 && !widevine
          ? "No playable transcoding found."
          : `Stream resolution returned ${lastStatus || "no playable URL"}`;
      logResolve("resolveStream FAILED", {
        title: track.title,
        id: track.providerTrackId,
        error,
        candidateCount: candidates.length,
        hasDrm: !!widevine,
        hasAuth: !!this.soundCloudOAuthToken,
        lastStatus,
        transcodings: transcodings.map((t) => ({
          protocol: t.format?.protocol,
          preset: t.preset
        })),
        access: trackData.access,
        hasTrackAuth: !!trackData.track_authorization
      });
      return {
        ok: false,
        error,
        source: "internal"
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Stream resolution failed.",
        source: "internal"
      };
    }
  }

  async getCollections(accessToken: string): Promise<GatewayResponse<ProviderCollection[]>> {
    const cacheKey = "soundcloud:collections";
    const cached = this.cache.get<ProviderCollection[]>(cacheKey);
    if (cached) {
      return { ok: true, data: cached, source: "cache" };
    }

    try {
      const playlists = await this.fetchPaginated<SoundCloudInternalPlaylist>(
        "/me/playlists?show_tracks=false&linked_partitioning=true&limit=50",
        accessToken
      );

      const collections: ProviderCollection[] = [
        {
          id: "likes",
          provider: "soundcloud",
          kind: "likes",
          title: "Likes",
          trackCount: 0
        },
        ...playlists.map((playlist) => mapInternalPlaylistCollection(playlist))
      ];

      this.cache.set(cacheKey, collections, COLLECTION_CACHE_TTL_MS);
      return { ok: true, data: collections, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch SoundCloud collections.",
        source: "internal"
      };
    }
  }

  async getCollectionTracks(
    collectionId: string,
    accessToken: string
  ): Promise<GatewayResponse<TrackCollection>> {
    const cacheKey = `soundcloud:collection:${collectionId}`;
    const cached = this.cache.get<TrackCollection>(cacheKey);
    if (cached) {
      return { ok: true, data: cached, source: "cache" };
    }

    if (collectionId === "likes") {
      return this.fetchLikes(accessToken, cacheKey);
    }

    return this.fetchPlaylistTracks(collectionId, accessToken, cacheKey);
  }

  async resolveTrackData(
    track: UnifiedTrack,
    authHeaders: Record<string, string> = {}
  ): Promise<GatewayResponse<SoundCloudInternalTrack>> {
    // Auth-aware cache: major-label tracks return different data (track_authorization,
    // access=playable) when requested with an OAuth token vs anonymously.
    const cacheKey = authHeaders.Authorization
      ? `soundcloud:track:auth:${track.providerTrackId}`
      : `soundcloud:track:${track.providerTrackId}`;
    const cached = this.cache.get<SoundCloudInternalTrack>(cacheKey);
    if (cached) {
      return { ok: true, data: cached, source: "cache" };
    }

    try {
      const bundle = await this.ensureAssetBundle();
      let url: string;

      if (track.externalUrl) {
        const resolveUrl = new URL(`${SOUNDCLOUD_PUBLIC_API_BASE}/resolve`);
        resolveUrl.searchParams.set("url", track.externalUrl);
        resolveUrl.searchParams.set("client_id", bundle.clientId);
        resolveUrl.searchParams.set("app_version", bundle.appVersion);
        resolveUrl.searchParams.set("app_locale", bundle.appLocale);
        url = resolveUrl.toString();
      } else {
        const trackUrl = new URL(`${SOUNDCLOUD_PUBLIC_API_BASE}/tracks/${encodeURIComponent(track.providerTrackId)}`);
        trackUrl.searchParams.set("client_id", bundle.clientId);
        trackUrl.searchParams.set("app_version", bundle.appVersion);
        trackUrl.searchParams.set("app_locale", bundle.appLocale);
        url = trackUrl.toString();
      }

      const response = await this.client.request(url, { method: "GET", headers: authHeaders });
      if (!this.isSuccessStatus(response.status)) {
        return {
          ok: false,
          error: `Track resolve returned ${response.status}`,
          source: "internal"
        };
      }

      const json = JSON.parse(response.body) as SoundCloudInternalTrack;
      this.cache.set(cacheKey, json, TRACK_CACHE_TTL_MS);
      return { ok: true, data: json, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Track resolution failed.",
        source: "internal"
      };
    }
  }

  /**
   * Resolves a PUBLIC SoundCloud profile URL into its public likes and uploads — anonymously,
   * using the scraped public client_id (no sign-in). Only returns what the profile owner made
   * public; private likes require the browser sign-in path instead.
   */
  async resolveProfile(profileUrl: string): Promise<GatewayResponse<SoundCloudProfileResultDTO>> {
    try {
      const bundle = await this.ensureAssetBundle();
      const normalized = normalizeProfileUrl(profileUrl);
      if (!normalized) {
        return { ok: false, error: "Enter your SoundCloud profile URL.", source: "internal" };
      }

      const cacheKey = `soundcloud:profile:${normalized.toLowerCase()}`;
      const cached = this.cache.get<SoundCloudProfileResultDTO>(cacheKey);
      if (cached) {
        return { ok: true, data: cached, source: "cache" };
      }

      const resolveUrl = new URL(`${SOUNDCLOUD_PUBLIC_API_BASE}/resolve`);
      resolveUrl.searchParams.set("url", normalized);
      resolveUrl.searchParams.set("client_id", bundle.clientId);
      resolveUrl.searchParams.set("app_version", bundle.appVersion);
      resolveUrl.searchParams.set("app_locale", bundle.appLocale);

      const resolveResponse = await this.client.request(resolveUrl.toString(), { method: "GET" });
      if (resolveResponse.status === 404) {
        return { ok: false, error: "No SoundCloud profile found at that URL.", source: "internal" };
      }
      if (!this.isSuccessStatus(resolveResponse.status)) {
        return { ok: false, error: `Profile resolve returned ${resolveResponse.status}`, source: "internal" };
      }

      const user = JSON.parse(resolveResponse.body) as SoundCloudInternalUser;
      if (user.kind !== "user" || user.id === undefined) {
        return {
          ok: false,
          error: "That link isn't a SoundCloud profile. Use your profile URL, e.g. soundcloud.com/yourname.",
          source: "internal"
        };
      }

      const userId = user.id;
      const displayName = user.full_name?.trim() || user.username?.trim() || "SoundCloud";

      const likeItems = await this.fetchPublicPaginated<SoundCloudTrackLikeItem>(
        `/users/${userId}/track_likes?limit=50&linked_partitioning=1`,
        bundle,
        300
      );
      // Show ALL liked tracks so the count matches SoundCloud (blocked/geo-restricted ones
      // included) — the queue safely auto-skips anything that can't actually play. Only drop
      // likes whose track payload is null (deleted tracks the API returns without data).
      const likes = dedupeTracksById(
        likeItems
          .map((item) => item.track)
          .filter((track): track is SoundCloudInternalTrack => Boolean(track))
          .map(mapInternalTrack)
      );

      const uploadItems = await this.fetchPublicPaginated<SoundCloudInternalTrack>(
        `/users/${userId}/tracks?limit=50&linked_partitioning=1`,
        bundle,
        100
      );
      const uploads = dedupeTracksById(uploadItems.map(mapInternalTrack).filter((track) => track.playable));

      const data: SoundCloudProfileResultDTO = { displayName, likes, uploads, playlists: [] };
      this.cache.set(cacheKey, data, PROFILE_CACHE_TTL_MS);
      return { ok: true, data, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not load that SoundCloud profile.",
        source: "internal"
      };
    }
  }

  private async fetchPublicPaginated<T>(
    path: string,
    bundle: SoundCloudAssetBundle,
    cap: number,
    authHeaders?: Record<string, string>
  ): Promise<T[]> {
    const items: T[] = [];
    let nextUrl: string | undefined = `${SOUNDCLOUD_PUBLIC_API_BASE}${path}`;
    const visited = new Set<string>();

    while (nextUrl && items.length < cap) {
      if (visited.has(nextUrl) || visited.size >= 100) {
        throw new Error("SoundCloud pagination returned a cycle or too many pages.");
      }
      visited.add(nextUrl);
      const url = new URL(nextUrl);
      if (url.protocol !== "https:" || url.hostname !== "api-v2.soundcloud.com") {
        throw new Error("SoundCloud pagination returned an untrusted URL.");
      }
      url.searchParams.set("client_id", bundle.clientId);
      url.searchParams.set("app_version", bundle.appVersion);
      url.searchParams.set("app_locale", bundle.appLocale);

      const response = await this.client.request(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json", ...(authHeaders ?? {}) }
      });
      if (!this.isSuccessStatus(response.status)) {
        throw new Error(`SoundCloud pagination returned ${response.status}.`);
      }

      const json = JSON.parse(response.body) as SoundCloudInternalPaginatedResponse<T>;
      items.push(...(json.collection ?? []));
      nextUrl = json.next_href;
    }

    return items.slice(0, cap);
  }

  /**
   * Resolves the SIGNED-IN user's library using an `oauth_token` captured from their own
   * SoundCloud web session. Unlike resolveProfile this includes likes the user has made private,
   * because the request is authenticated as the owner.
   */
  async resolveAuthenticatedProfile(oauthToken: string): Promise<GatewayResponse<SoundCloudProfileResultDTO>> {
    try {
      // Remember the signed-in token so stream resolution can authenticate monetized tracks.
      if (this.soundCloudOAuthToken !== oauthToken) {
        this.clearSession();
      }
      this.soundCloudOAuthToken = oauthToken;
      const bundle = await this.ensureAssetBundle();
      const authHeaders = { Authorization: `OAuth ${oauthToken}` };

      const accountCacheKey = createHash("sha256").update(oauthToken).digest("hex").slice(0, 16);
      const cacheKey = `soundcloud:me-library:v4:${accountCacheKey}`;
      const cached = this.cache.get<SoundCloudProfileResultDTO>(cacheKey);
      if (cached) {
        return { ok: true, data: cached, source: "cache" };
      }

      const meUrl = new URL(`${SOUNDCLOUD_PUBLIC_API_BASE}/me`);
      meUrl.searchParams.set("client_id", bundle.clientId);
      meUrl.searchParams.set("app_version", bundle.appVersion);
      meUrl.searchParams.set("app_locale", bundle.appLocale);

      const meResponse = await this.client.request(meUrl.toString(), {
        method: "GET",
        headers: { Accept: "application/json", ...authHeaders }
      });
      if (meResponse.status === 401 || meResponse.status === 403) {
        return {
          ok: false,
          error: "Your SoundCloud sign-in expired. Sign in again to refresh your likes.",
          source: "internal"
        };
      }
      if (!this.isSuccessStatus(meResponse.status)) {
        return { ok: false, error: `SoundCloud /me returned ${meResponse.status}`, source: "internal" };
      }

      const me = JSON.parse(meResponse.body) as SoundCloudInternalUser;
      if (me.id === undefined) {
        return { ok: false, error: "Could not read your SoundCloud account.", source: "internal" };
      }

      const displayName = me.full_name?.trim() || me.username?.trim() || "SoundCloud";
      const subscriptionTier = parseSoundCloudSubscriptionTier(me as Record<string, unknown>);

      const likeItems = await this.fetchPublicPaginated<SoundCloudTrackLikeItem>(
        `/users/${me.id}/track_likes?limit=50&linked_partitioning=1`,
        bundle,
        500,
        authHeaders
      );
      // Show ALL liked tracks so the count matches SoundCloud (blocked/geo-restricted ones
      // included) — the queue safely auto-skips anything that can't actually play. Only drop
      // likes whose track payload is null (deleted tracks the API returns without data).
      const likes = dedupeTracksById(
        likeItems
          .map((item) => item.track)
          .filter((track): track is SoundCloudInternalTrack => Boolean(track))
          .map(mapInternalTrack)
      );

      const uploadItems = await this.fetchPublicPaginated<SoundCloudInternalTrack>(
        `/users/${me.id}/tracks?limit=50&linked_partitioning=1`,
        bundle,
        100,
        authHeaders
      );
      const uploads = dedupeTracksById(uploadItems.map(mapInternalTrack).filter((track) => track.playable));

      const playlistItems = await this.fetchPublicPaginated<SoundCloudInternalPlaylist>(
        `/users/${me.id}/playlists?show_tracks=false&limit=50&linked_partitioning=1`,
        bundle,
        200,
        authHeaders
      );
      // Also surface playlists/albums the user has LIKED. These count toward their SoundCloud
      // "likes" total but aren't tracks, so the liked-songs count (e.g. 199) is lower than the
      // site's total (e.g. 224) — the difference is liked playlists like these plus a few
      // deleted/private likes the API won't return at all.
      const likedPlaylistItems = await this.fetchPublicPaginated<{ playlist?: SoundCloudInternalPlaylist }>(
        `/users/${me.id}/playlist_likes?limit=50&linked_partitioning=1`,
        bundle,
        200,
        authHeaders
      );
      const likedPlaylists = likedPlaylistItems
        .map((item) => item.playlist)
        .filter((playlist): playlist is SoundCloudInternalPlaylist => Boolean(playlist))
        .map(mapInternalPlaylistCollection);
      const seenPlaylistIds = new Set<string>();
      const playlists = [...playlistItems.map(mapInternalPlaylistCollection), ...likedPlaylists].filter(
        (collection) => {
          if (seenPlaylistIds.has(collection.id)) {
            return false;
          }
          seenPlaylistIds.add(collection.id);
          return true;
        }
      );

      const data: SoundCloudProfileResultDTO = { displayName, likes, uploads, playlists, subscriptionTier };
      this.cache.setMemoryOnly(cacheKey, data, PROFILE_CACHE_TTL_MS);
      return { ok: true, data, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not load your SoundCloud library.",
        source: "internal"
      };
    }
  }

  async setTrackLiked(
    track: UnifiedTrack,
    authorizationHeader: string,
    liked: boolean,
    sessionCookie?: string
  ): Promise<GatewayResponse<{ liked: boolean }>> {
    const trackId = extractSoundCloudNumericTrackId(track);
    if (!trackId) {
      return {
        ok: false,
        error: "Could not resolve that SoundCloud track id for likes.",
        source: "internal"
      };
    }

    try {
      const userId = await this.resolveAuthenticatedUserId(authorizationHeader);
      if (!userId) {
        return {
          ok: false,
          error: "Your SoundCloud sign-in expired. Sign in again to update likes.",
          source: "internal"
        };
      }

      const bundle = await this.ensureAssetBundle();
      const likeUrl = new URL(`${SOUNDCLOUD_PUBLIC_API_BASE}/users/${userId}/track_likes/${trackId}`);
      likeUrl.searchParams.set("client_id", bundle.clientId);
      likeUrl.searchParams.set("app_version", bundle.appVersion);
      likeUrl.searchParams.set("app_locale", bundle.appLocale);

      const response = await this.client.request(likeUrl.toString(), {
        method: liked ? "PUT" : "DELETE",
        headers: {
          Accept: "application/json; charset=utf-8",
          Authorization: authorizationHeader,
          // DataDome 403s the write unless it carries the browser's anti-bot cookie (reads via the
          // public client_id are unprotected, writes are not). The captured session cookie is sent
          // here when available; without it SoundCloud rejects the like as a bot request.
          ...(sessionCookie ? { Cookie: sessionCookie } : {})
        }
      });

      if (!this.isSuccessStatus(response.status)) {
        return {
          ok: false,
          error:
            response.status === 403
              ? "SoundCloud blocked the like (anti-bot). Reconnect SoundCloud Local Connect to refresh the session."
              : getSoundCloudApiError(response.body, `SoundCloud like update returned ${response.status}.`),
          source: "internal"
        };
      }

      this.cache.invalidate(/^soundcloud:(me-library|collection:likes|collections|profile:)/);
      return { ok: true, data: { liked }, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "SoundCloud like update failed.",
        source: "internal"
      };
    }
  }

  private async resolveAuthenticatedUserId(authorizationHeader: string): Promise<number | undefined> {
    const cached = this.authenticatedUserIds.get(authorizationHeader);
    if (cached) {
      return cached;
    }
    try {
      const bundle = await this.ensureAssetBundle();
      const meUrl = new URL(`${SOUNDCLOUD_PUBLIC_API_BASE}/me`);
      meUrl.searchParams.set("client_id", bundle.clientId);
      meUrl.searchParams.set("app_version", bundle.appVersion);
      meUrl.searchParams.set("app_locale", bundle.appLocale);
      const response = await this.client.request(meUrl.toString(), {
        method: "GET",
        headers: { Accept: "application/json", Authorization: authorizationHeader }
      });
      if (!this.isSuccessStatus(response.status)) {
        return undefined;
      }
      const me = JSON.parse(response.body) as SoundCloudInternalUser;
      const id = Number(me.id);
      if (Number.isFinite(id)) {
        // Keyed by the full Authorization header, so token rotation would grow this forever —
        // it's a one-user cache, keep only the most recent entry.
        if (this.authenticatedUserIds.size >= 4) {
          this.authenticatedUserIds.clear();
        }
        this.authenticatedUserIds.set(authorizationHeader, id);
        return id;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchLikes(accessToken: string, cacheKey: string): Promise<GatewayResponse<TrackCollection>> {
    try {
      const likes = await this.fetchPaginated<SoundCloudInternalTrack>(
        "/me/likes/tracks?limit=50&linked_partitioning=true",
        accessToken
      );

      const collection: TrackCollection = {
        id: "likes",
        provider: "soundcloud",
        kind: "likes",
        title: "Liked on SoundCloud",
        items: dedupeTracksById(likes.map(mapInternalTrack))
      };

      this.cache.set(cacheKey, collection, COLLECTION_CACHE_TTL_MS);
      return { ok: true, data: collection, source: "internal" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch likes.",
        source: "internal"
      };
    }
  }

  private async fetchPlaylistTracks(
    collectionId: string,
    accessToken: string,
    cacheKey: string
  ): Promise<GatewayResponse<TrackCollection>> {
    try {
      let playlist: SoundCloudInternalPlaylist;

      if (collectionId.startsWith("resolve:")) {
        const permalinkUrl = decodeURIComponent(collectionId.slice("resolve:".length));
        const bundle = await this.ensureAssetBundle();
        const resolveUrl = new URL(`${SOUNDCLOUD_PUBLIC_API_BASE}/resolve`);
        resolveUrl.searchParams.set("url", permalinkUrl);
        resolveUrl.searchParams.set("client_id", bundle.clientId);
        resolveUrl.searchParams.set("app_version", bundle.appVersion);
        resolveUrl.searchParams.set("app_locale", bundle.appLocale);

        const response = await this.client.request(resolveUrl.toString(), { method: "GET" });
        if (!this.isSuccessStatus(response.status)) {
          return { ok: false, error: `Playlist resolve returned ${response.status}`, source: "internal" };
        }
        playlist = JSON.parse(response.body) as SoundCloudInternalPlaylist;
      } else {
        const response = await this.authenticatedRequest<SoundCloudInternalPlaylist>(
          `/playlists/${encodeURIComponent(collectionId)}`,
          accessToken
        );
        playlist = response;
      }

      const collection: TrackCollection = {
        id: collectionId,
        provider: "soundcloud",
        kind: "playlist",
        title: playlist.title?.trim() || "SoundCloud playlist",
        artworkUrl: playlist.artwork_url ?? undefined,
        externalUrl: playlist.permalink_url,
        description: playlist.description?.trim() || undefined,
        ownerName: playlist.user?.full_name ?? playlist.user?.username,
        items: (playlist.tracks ?? []).map(mapInternalTrack).filter((track) => track.playable)
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

  private async fetchPaginated<T>(path: string, accessToken: string): Promise<T[]> {
    const items: T[] = [];
    let nextUrl: string | undefined = path;
    const visited = new Set<string>();

    while (nextUrl) {
      if (visited.has(nextUrl) || visited.size >= 200) {
        throw new Error("SoundCloud pagination returned a cycle or too many pages.");
      }
      visited.add(nextUrl);
      const response: SoundCloudInternalPaginatedResponse<T> = await this.authenticatedRequest(nextUrl, accessToken);
      items.push(...(response.collection ?? []));
      nextUrl = response.next_href;
    }

    return items;
  }

  private async authenticatedRequest<T>(pathOrUrl: string, accessToken: string): Promise<T> {
    const url = new URL(
      pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.soundcloud.com${pathOrUrl}`
    );
    if (url.protocol !== "https:" || url.hostname !== "api.soundcloud.com") {
      throw new Error("SoundCloud returned an untrusted API URL.");
    }

    const response = await this.client.request(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    if (!this.isSuccessStatus(response.status)) {
      throw new Error(`SoundCloud authenticated request failed: ${response.status}`);
    }

    return JSON.parse(response.body) as T;
  }

  private async ensureAssetBundle(): Promise<SoundCloudAssetBundle> {
    if (this.assetBundle && Date.now() - this.assetBundle.fetchedAt < BUNDLE_CACHE_TTL_MS) {
      return this.assetBundle;
    }

    if (this.bundlePromise) {
      return this.bundlePromise;
    }

    this.bundlePromise = this.discoverAssetBundle();
    try {
      const bundle = await this.bundlePromise;
      // Never cache the empty-clientId fallback as "fresh" — doing so made every SoundCloud call
      // fail for the whole 30-min TTL after one bad startup scrape. Marking it already-expired
      // keeps this call's result usable as a last resort while forcing the next call to re-scrape.
      this.assetBundle = bundle.clientId ? bundle : { ...bundle, fetchedAt: 0 };
      return bundle;
    } finally {
      this.bundlePromise = undefined;
    }
  }

  private async discoverAssetBundle(): Promise<SoundCloudAssetBundle> {
    // Try cached bundle first
    const cached = this.cache.get<SoundCloudAssetBundle>("soundcloud:asset-bundle");
    if (cached && Date.now() - cached.fetchedAt < BUNDLE_CACHE_TTL_MS) {
      return cached;
    }

    // Try web scraping
    try {
      const webBundle = await this.scrapeAssetBundle(SOUNDCLOUD_WEB_URL, false);
      if (webBundle) {
        this.cache.set("soundcloud:asset-bundle", webBundle, BUNDLE_CACHE_TTL_MS);
        return webBundle;
      }
    } catch {
      // Web scrape failed, try mobile
    }

    try {
      const mobileBundle = await this.scrapeAssetBundle(SOUNDCLOUD_MOBILE_URL, true);
      if (mobileBundle) {
        this.cache.set("soundcloud:asset-bundle", mobileBundle, BUNDLE_CACHE_TTL_MS);
        return mobileBundle;
      }
    } catch {
      // Mobile scrape failed
    }

    // Ultimate fallback
    return {
      clientId: "",
      appVersion: "1770022942",
      appLocale: "en",
      fetchedAt: Date.now()
    };
  }

  private async scrapeAssetBundle(url: string, isMobile: boolean): Promise<SoundCloudAssetBundle | undefined> {
    const response = await this.client.request(url, {
      method: "GET",
      headers: isMobile
        ? {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/99.0.4844.47 Mobile/15E148 Safari/604.1"
          }
        : {}
    });

    if (!this.isSuccessStatus(response.status)) {
      return undefined;
    }

    const html = response.body;

    // Try to extract from inline scripts first (faster, more reliable)
    const inlineClientId = this.extractClientId(html);
    const inlineAppVersion = this.extractAppVersion(html);

    if (inlineClientId) {
      return {
        clientId: inlineClientId,
        appVersion: inlineAppVersion ?? "1770022942",
        appLocale: "en",
        signingKey: this.extractSigningKey(html),
        fetchedAt: Date.now()
      };
    }

    // Extract JS bundle URLs and search them
    const jsUrls = this.extractJsUrls(html, url);
    for (const jsUrl of jsUrls.slice(0, 10)) {
      try {
        const jsResponse = await this.client.request(jsUrl, {
          method: "GET",
          timeoutMs: 10000
        });

        if (this.isSuccessStatus(jsResponse.status)) {
          const clientId = this.extractClientId(jsResponse.body);
          if (clientId) {
            return {
              clientId,
              appVersion: this.extractAppVersion(jsResponse.body) ?? "1770022942",
              appLocale: "en",
              signingKey: this.extractSigningKey(jsResponse.body),
              fetchedAt: Date.now()
            };
          }
        }
      } catch {
        // Bundle fetch failed, continue to next
      }
    }

    return undefined;
  }

  private extractJsUrls(html: string, baseUrl: string): string[] {
    const urls: string[] = [];
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

  private extractClientId(source: string): string | undefined {
    const patterns = [
      /[{,]client_id:\"(\w+)\"/,
      /[{,]client_id:"(\w+)"/,
      /"clientId":"(\w+?)"/,
      /"client_id":"(\w+)"/,
      /client_id=(\w+)/
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1] && match[1].length > 10) {
        return match[1];
      }
    }
    return undefined;
  }

  private extractAppVersion(source: string): string | undefined {
    const patterns = [
      /"app_version":"(\d+)"/,
      /app_version=(\d+)/,
      /"appVersion":"(\d+)"/
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return undefined;
  }

  private extractSigningKey(source: string): string | undefined {
    // SoundCloud occasionally uses signed requests with a key embedded in bundles
    const patterns = [
      /"signature_key":"([^"]+)"/,
      /signature_key=([^&\s"]+)/,
      /"signingKey":"([^"]+)"/
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return undefined;
  }

  /**
   * Returns directly-playable transcodings (plain HLS or progressive — not DRM-encrypted),
   * best first. DRM-encrypted streams are excluded because we can't decrypt them anonymously
   * (those tracks fall back to the SoundCloud widget instead).
   */
  private orderedPlayableTranscodings(
    transcodings: SoundCloudTranscoding[] | undefined
  ): SoundCloudTranscoding[] {
    if (!transcodings || transcodings.length === 0) {
      return [];
    }

    return [...transcodings]
      .filter((t) => {
        const protocol = t.format?.protocol ?? "";
        return Boolean(t.url) && (protocol === "hls" || protocol === "progressive");
      })
      .map((t) => ({ transcoding: t, score: this.scoreTranscoding(t) }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.transcoding);
  }

  private scoreTranscoding(t: SoundCloudTranscoding): number {
    const protocol = t.format?.protocol ?? "";
    const preset = t.preset ?? "";

    let score = 0;
    // Prefer PROGRESSIVE over HLS. Progressive is a direct MP3 played by a native <audio>
    // element — far more reliable than HLS (hls.js stalls on some SoundCloud playlists, so a
    // free track that plays fine on soundcloud.com won't play here). resolveStream returns only
    // the FIRST stream that resolves, so if a flaky HLS is picked first and then fails mid-play,
    // we drop to the widget and never retry the progressive stream. Making progressive win first
    // avoids that trap entirely for the (many) tracks that offer both.
    if (protocol === "progressive") score += 32;
    if (protocol === "hls") score += 26;
    // mp3 is the most universally-resolvable free transcoding; aac is next.
    if (/mp3/i.test(preset)) score += 25;
    else if (/aac/i.test(preset)) score += 15;
    if (/160/.test(preset)) score += 8;
    // Adaptive `abr_*` streams intermittently 404 — keep them only as a last resort.
    if (/abr/i.test(preset)) score -= 25;
    if (/preview/i.test(preset)) score -= 30;
    return score;
  }

  private isSuccessStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }
}

/** Accepts a full URL, `soundcloud.com/name`, `@name`, or a bare handle → canonical profile URL. */
function normalizeProfileUrl(input: string): string {
  let value = input.trim().replace(/^@/, "");
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return value.split(/[?#]/)[0];
  }
  if (/^(m\.)?soundcloud\.com\//i.test(value)) {
    return `https://${value.split(/[?#]/)[0]}`;
  }
  return `https://soundcloud.com/${value.replace(/^\/+/, "").split(/[?#]/)[0]}`;
}

/**
 * SoundCloud serves a tiny ~100px "-large" crop by default. Swap the size token for a 500px
 * variant so covers aren't blurry. Falls back to the original URL if the pattern doesn't match.
 */
function upscaleSoundCloudArtwork(url?: string | null): string | undefined {
  if (!url) {
    return undefined;
  }
  return url.replace(/-(large|t\d+x\d+|badge|small|tiny|original)\.(jpg|jpeg|png)/i, "-t500x500.$2");
}

function extractSoundCloudNumericTrackId(track: UnifiedTrack): string | undefined {
  for (const candidate of [track.providerTrackId, track.id, track.providerUri, track.externalUrl]) {
    const match = candidate?.match(/(\d+)(?!.*\d)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function getSoundCloudApiError(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: string;
      message?: string;
      errors?: Array<{ error_message?: string }>;
    };
    return parsed.message ?? parsed.error ?? parsed.errors?.[0]?.error_message ?? fallback;
  } catch {
    return fallback;
  }
}

/** SoundCloud often repeats the same artist as both publisher artist and uploader username
 * (e.g. "Devstacks, Devstacks" or "OsamaSon, osamason"). Dedupe case-insensitively, keeping the
 * first (nicer-cased) spelling and any genuinely-different second creator. */
function dedupeCreators(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const name = value?.trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(name);
  }
  return result.slice(0, 2);
}

/** Drop repeated tracks (same providerTrackId) so a song the user both liked and was
 *  featured on — or that the API returns twice across pages — only appears once. */
function dedupeTracksById(tracks: UnifiedTrack[]): UnifiedTrack[] {
  const seen = new Set<string>();
  const result: UnifiedTrack[] = [];
  for (const track of tracks) {
    const key = track.providerTrackId || track.id;
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    result.push(track);
  }
  return result;
}

function computeRequiresGoPlus(track: SoundCloudInternalTrack): boolean {
  const transcodings = track.media?.transcodings ?? [];
  const plain = transcodings.filter((t) => {
    const protocol = t.format?.protocol ?? "";
    return protocol === "progressive" || protocol === "hls";
  });
  const drm = transcodings.filter((t) => {
    const protocol = t.format?.protocol ?? "";
    return protocol.includes("ctr-encrypted-hls");
  });
  // Go+ only when there are DRM transcodings but zero plain (free) ones.
  return drm.length > 0 && plain.length === 0;
}

function mapInternalTrack(track: SoundCloudInternalTrack): UnifiedTrack {
  const numericId = track.id !== undefined ? String(track.id) : undefined;
  const providerTrackId = track.urn ?? numericId ?? `soundcloud:track:${track.id}`;
  const access = track.access ?? (track.streamable === false ? "blocked" : "playable");
  const isPreviewOnly = access === "preview";

  return {
    id: `soundcloud:${providerTrackId}`,
    provider: "soundcloud",
    providerTrackId,
    title: track.title ?? "Unknown",
    creators: dedupeCreators([track.publisher_metadata?.artist, track.user?.username]),
    artworkUrl: upscaleSoundCloudArtwork(track.artwork_url),
    durationMs: track.duration ?? 0,
    explicit: false,
    externalUrl: track.permalink_url,
    genre: track.genre?.trim() || undefined,
    playable: access !== "blocked",
    description: isPreviewOnly ? "Preview only via the SoundCloud API." : undefined,
    policy: track.policy,
    requiresGoPlus: computeRequiresGoPlus(track)
  };
}

function mapInternalPlaylistCollection(playlist: SoundCloudInternalPlaylist): ProviderCollection {
  const fallbackId =
    playlist.urn ??
    (playlist.id !== undefined ? String(playlist.id) : undefined) ??
    `soundcloud-playlist:${playlist.title ?? "unknown"}`;
  const collectionId = playlist.permalink_url
    ? `resolve:${encodeURIComponent(playlist.permalink_url)}`
    : fallbackId;

  return {
    id: collectionId,
    provider: "soundcloud",
    kind: "playlist",
    title: playlist.title?.trim() || "SoundCloud playlist",
    trackCount: playlist.track_count ?? playlist.tracks?.length ?? 0,
    artworkUrl: upscaleSoundCloudArtwork(playlist.artwork_url),
    externalUrl: playlist.permalink_url,
    description: playlist.description?.trim() || undefined,
    ownerName: playlist.user?.full_name ?? playlist.user?.username
  };
}

function parseSoundCloudSubscriptionTier(
  user: Record<string, unknown>
): "unknown" | "free" | "go" | "go-plus" {
  const product = String(user.product ?? "").toLowerCase();
  const subscription = String(user.subscription ?? "").toLowerCase();
  const tier = String(user.subscription_tier ?? "").toLowerCase();

  if (product.includes("go+") || subscription.includes("go+") || tier.includes("plus")) {
    return "go-plus";
  }
  if (product.includes("go") || subscription.includes("go") || tier.includes("go")) {
    return "go";
  }
  if (product.includes("free") || subscription.includes("free") || !user.product) {
    return "free";
  }
  return "unknown";
}
