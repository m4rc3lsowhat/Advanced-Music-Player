import type { ProviderCollection, TrackCollection, UnifiedTrack } from "@amp/core";
import { CacheStore } from "./CacheStore";
import { DeezerGateway } from "./DeezerGateway";
import { SoundCloudInternalGateway } from "./SoundCloudInternalGateway";
import { SpotifyPartnerGateway } from "./SpotifyPartnerGateway";
import { YouTubeMusicGateway } from "./YouTubeMusicGateway";
import type { GatewayRequest, GatewayResponse } from "./types";

export type { GatewayRequest, GatewayResponse } from "./types";

export class ProviderGateway {
  private cache: CacheStore;
  private spotify: SpotifyPartnerGateway;
  private soundcloud: SoundCloudInternalGateway;
  private deezer: DeezerGateway;
  private youtube: YouTubeMusicGateway;

  constructor(userDataPath: string) {
    this.cache = new CacheStore(userDataPath);
    this.spotify = new SpotifyPartnerGateway(this.cache);
    this.soundcloud = new SoundCloudInternalGateway(this.cache);
    this.deezer = new DeezerGateway(this.cache);
    this.youtube = new YouTubeMusicGateway(this.cache);
  }

  async initialize(): Promise<void> {
    await this.cache.initialize();
    await Promise.all([this.spotify.initialize(), this.soundcloud.initialize()]);
  }

  async request(req: GatewayRequest): Promise<GatewayResponse> {
    switch (req.provider) {
      case "spotify":
        return this.handleSpotifyRequest(req);
      case "soundcloud":
        return this.handleSoundCloudRequest(req);
      case "deezer":
        return this.handleDeezerRequest(req);
      case "youtube":
        return this.handleYouTubeRequest(req);
      default:
        return { ok: false, error: `Unknown provider: ${req.provider}`, source: "fallback" };
    }
  }

  private async handleYouTubeRequest(req: GatewayRequest): Promise<GatewayResponse> {
    switch (req.operation) {
      case "search": {
        const query = req.variables?.query as string;
        if (!query) {
          return { ok: false, error: "Search query required.", source: "fallback" };
        }
        return this.youtube.search(query);
      }
      default:
        return { ok: false, error: `Unknown YouTube operation: ${req.operation}`, source: "fallback" };
    }
  }

  private async handleDeezerRequest(req: GatewayRequest): Promise<GatewayResponse> {
    switch (req.operation) {
      case "getAudioFeatures": {
        return this.deezer.getAudioFeatures({
          title: req.variables?.title as string | undefined,
          artist: req.variables?.artist as string | undefined,
          durationMs: req.variables?.durationMs as number | undefined,
          isrc: req.variables?.isrc as string | undefined
        });
      }
      default:
        return { ok: false, error: `Unknown Deezer operation: ${req.operation}`, source: "fallback" };
    }
  }

  async getAnonymousSpotifySession(): Promise<{ accessToken: string; clientToken: string } | undefined> {
    const session = await this.spotify.getAnonymousSession();
    if (!session) return undefined;
    return {
      accessToken: session.accessToken,
      clientToken: session.clientToken
    };
  }

  getSoundCloudClientId(): Promise<string> {
    return this.soundcloud.resolveClientId();
  }

  /** Persist pending cache writes immediately (sync) — called on quit so the debounce doesn't drop them. */
  flushCache(): void {
    this.cache.flushNow();
  }

  invalidateProviderCache(provider: "spotify" | "soundcloud" | "all"): void {
    if (provider === "all") {
      this.cache.invalidate();
    } else {
      this.cache.invalidate(new RegExp(`^${provider}:`));
    }
  }

  clearSoundCloudSession(): void {
    this.soundcloud.clearSession();
  }

