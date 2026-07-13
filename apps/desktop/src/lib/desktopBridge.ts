import type {
  OAuthProvider,
  Provider,
  ProviderCollection,
  ProviderSessionSource,
  ProviderStorageMode,
  UnifiedTrack
} from "@amp/core";

export interface ProviderRuntimeOAuthStatus {
  configured: boolean;
  hasStoredSession: boolean;
  storageMode: ProviderStorageMode;
  message: string;
}

export interface RuntimeInfo {
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

export interface DesktopConfig {
  spotifyClientId: string;
  soundCloudClientId: string;
  soundCloudClientSecret: string;
  soundCloudClientSecretConfigured: boolean;
}

export interface StoredProviderSessionStatus {
  provider: Provider;
  hasStoredSession: boolean;
  storageMode: ProviderStorageMode;
  displayName?: string;
  connectedAt?: string;
  expiresAt?: string;
}

export interface ProviderOAuthResult {
  provider: Provider;
  accessToken: string;
  expiresAt?: string;
  displayName?: string;
  requiresPremium?: boolean;
  subscriptionTier?: "unknown" | "free" | "go" | "go-plus";
  metadata?: Record<string, string>;
  connectedAt?: string;
  sessionSource: ProviderSessionSource;
  storageMode: ProviderStorageMode;
}

export interface ResolvedArtwork {
  dataUrl?: string;
  source: "cache" | "download" | "passthrough" | "none";
}

export interface GatewayResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  source: "internal" | "public" | "cache" | "fallback";
  cachedAt?: number;
}

export interface DesktopWindowState {
  canCustomize: boolean;
  isMaximized: boolean;
}

export interface SoundCloudProfileResult {
  displayName: string;
  likes: UnifiedTrack[];
  uploads: UnifiedTrack[];
  playlists: ProviderCollection[];
}

