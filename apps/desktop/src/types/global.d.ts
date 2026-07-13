import type {
  OAuthProvider,
  Provider,
  ProviderCollection,
  ProviderSessionSource,
  ProviderStorageMode,
  UnifiedTrack
} from "@amp/core";

interface SoundCloudProfileResult {
  displayName: string;
  likes: UnifiedTrack[];
  uploads: UnifiedTrack[];
  playlists: ProviderCollection[];
}

interface ProviderRuntimeOAuthStatus {
  configured: boolean;
  hasStoredSession: boolean;
  storageMode: ProviderStorageMode;
  message: string;
}

interface RuntimeInfo {
  platform: string;
  isPackaged: boolean;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  configDirectory: string;
  oauth: Record<OAuthProvider, ProviderRuntimeOAuthStatus>;
  devServerUrl?: string;
}

interface DesktopConfig {
  spotifyClientId: string;
  soundCloudClientId: string;
  soundCloudClientSecret: string;
  soundCloudClientSecretConfigured: boolean;
}

interface StoredProviderSessionStatus {
  provider: Provider;
  hasStoredSession: boolean;
  storageMode: ProviderStorageMode;
  displayName?: string;
  connectedAt?: string;
  expiresAt?: string;
}

interface ProviderOAuthResult {
  provider: Provider;
  accessToken: string;
  expiresAt?: string;
  displayName?: string;
  requiresPremium?: boolean;
  metadata?: Record<string, string>;
  connectedAt?: string;
  sessionSource: ProviderSessionSource;
  storageMode: ProviderStorageMode;
}

interface SoundCloudBrowserProfile {
  id: string;
  browserName: string;
  profileName: string;
  browserKey: string;
  profileDirectory: string;
  userDataDirectory: string;
  executablePath?: string;
  status: "available" | "profile-locked" | "unsupported";
  statusLabel: string;
}

interface SoundCloudLocalConnectResult {
  connection: ProviderOAuthResult;
  profile: SoundCloudProfileResult;
  likesCount: number;
  playlistsCount: number;
  lastSyncedAt: string;
}

interface ResolvedArtwork {
  dataUrl?: string;
  source: "cache" | "download" | "passthrough" | "none";
}

interface DesktopWindowState {
  canCustomize: boolean;
  isMaximized: boolean;
}

interface GatewayRequest {
  // Deezer is an auxiliary catalogue provider (audio features only), not a playback Provider.
  provider: Provider | "deezer";
  operation: string;
  variables?: Record<string, unknown>;
}

interface GatewayResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  source: "internal" | "public" | "cache" | "fallback";
  cachedAt?: number;
}

interface SpotCloudBridge {
  runtime: {
    getInfo(): Promise<RuntimeInfo>;
    reload(): Promise<RuntimeInfo>;
  };
  gateway: {
    request(req: GatewayRequest): Promise<GatewayResponse>;
  };
  config: {
    get(): Promise<DesktopConfig>;
    save(config: DesktopConfig): Promise<DesktopConfig>;
    openDirectory(): Promise<boolean>;
  };
  sessions: {
    list(): Promise<StoredProviderSessionStatus[]>;
    clear(provider: Provider): Promise<void>;
    refresh(request: { provider: Provider }): Promise<ProviderOAuthResult | null>;
  };
  shell: {
    openExternal(url: string): Promise<boolean>;
  };
  soundcloud: {
    getPublicClientId(): Promise<string>;
    webReload(): Promise<GatewayResponse<SoundCloudProfileResult>>;
    webHasSession(): Promise<boolean>;
    webSetTrackLiked(request: { track: UnifiedTrack; liked: boolean }): Promise<GatewayResponse<{ liked: boolean }>>;
    webSignOut(): Promise<{ ok: boolean }>;
    systemBrowserSignIn(): Promise<GatewayResponse<SoundCloudLocalConnectResult>>;
    downloadTrack(request: { track: UnifiedTrack }): Promise<{ ok: boolean; path?: string; error?: string }>;
    inAppSignIn(): Promise<GatewayResponse<SoundCloudLocalConnectResult>>;
    localListProfiles(): Promise<GatewayResponse<SoundCloudBrowserProfile[]>>;
    localConnect(request: { profileId: string }): Promise<GatewayResponse<SoundCloudLocalConnectResult>>;
    localOpenSignin(request: { profileId: string }): Promise<GatewayResponse<{ opened: boolean }>>;
    localCloseBrowser(request: { profileId: string }): Promise<GatewayResponse<{ closed: boolean }>>;
    localSetTrackLiked(request: { track: UnifiedTrack; liked: boolean }): Promise<GatewayResponse<{ liked: boolean }>>;
  };
  spotify: {
    getAnonymousSession(): Promise<{ accessToken: string; clientToken: string } | undefined>;
  };
  youtube: {
    getPlayerOrigin(): Promise<string | undefined>;
  };
  localMusic: {
    listFolders(): Promise<string[]>;
    addFolder(): Promise<string[]>;
    removeFolder(folder: string): Promise<string[]>;
    scan(): Promise<{ ok: boolean; error?: string; tracks: UnifiedTrack[] }>;
  };
  discord: {
    setPresence(payload: unknown): Promise<{ ok: boolean }>;
    setEnabled(enabled: boolean): Promise<{ ok: boolean }>;
  };
  artwork: {
    resolve(request: { artworkUrl?: string; cacheKey?: string }): Promise<ResolvedArtwork>;
  };
  media: {
    onMediaKey(callback: (action: "play-pause" | "next" | "previous") => void): () => void;
  };
  windowControls: {
    getState(): Promise<DesktopWindowState>;
    finishStartup(): Promise<DesktopWindowState>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<DesktopWindowState>;
    setCompactMode(compact: boolean): Promise<{ compact: boolean }>;
    close(): Promise<void>;
    openDevTools(): Promise<void>;
  };
  oauth: {
    connect(request: { provider: Provider }): Promise<ProviderOAuthResult>;
    cancelConnect(provider: Provider): Promise<{ ok: boolean }>;
  };
  drm: {
    getWidevineStatus(): Promise<{ ready: boolean; statusText: string }>;
  };
}

declare global {
  interface Window {
    spotCloud?: SpotCloudBridge;
    Spotify?: {
      Player: new (config: {
        name: string;
        getOAuthToken: (callback: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayerInstance;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }

  interface SpotifyPlayerStateTrack {
    uri: string;
    id?: string;
    name: string;
    duration_ms: number;
  }

  interface SpotifyPlayerState {
    position: number;
    duration: number;
    paused: boolean;
    track_window: {
      current_track: SpotifyPlayerStateTrack;
    };
  }

  interface SpotifyPlayerInstance {
    activateElement(): Promise<void>;
    connect(): Promise<boolean>;
    disconnect(): void;
    addListener(event: string, callback: (payload: unknown) => void): boolean;
    removeListener(event: string): boolean;
    pause(): Promise<void>;
    resume(): Promise<void>;
    seek(positionMs: number): Promise<void>;
    setVolume(volume: number): Promise<void>;
  }
}

export {};