  private async handleSpotifyRequest(req: GatewayRequest): Promise<GatewayResponse> {
    const accessToken = req.variables?.accessToken as string | undefined;
    if (!accessToken) {
      return { ok: false, error: "Spotify access token required.", source: "fallback" };
    }

    switch (req.operation) {
      case "search": {
        const query = req.variables?.query as string;
        if (!query) {
          return { ok: false, error: "Search query required.", source: "fallback" };
        }
        const result = await this.spotify.search(query, accessToken);
        return result;
      }
      case "getCollections": {
        const result = await this.spotify.getCollections(accessToken);
        return result;
      }
      case "getCollectionTracks": {
        const collectionId = req.variables?.collectionId as string;
        if (!collectionId) {
          return { ok: false, error: "collectionId required.", source: "fallback" };
        }
        const result = await this.spotify.getCollectionTracks(collectionId, accessToken);
        return result;
      }
      default:
        return { ok: false, error: `Unknown Spotify operation: ${req.operation}`, source: "fallback" };
    }
  }

  private async handleSoundCloudRequest(req: GatewayRequest): Promise<GatewayResponse> {
    const accessToken = req.variables?.accessToken as string | undefined;

    switch (req.operation) {
      case "search": {
        const query = req.variables?.query as string;
        if (!query) {
          return { ok: false, error: "Search query required.", source: "fallback" };
        }
        return this.soundcloud.search(query);
      }
      case "resolveStream": {
        const track = req.variables?.track as UnifiedTrack | undefined;
        if (!track) {
          return { ok: false, error: "Track required.", source: "fallback" };
        }
        return this.soundcloud.resolveStream(track);
      }
      case "relatedTracks": {
        const track = req.variables?.track as UnifiedTrack | undefined;
        if (!track) {
          return { ok: false, error: "Track required.", source: "fallback" };
        }
        const limit = (req.variables?.limit as number | undefined) ?? 20;
        return this.soundcloud.relatedTracks(track, limit);
      }
      case "getCollections": {
        if (!accessToken) {
          return { ok: false, error: "SoundCloud access token required.", source: "fallback" };
        }
        return this.soundcloud.getCollections(accessToken);
      }
      case "getCollectionTracks": {
        const collectionId = req.variables?.collectionId as string;
        if (!collectionId) {
          return { ok: false, error: "collectionId required.", source: "fallback" };
        }
        if (!accessToken) {
          return { ok: false, error: "SoundCloud access token required.", source: "fallback" };
        }
        return this.soundcloud.getCollectionTracks(collectionId, accessToken);
      }
      case "resolveTrack": {
        const track = req.variables?.track as UnifiedTrack | undefined;
        if (!track) {
          return { ok: false, error: "Track required.", source: "fallback" };
        }
        return this.soundcloud.resolveTrackData(track);
      }
      case "resolveProfile": {
        const profileUrl = req.variables?.profileUrl as string | undefined;
        if (!profileUrl) {
          return { ok: false, error: "Profile URL required.", source: "fallback" };
        }
        return this.soundcloud.resolveProfile(profileUrl);
      }
      case "resolveAuthenticatedProfile": {
        const oauthToken = req.variables?.oauthToken as string | undefined;
        if (!oauthToken) {
          return { ok: false, error: "SoundCloud session token required.", source: "fallback" };
        }
        return this.soundcloud.resolveAuthenticatedProfile(oauthToken);
      }
      case "setTrackLiked": {
        const oauthToken = req.variables?.oauthToken as string | undefined;
        const accessToken = req.variables?.accessToken as string | undefined;
        const track = req.variables?.track as UnifiedTrack | undefined;
        const liked = req.variables?.liked as boolean | undefined;
        const authorizationHeader = oauthToken
          ? `OAuth ${oauthToken}`
          : accessToken
            ? `Bearer ${accessToken}`
            : undefined;
        if (!authorizationHeader) {
          return { ok: false, error: "SoundCloud session token required.", source: "fallback" };
        }
        if (!track) {
          return { ok: false, error: "Track required.", source: "fallback" };
        }
        if (typeof liked !== "boolean") {
          return { ok: false, error: "Liked flag required.", source: "fallback" };
        }
        const sessionCookie = req.variables?.sessionCookie as string | undefined;
        return this.soundcloud.setTrackLiked(track, authorizationHeader, liked, sessionCookie);
      }
      default:
        return { ok: false, error: `Unknown SoundCloud operation: ${req.operation}`, source: "fallback" };
    }
  }
}