export interface SoundCloudBrowserProfile {
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

export interface SoundCloudLocalConnectResult {
  connection: ProviderOAuthResult;
  profile: SoundCloudProfileResult;
  likesCount: number;
  playlistsCount: number;
  lastSyncedAt: string;
}

function readChromeVersion(): string {
  if (typeof navigator === "undefined") {
    return "unknown";
  }

  const match = navigator.userAgent.match(/Chrome\/([\d.]+)/);
  return match?.[1] ?? "unknown";
}

export function hasDesktopBridge(): boolean {
  return typeof window !== "undefined" && typeof window.spotCloud !== "undefined";
}

export async function gatewayRequest<T = unknown>(req: {
  provider: "spotify" | "soundcloud" | "deezer" | "youtube";
  operation: string;
  variables?: Record<string, unknown>;
}): Promise<GatewayResponse<T>> {
  if (hasDesktopBridge()) {
    return window.spotCloud!.gateway.request(req) as Promise<GatewayResponse<T>>;
  }

  return {
    ok: false,
    error: "Gateway requests require the desktop app.",
    source: "fallback"
  };
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (hasDesktopBridge()) {
    return window.spotCloud!.runtime.getInfo();
  }

  return {
    platform: "browser",
    isPackaged: false,
    versions: {
      electron: "unavailable",
      chrome: readChromeVersion(),
      node: "unavailable"
    },
    configDirectory: "unavailable",
    oauth: {
      spotify: {
        configured: false,
        hasStoredSession: false,
        storageMode: "none",
        message: "Launch the packaged Electron app to use Spotify OAuth."
      },
      soundcloud: {
        configured: false,
        hasStoredSession: false,
        storageMode: "none",
        message: "Launch the packaged Electron app to use SoundCloud OAuth."
      }
    }
  };
}

export async function getDesktopConfig(): Promise<DesktopConfig> {
  if (!hasDesktopBridge()) {
    return {
      spotifyClientId: "",
      soundCloudClientId: "",
      soundCloudClientSecret: "",
      soundCloudClientSecretConfigured: false
    };
  }

  return window.spotCloud!.config.get();
}

export async function saveDesktopConfig(config: DesktopConfig): Promise<DesktopConfig> {
  if (!hasDesktopBridge()) {
    throw new Error("Desktop config can only be changed from the Electron app.");
  }

  return window.spotCloud!.config.save(config);
}

export async function reloadDesktopRuntime(): Promise<RuntimeInfo> {
  if (!hasDesktopBridge()) {
    throw new Error("Desktop runtime reload is only available from the Electron app.");
  }

  return window.spotCloud!.runtime.reload();
}

export async function openConfigDirectory(): Promise<boolean> {
  if (!hasDesktopBridge()) {
    throw new Error("Config folder access is only available from the Electron app.");
  }

  return window.spotCloud!.config.openDirectory();
}

export async function getStoredProviderSessionStatuses(): Promise<StoredProviderSessionStatus[]> {
  if (!hasDesktopBridge()) {
    return [];
  }

  return window.spotCloud!.sessions.list();
}

export async function resolveArtwork(request: {
  artworkUrl?: string;
  cacheKey?: string;
}): Promise<ResolvedArtwork> {
  if (!hasDesktopBridge()) {
    return {
      dataUrl: request.artworkUrl,
      source: request.artworkUrl ? "passthrough" : "none"
    };
  }

  return window.spotCloud!.artwork.resolve(request);
}

/** Subscribe to hardware media-key presses (play/pause/next/previous). No-op in the browser. */
export function subscribeMediaKeys(
  callback: (action: "play-pause" | "next" | "previous") => void
): () => void {
  if (!hasDesktopBridge() || !window.spotCloud?.media) {
    return () => undefined;
  }
  return window.spotCloud.media.onMediaKey(callback);
}

// ── YouTube ────────────────────────────────────────────────────────────────────────────────────
/** Loopback origin hosting the YouTube IFrame player page (the renderer embeds it via iframe). */
export async function getYouTubePlayerOrigin(): Promise<string | undefined> {
  if (!hasDesktopBridge() || !window.spotCloud?.youtube) {
    return undefined;
  }
  return window.spotCloud.youtube.getPlayerOrigin();
}

// ── Local music ────────────────────────────────────────────────────────────────────────────────
export async function listLocalMusicFolders(): Promise<string[]> {
  if (!hasDesktopBridge() || !window.spotCloud?.localMusic) {
    return [];
  }
  return window.spotCloud.localMusic.listFolders();
}

export async function addLocalMusicFolder(): Promise<string[]> {
  if (!hasDesktopBridge() || !window.spotCloud?.localMusic) {
    return [];
  }
  return window.spotCloud.localMusic.addFolder();
}

export async function removeLocalMusicFolder(folder: string): Promise<string[]> {
  if (!hasDesktopBridge() || !window.spotCloud?.localMusic) {
    return [];
  }
  return window.spotCloud.localMusic.removeFolder(folder);
}

export async function scanLocalMusic(): Promise<{
  ok: boolean;
  error?: string;
  tracks: UnifiedTrack[];
}> {
  if (!hasDesktopBridge() || !window.spotCloud?.localMusic) {
    return { ok: false, error: "Local music is only available in the desktop app.", tracks: [] };
  }
  return window.spotCloud.localMusic.scan();
}

export async function getDesktopWindowState(): Promise<DesktopWindowState> {
  if (!hasDesktopBridge()) {
    return {
      canCustomize: false,
      isMaximized: false
    };
  }

  return window.spotCloud!.windowControls.getState();
}

export async function finishDesktopStartupWindow(): Promise<DesktopWindowState> {
  if (!hasDesktopBridge()) {
    return {
      canCustomize: false,
      isMaximized: false
    };
  }

  return window.spotCloud!.windowControls.finishStartup();
}

export async function minimizeDesktopWindow(): Promise<void> {
  if (hasDesktopBridge()) {
    await window.spotCloud!.windowControls.minimize();
  }
}

export async function toggleDesktopWindowMaximize(): Promise<DesktopWindowState> {
  if (!hasDesktopBridge()) {
    return {
      canCustomize: false,
      isMaximized: false
    };
  }

  return window.spotCloud!.windowControls.toggleMaximize();
}

export async function closeDesktopWindow(): Promise<void> {
  if (hasDesktopBridge()) {
    await window.spotCloud!.windowControls.close();
  }
}

/** Shrink the window into the always-on-top mini-player (or restore it). No-op without the bridge. */
export async function setDesktopCompactMode(compact: boolean): Promise<void> {
  if (hasDesktopBridge()) {
    await window.spotCloud!.windowControls.setCompactMode(compact);
  }
}

export async function openDevTools(): Promise<void> {
  if (hasDesktopBridge()) {
    await window.spotCloud!.windowControls.openDevTools();
  }
}

export async function clearStoredProviderSession(provider: Provider): Promise<void> {
  if (!hasDesktopBridge()) {
    throw new Error("Stored provider sessions can only be cleared from the Electron app.");
  }

  await window.spotCloud!.sessions.clear(provider);
}

export async function refreshStoredProviderSession(request: {
  provider: Provider;
}): Promise<ProviderOAuthResult | null> {
  if (!hasDesktopBridge()) {
    return null;
  }

  return window.spotCloud!.sessions.refresh(request);
}

export async function openExternal(url: string): Promise<boolean> {
  if (hasDesktopBridge()) {
    return window.spotCloud!.shell.openExternal(url);
  }

  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/** Download a free (non-DRM) SoundCloud track as MP3 into the user's Music/AMP folder. */
export async function downloadSoundCloudTrack(
  track: UnifiedTrack
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!hasDesktopBridge()) {
    return { ok: false, error: "Downloads require the desktop app." };
  }
  return window.spotCloud!.soundcloud.downloadTrack({ track });
}

export async function getSoundCloudPublicClientId(): Promise<string | undefined> {
  if (!hasDesktopBridge()) {
    return undefined;
  }

  return window.spotCloud!.soundcloud.getPublicClientId();
}

/** Now-playing snapshot the main process turns into a Discord activity. */
export interface DiscordPresencePayload {
  title: string;
  artists: string;
  album?: string;
  provider: Provider;
  status: "playing" | "paused";
  /** Epoch ms the current track started (Date.now() - positionMs). */
  startedAtMs?: number;
  artworkUrl?: string;
  externalUrl?: string;
}

/** Push (or with null, clear) the Discord Rich Presence activity. No-op without the desktop bridge. */
export async function setDiscordPresence(payload: DiscordPresencePayload | null): Promise<void> {
  if (!hasDesktopBridge()) {
    return;
  }
  await window.spotCloud!.discord.setPresence(payload).catch(() => undefined);
}

/** Tell the main process whether Discord Rich Presence may connect at all. */
export async function setDiscordPresenceEnabled(enabled: boolean): Promise<void> {
  if (!hasDesktopBridge()) {
    return;
  }
  await window.spotCloud!.discord.setEnabled(enabled).catch(() => undefined);
}

export type SoundCloudWebResult = GatewayResponse<SoundCloudProfileResult>;

/** Silently re-loads the library if a SoundCloud web session is already stored. */
export async function soundCloudWebReload(): Promise<SoundCloudWebResult> {
  if (!hasDesktopBridge()) {
    return {
      ok: false,
      error: "SoundCloud sign-in requires the desktop app.",
      source: "fallback"
    };
  }
  return window.spotCloud!.soundcloud.webReload() as Promise<SoundCloudWebResult>;
}

export async function soundCloudWebHasSession(): Promise<boolean> {
  if (!hasDesktopBridge()) {
    return false;
  }
  return window.spotCloud!.soundcloud.webHasSession();
}

export async function listSoundCloudLocalProfiles(): Promise<GatewayResponse<SoundCloudBrowserProfile[]>> {
  if (!hasDesktopBridge()) {
    return {
      ok: false,
      error: "SoundCloud Local Connect requires the desktop app.",
      source: "fallback"
    };
  }

  return window.spotCloud!.soundcloud.localListProfiles() as Promise<GatewayResponse<SoundCloudBrowserProfile[]>>;
}

export async function connectSoundCloudLocalProfile(
  profileId: string
): Promise<GatewayResponse<SoundCloudLocalConnectResult>> {
  if (!hasDesktopBridge()) {
    return {
      ok: false,
      error: "SoundCloud Local Connect requires the desktop app.",
      source: "fallback"
    };
  }

  return window.spotCloud!.soundcloud.localConnect({ profileId }) as Promise<
    GatewayResponse<SoundCloudLocalConnectResult>
  >;
}

/**
 * Signs into SoundCloud in the user's REAL browser (Chrome/Edge/Brave) and reads the token over
 * CDP — the DataDome-safe path that works on every Chromium browser. Resolves once connected.
 */
export async function connectSoundCloudViaBrowser(): Promise<GatewayResponse<SoundCloudLocalConnectResult>> {
  if (!hasDesktopBridge()) {
    return {
      ok: false,
      error: "SoundCloud sign-in requires the desktop app.",
      source: "fallback"
    };
  }

  return window.spotCloud!.soundcloud.systemBrowserSignIn() as Promise<GatewayResponse<SoundCloudLocalConnectResult>>;
}

/** Opens an AMP-owned SoundCloud sign-in window and resolves once the user is connected. */
export async function connectSoundCloudInApp(): Promise<GatewayResponse<SoundCloudLocalConnectResult>> {
  if (!hasDesktopBridge()) {
    return {
      ok: false,
      error: "SoundCloud sign-in requires the desktop app.",
      source: "fallback"
    };
  }

  return window.spotCloud!.soundcloud.inAppSignIn() as Promise<GatewayResponse<SoundCloudLocalConnectResult>>;
}

export async function openSoundCloudLocalSignin(
  profileId: string
): Promise<GatewayResponse<{ opened: boolean }>> {
  if (!hasDesktopBridge()) {
    return {
      ok: false,
      error: "SoundCloud Local Connect requires the desktop app.",
      source: "fallback"
    };
  }

  return window.spotCloud!.soundcloud.localOpenSignin({ profileId }) as Promise<
    GatewayResponse<{ opened: boolean }>
  >;
}

export async function closeSoundCloudLocalBrowser(
  profileId: string
): Promise<GatewayResponse<{ closed: boolean }>> {
  if (!hasDesktopBridge()) {
    return {
      ok: false,
      error: "SoundCloud Local Connect requires the desktop app.",
      source: "fallback"
    };
  }

  return window.spotCloud!.soundcloud.localCloseBrowser({ profileId }) as Promise<
    GatewayResponse<{ closed: boolean }>
  >;
}

export async function setSoundCloudWebTrackLiked(
  track: UnifiedTrack,
  liked: boolean
): Promise<GatewayResponse<{ liked: boolean }>> {
  if (!hasDesktopBridge()) {
    return { ok: false, error: "SoundCloud likes require the desktop app.", source: "fallback" };
  }

  return window.spotCloud!.soundcloud.webSetTrackLiked({ track, liked }) as Promise<
    GatewayResponse<{ liked: boolean }>
  >;
}

export async function setSoundCloudLocalTrackLiked(
  track: UnifiedTrack,
  liked: boolean
): Promise<GatewayResponse<{ liked: boolean }>> {
  if (!hasDesktopBridge()) {
    return { ok: false, error: "SoundCloud likes require the desktop app.", source: "fallback" };
  }

  return window.spotCloud!.soundcloud.localSetTrackLiked({ track, liked }) as Promise<
    GatewayResponse<{ liked: boolean }>
  >;
}

export async function soundCloudWebSignOut(): Promise<void> {
  if (hasDesktopBridge()) {
    await window.spotCloud!.soundcloud.webSignOut();
  }
}

export async function getAnonymousSpotifySession(): Promise<
  { accessToken: string; clientToken: string } | undefined
> {
  if (!hasDesktopBridge()) {
    return undefined;
  }

  return window.spotCloud!.spotify.getAnonymousSession();
}

export async function connectDesktopProvider(request: {
  provider: Provider;
}): Promise<ProviderOAuthResult> {
  if (!hasDesktopBridge()) {
    throw new Error(
      "The desktop bridge is unavailable, so provider OAuth can only run inside the packaged Electron app."
    );
  }

  return window.spotCloud!.oauth.connect(request);
}

/** Abort an in-flight provider sign-in (the user closed the browser tab / hit Cancel). */
export async function cancelConnectDesktopProvider(provider: Provider): Promise<void> {
  if (!hasDesktopBridge()) {
    return;
  }
  await window.spotCloud!.oauth.cancelConnect(provider).catch(() => undefined);
}

export interface WidevineStatus {
  /** True once the castLabs Widevine CDM component has finished installing/initializing. */
  ready: boolean;
  /** Raw `components.status()` JSON (CDM version etc.), for diagnostics. */
  statusText: string;
}

export async function getWidevineStatus(): Promise<WidevineStatus> {
  if (!hasDesktopBridge()) {
    return { ready: false, statusText: "" };
  }

  return window.spotCloud!.drm.getWidevineStatus();
}
