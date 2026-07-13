import {
  app,
  BrowserWindow,
  components,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray
} from "electron";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, promises as fs, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import type { ProviderCollection, UnifiedTrack } from "@amp/core";
import { ProviderGateway, type GatewayResponse } from "./gateway/index.js";
import { LocalMusicManager } from "./localMusic.js";
import { ensureYouTubePlayerOrigin, stopYouTubePlayerServer } from "./youtubePlayer.js";
import { readDecryptedCookies, KeychainAccessError } from "./chromiumCookies.js";
import {
  readChromiumCookiesViaRemoteDebugging,
  signInToSoundCloudViaBrowser
} from "./chromiumRemoteSession.js";
import { extractDataDomeCaptchaUrl, buildCaptchaOverlayScript } from "./soundcloudCaptcha.js";
import { DiscordPresenceClient, type DiscordActivity } from "./discordPresence.js";
import { trayIconDataUrl, appIconDataUrl } from "./trayIconData.js";
import { listFirefoxProfiles, readFirefoxCookies } from "./firefoxCookies.js";
import { readSafariCookies, FullDiskAccessError } from "./safariCookies.js";
import { clearSoundCloudResolverSession } from "./SoundCloudResolverWindow.js";

type Provider = "spotify" | "soundcloud";
type ProviderStorageMode = "none" | "local-secure" | "memory-only";
type ProviderSessionSource = "local" | "memory";

type ManagedDesktopEnvKey =
  | "SPOTIFY_CLIENT_ID"
  | "SOUNDCLOUD_CLIENT_ID"
  | "SOUNDCLOUD_CLIENT_SECRET"
  | "DISCORD_CLIENT_ID";

interface OAuthRequest {
  provider: Provider;
}

interface ArtworkRequest {
  artworkUrl?: string;
  cacheKey?: string;
}

interface SoundCloudTrackLikeRequest {
  track: UnifiedTrack;
  liked: boolean;
}

type SoundCloudLocalConnectErrorCode =
  | "no-session-found"
  | "session-expired"
  | "access-blocked"
  | "profile-locked"
  | "browser-running"
  | "app-bound-encryption"
  | "unsupported-browser"
  | "full-disk-access"
  | "keychain-denied"
  | "validation-failed";

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

interface SoundCloudLocalConnectRequest {
  profileId: string;
}

interface SoundCloudLocalConnectResult {
  connection: ProviderOAuthResult;
  profile: {
    displayName: string;
    likes: UnifiedTrack[];
    uploads: UnifiedTrack[];
    playlists: ProviderCollection[];
  };
  likesCount: number;
  playlistsCount: number;
  lastSyncedAt: string;
}

interface DesktopConfig {
  spotifyClientId: string;
  soundCloudClientId: string;
  soundCloudClientSecret: string;
  soundCloudClientSecretConfigured: boolean;
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
  oauth: Record<Provider, ProviderRuntimeOAuthStatus>;
  devServerUrl?: string;
}

interface ProviderConnectionPayload {
  provider: Provider;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  displayName?: string;
  requiresPremium?: boolean;
  subscriptionTier?: "unknown" | "free" | "go" | "go-plus";
  metadata?: Record<string, string>;
}

interface ProviderOAuthResult extends ProviderConnectionPayload {
  connectedAt: string;
  sessionSource: ProviderSessionSource;
  storageMode: ProviderStorageMode;
}

interface LoopbackResult {
  code?: string;
  state?: string;
  error?: string;
  redirectUri: string;
}

interface StoredProviderSessionRecord {
  provider: Provider;
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  expiresAt?: string;
  displayName?: string;
  requiresPremium?: boolean;
  metadata?: Record<string, string>;
  connectedAt: string;
  storageMode: ProviderStorageMode;
}

interface VolatileProviderSession extends ProviderConnectionPayload {
  connectedAt: string;
  storageMode: ProviderStorageMode;
}

interface StoredProviderSessionStatus {
  provider: Provider;
  hasStoredSession: boolean;
  storageMode: ProviderStorageMode;
  displayName?: string;
  connectedAt?: string;
  expiresAt?: string;
}

interface ResolvedArtwork {
  dataUrl?: string;
  source: "cache" | "download" | "passthrough" | "none";
}

interface DesktopWindowState {
  canCustomize: boolean;
  isMaximized: boolean;
}

interface CachedSoundCloudPublicClientIdRecord {
  fetchedAt: number;
  value: string;
}

interface JsonErrorBody {
  error?: {
    message?: string;
    status?: number;
  };
  message?: string;
  errors?: Array<{
    error_message?: string;
    detail?: string;
    title?: string;
  }>;
}

const isDev = !!process.env.VITE_DEV_SERVER_URL;

// Custom media scheme for local files. MUST be registered before app ready. `stream` +
// `supportFetchAPI` let <audio> issue ranged requests against it; `secure` + `standard` make it a
// first-class origin so media playback and seeking work like http(s). (YouTube plays through the
// official IFrame player in the renderer, so it needs no custom protocol.)
protocol.registerSchemesAsPrivileged([
  {
    scheme: "amp-local",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

// OAuth deep-link scheme. The redirect URIs registered in the Spotify/SoundCloud dashboards use
// musync://, so that stays the ACTIVE scheme for outbound auth requests; amp:// is also registered
// and accepted inbound, so the dashboards can migrate to it later without a code change.
const customProtocolScheme = "musync";
const protocolSchemes = [customProtocolScheme, "amp"];
const startupWindowBounds = { width: 520, height: 360 };
const mainWindowMinimumBounds = { width: 1080, height: 720 };
const desktopAuthUserAgent =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const managedDesktopEnvKeys: ManagedDesktopEnvKey[] = [
  "SPOTIFY_CLIENT_ID",
  "SOUNDCLOUD_CLIENT_ID",
  "SOUNDCLOUD_CLIENT_SECRET",
  "DISCORD_CLIENT_ID"
];

let mainWindow: BrowserWindow | null = null;

// Discord Rich Presence — shows the now-playing track on the user's Discord profile. No-op until a
// DISCORD_CLIENT_ID is configured and Discord is running; see discordPresence.ts.
const discordPresence = new DiscordPresenceClient();

// Discord presence is opt-in (Settings → Discord). The renderer pushes the persisted flag on boot;
// until it does, AMP holds no Discord connection at all.
let discordPresenceEnabled = false;

function getDiscordClientId(): string {
  return process.env.DISCORD_CLIENT_ID?.trim() || "1514494558417846343";
}

/** Payload the renderer sends on each track/play-state change. */
interface DiscordPresencePayload {
  title: string;
  artists: string;
  album?: string;
  provider: "spotify" | "soundcloud" | "youtube" | "local";
  status: "playing" | "paused";
  /** Epoch ms the current track started (renderer computes Date.now() - positionMs). */
  startedAtMs?: number;
  artworkUrl?: string;
  externalUrl?: string;
}

function discordActivityFromPayload(payload: DiscordPresencePayload | null): DiscordActivity | null {
  if (!payload || !payload.title) {
    return null;
  }
  const providerLabel = {
    spotify: "Spotify",
    soundcloud: "SoundCloud",
    youtube: "YouTube",
    local: "Local file"
  }[payload.provider];
  const buttons =
    payload.externalUrl && isAllowedDiscordTrackUrl(payload.provider, payload.externalUrl)
      ? [{ label: `Listen on ${providerLabel}`, url: payload.externalUrl }]
      : undefined;
  // The album cover as the big art (current Discord proxies https image URLs in RPC). An explicit
  // uploaded asset key via DISCORD_LARGE_IMAGE still wins when set; the small badge shows whether
  // it's Spotify or SoundCloud (and doubles as the play/pause indicator on hover).
  const largeImage =
    process.env.DISCORD_LARGE_IMAGE?.trim() ||
    (payload.artworkUrl && isAllowedArtworkUrl(payload.artworkUrl) ? payload.artworkUrl : undefined);
  return {
    details: payload.title,
    state: payload.artists ? `by ${payload.artists}` : providerLabel,
    // A running elapsed timer only makes sense while playing.
    startTimestamp: payload.status === "playing" ? payload.startedAtMs : undefined,
    largeImageKey: largeImage,
    largeImageText: payload.album?.trim() || `${providerLabel} · AMP`,
    smallImageText: `${providerLabel} · ${payload.status === "playing" ? "Playing" : "Paused"}`,
    buttons
  };
}

// Close-to-tray: clicking X hides AMP to a system-tray icon (like Discord/Spotify) instead of leaving
// an invisible, headless process tree behind. A real Quit lives in the tray menu.
let tray: Tray | undefined;
let isQuitting = false;
let shownTrayHint = false;

function brandIcon(dataUrl: string) {
  return nativeImage.createFromDataURL(dataUrl);
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  void createMainWindow();
}

// Real, full exit (tray "Quit" or OS shutdown). Force-destroys every window so a hung helper renderer
// (the SoundCloud verify window sits on soundcloud.com with its own timers) can't keep the process
// tree alive — that lingering tree is exactly the orphaned AMP.exe processes seen in Task Manager.
function quitAmp(): void {
  isQuitting = true;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.destroy();
    } catch {
      // ignore
    }
  }
  discordPresence.stop();
  if (tray) {
    tray.destroy();
    tray = undefined;
  }
  app.quit();
  // Belt-and-suspenders: if anything still lingers shortly after, force the whole tree down.
  setTimeout(() => app.exit(0), 1500);
}

function createTray(): void {
  if (tray) {
    return;
  }
  tray = new Tray(brandIcon(trayIconDataUrl));
  tray.setToolTip("AMP — Advanced Music Player");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show AMP", click: () => showMainWindow() },
      { type: "separator" },
      { label: "Quit AMP", click: () => quitAmp() }
    ])
  );
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
}

const startupLogPath = path.join(process.env.TEMP ?? os.tmpdir(), "spot-cloud-startup.log");
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const bootEnv = { ...process.env };
const fallbackManagedEnv = new Map<ManagedDesktopEnvKey, string | undefined>();
const volatileProviderSessions = new Map<Provider, VolatileProviderSession>();
const artworkRequests = new Map<string, Promise<ResolvedArtwork>>();
const pendingProtocolResolvers = new Map<
  Provider,
  { resolve: (value: LoopbackResult) => void }
>();
// Cancellers for in-flight OAuth waits (loopback or custom-protocol), keyed by provider. Lets the
// renderer abort a sign-in the user walked away from (closed the browser tab) instead of leaving
// the UI on "Connecting…" until the timeout fires.
const pendingAuthCancellers = new Map<Provider, () => void>();
// Recognizable marker so the renderer can treat a user cancel as "back to disconnected", not an error.
const AUTH_CANCELLED_MESSAGE = "Sign-in cancelled.";
let cachedSoundCloudPublicClientId:
  | CachedSoundCloudPublicClientIdRecord
  | undefined;

let providerGateway: ProviderGateway | undefined;
let localMusicManager: LocalMusicManager | undefined;
let mainWindowStartupComplete = false;

// The internal Electron app name now matches the brand: "AMP". The userData dir derives from it
// and holds the encrypted Spotify/SoundCloud sessions, widget partitions, and localStorage
// prefs/stats — so this rename is paired with the profile migration below. Must run before any
// app.getPath("userData").
app.setName("AMP");

// Dev and packaged builds both derive their userData from the same app name, so they historically
// shared one userData dir AND one single-instance lock. A running `pnpm dev` instance would hold
// the lock, and a packaged launch would silently `app.quit()` mid-startup (it logs `app:whenReady`
// / `initializeEnv:start` and then vanishes — no window, no error). Give the dev build its own
// userData so the packaged app and `pnpm dev` can run side by side.
if (!app.isPackaged) {
  try {
    app.setPath("userData", `${app.getPath("userData")}-dev`);
  } catch {
    // If userData can't be relocated, fall back to the shared dir (old behavior).
  }
}

// One-time profile migration across the app's name history: "@spot-cloud/desktop" → "MuSync" →
// "AMP". On the first launch under a new name, COPY the newest legacy profile that holds real
// sessions into this name's dir. Copy (not move) keeps a rollback to an older build working, and
// skipping Chromium's cache dirs keeps it fast (they rebuild on demand). The check is
// content-based (marker file) because Electron pre-creates the new userData dir during init — a
// bare existsSync(newUserData) guard can never fire (the bug that left @spot-cloud unmigrated).
try {
  const userDataDir = app.getPath("userData");
  const sessionMarker = "provider-sessions.json";
  if (!existsSync(path.join(userDataDir, sessionMarker))) {
    const suffix = app.isPackaged ? "" : "-dev";
    const legacyProfiles = [
      path.join(app.getPath("appData"), `MuSync${suffix}`),
      path.join(app.getPath("appData"), "@spot-cloud", `desktop${suffix}`)
    ];
    const source = legacyProfiles.find((dir) => existsSync(path.join(dir, sessionMarker)));
    if (source) {
      const skipDirs = new Set([
        "Cache",
        "Code Cache",
        "GPUCache",
        "DawnCache",
        "DawnGraphiteCache",
        "DawnWebGPUCache",
        "ShaderCache",
        "GrShaderCache",
        "blob_storage",
        "Crashpad",
        "logs"
      ]);
      cpSync(source, userDataDir, {
        recursive: true,
        force: false,
        filter: (src) => !skipDirs.has(path.basename(src))
      });
      logStartup(`userData:migrated-copy ${source} -> ${userDataDir}`);
    }
  }
} catch (error) {
  // Non-fatal: worst case the user reconnects providers once on the new profile.
  logStartup("userData:migration-failed", error);
}

// Windows uses the AppUserModelID to identify the app for taskbar grouping, pinning and
// notifications. It must match the NSIS shortcut's AUMID (electron-builder derives that from
// `build.appId`) so the running window adopts the installed shortcut's AMP icon instead of
// Electron's default. Harmless on macOS/Linux.
app.setAppUserModelId("com.amp.desktop");

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  // Make this explicit instead of a silent quit, so "the packaged app won't open" is diagnosable.
  logStartup("app:single-instance-lock-denied — another instance is already running; quitting");
  app.quit();
}

const STARTUP_LOG_MAX_BYTES = 2 * 1024 * 1024;

function redactLogText(value: string): string {
  return value
    .replace(/([?&](?:license_token|oauth_token|access_token|refresh_token|client_secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(?:oauth|access|refresh|license)\s*token\s*[:=]\s*[^\s,}]+/gi, "token=[redacted]");
}

function readDiscordText(value: unknown, maxLength: number, required = false): string | undefined {
  if (typeof value !== "string") {
    if (required) {
      throw new Error("Discord presence payload is malformed.");
    }
    return undefined;
  }
  const text = value.trim().slice(0, maxLength);
  if (required && !text) {
    throw new Error("Discord presence payload is malformed.");
  }
  return text || undefined;
}

function parseDiscordPresencePayload(value: unknown): DiscordPresencePayload | null {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Discord presence payload is malformed.");
  }
  const input = value as Record<string, unknown>;
  const provider = input.provider;
  const status = input.status;
  if (
    !["spotify", "soundcloud", "youtube", "local"].includes(String(provider)) ||
    (status !== "playing" && status !== "paused")
  ) {
    throw new Error("Discord presence payload is malformed.");
  }
  return {
    title: readDiscordText(input.title, 128, true)!,
    artists: readDiscordText(input.artists, 128) ?? "",
    album: readDiscordText(input.album, 128),
    provider: provider as DiscordPresencePayload["provider"],
    status,
    startedAtMs:
      typeof input.startedAtMs === "number" && Number.isFinite(input.startedAtMs)
        ? Math.max(0, input.startedAtMs)
        : undefined,
    artworkUrl: readDiscordText(input.artworkUrl, 2_048),
    externalUrl: readDiscordText(input.externalUrl, 2_048)
  };
}

function isAllowedDiscordTrackUrl(provider: DiscordPresencePayload["provider"], rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") {
      return false;
    }
    const host = url.hostname.toLowerCase();
    switch (provider) {
      case "spotify":
        return host === "open.spotify.com";
      case "soundcloud":
        return host === "soundcloud.com" || host.endsWith(".soundcloud.com");
      case "youtube":
        return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
      case "local":
        return false;
    }
  } catch {
    return false;
  }
}

function logStartup(message: string, error?: unknown) {
  const details =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
      : error
        ? String(error)
        : "";

  try {
    if ((statSync(startupLogPath, { throwIfNoEntry: false })?.size ?? 0) > STARTUP_LOG_MAX_BYTES) {
      writeFileSync(startupLogPath, "", "utf8");
    }
    appendFileSync(
      startupLogPath,
      `[${new Date().toISOString()}] ${redactLogText(message)}${details ? `\n${redactLogText(details)}` : ""}\n`,
      "utf8"
    );
  } catch {
    // Logging should never block startup.
  }
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function isTrustedMainWindowUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      return parsed.origin === new URL(devServerUrl).origin;
    }
    if (parsed.protocol !== "file:") {
      return false;
    }
    const rendererPath = path.resolve(moduleDirectory, "../dist/index.html");
    return path.resolve(fileURLToPath(parsed)) === rendererPath;
  } catch {
    return false;
  }
}

const SOUNDCLOUD_PLAYBACK_HOSTS = new Set([
  "playback.media-streaming.soundcloud.cloud",
  "license.media-streaming.soundcloud.cloud",
  "api-widget.soundcloud.com"
]);

function getTrustedSoundCloudPlaybackHost(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && SOUNDCLOUD_PLAYBACK_HOSTS.has(hostname)
      ? hostname
      : undefined;
  } catch {
    return undefined;
  }
}

async function openAllowedExternalUrl(rawUrl: string): Promise<boolean> {
  if (!isAllowedExternalUrl(rawUrl)) {
    logStartup("shell:blocked-external-url", rawUrl);
    return false;
  }

  await shell.openExternal(rawUrl);
  return true;
}

function extractSoundCloudClientId(source: string): string | undefined {
  const patterns = [/[{,]client_id:\\"(\w+)\\"/, /[{,]client_id:"(\w+)"/, /"clientId":"(\w+?)"/];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

async function discoverSoundCloudClientIdFromWeb() {
  const html = await fetch("https://soundcloud.com", {
    headers: {
      "User-Agent": desktopAuthUserAgent
    }
  }).then((response) => response.text());
  const urls = html.match(
    /(?!<script.*?src=")https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*\.js)(?=.*?>)/g
  );
  if (!urls?.length) {
    throw new Error("Could not find SoundCloud script URLs.");
  }

  for (const url of urls) {
    const script = await fetch(url, {
      headers: {
        "User-Agent": desktopAuthUserAgent
      }
    }).then((response) => response.text());
    const clientId = extractSoundCloudClientId(script);
    if (clientId) {
      return clientId;
    }
  }

  throw new Error("Could not find a SoundCloud client ID in SoundCloud web assets.");
}

async function discoverSoundCloudClientIdFromMobile() {
  const html = await fetch("https://m.soundcloud.com", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/99.0.4844.47 Mobile/15E148 Safari/604.1"
    }
  }).then((response) => response.text());
  const clientId = extractSoundCloudClientId(html);
  if (!clientId) {
    throw new Error("Could not find a SoundCloud client ID in SoundCloud mobile markup.");
  }
  return clientId;
}

function getSoundCloudPublicClientIdCachePath(): string {
  return path.join(app.getPath("userData"), "soundcloud-public-client-id.json");
}

async function readCachedSoundCloudPublicClientId(): Promise<CachedSoundCloudPublicClientIdRecord | undefined> {
  try {
    const file = await fs.readFile(getSoundCloudPublicClientIdCachePath(), "utf8");
    const parsed = JSON.parse(file) as CachedSoundCloudPublicClientIdRecord;
    if (!parsed.value || !parsed.fetchedAt) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function persistSoundCloudPublicClientId(record: CachedSoundCloudPublicClientIdRecord) {
  try {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.writeFile(getSoundCloudPublicClientIdCachePath(), JSON.stringify(record, null, 2), "utf8");
  } catch (error) {
    logStartup("soundcloud:public-client-id:cache-write-failed", error);
  }
}

async function getSoundCloudPublicClientId() {
  const configuredClientId = process.env.SOUNDCLOUD_CLIENT_ID?.trim();
  if (configuredClientId) {
    return configuredClientId;
  }

  if (
    cachedSoundCloudPublicClientId &&
    Date.now() - cachedSoundCloudPublicClientId.fetchedAt < 30 * 60_000
  ) {
    return cachedSoundCloudPublicClientId.value;
  }

  const persistedClientId = await readCachedSoundCloudPublicClientId();
  if (persistedClientId && Date.now() - persistedClientId.fetchedAt < 7 * 24 * 60 * 60_000) {
    cachedSoundCloudPublicClientId = persistedClientId;
    return persistedClientId.value;
  }

  try {
    const clientId = await discoverSoundCloudClientIdFromWeb();
    cachedSoundCloudPublicClientId = {
      value: clientId,
      fetchedAt: Date.now()
    };
    await persistSoundCloudPublicClientId(cachedSoundCloudPublicClientId);
    return clientId;
  } catch (error) {
    logStartup("soundcloud:public-client-id:web-failed", error);
  }

  const mobileClientId = await discoverSoundCloudClientIdFromMobile();
  cachedSoundCloudPublicClientId = {
    value: mobileClientId,
    fetchedAt: Date.now()
  };
  await persistSoundCloudPublicClientId(cachedSoundCloudPublicClientId);
  return mobileClientId;
}

function parseEnvFile(contents: string): Record<string, string> {
  const lines = contents.split(/\r?\n/);
  const result: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function serializeEnvFile(entries: Record<string, string>): string {
  const lines = [
    "# AMP desktop config",
    "# This file is stored under the Electron user-data directory.",
    ""
  ];

  for (const key of managedDesktopEnvKeys) {
    const value = entries[key];
    if (!value) {
      continue;
    }

    lines.push(`${key}=${value}`);
  }

  return `${lines.join("\n")}\n`;
}

async function tryLoadEnvFile(filePath: string) {
  try {
    const file = await fs.readFile(filePath, "utf8");
    const parsed = parseEnvFile(file);
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // Optional file.
  }
}

async function tryLoadBundledDesktopConfig(filePath: string) {
  try {
    const file = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(file) as Partial<Record<ManagedDesktopEnvKey, string>>;

    for (const key of managedDesktopEnvKeys) {
      const value = parsed[key];
      if (!process.env[key] && typeof value === "string" && value.trim()) {
        process.env[key] = value.trim();
      }
    }
  } catch {
    // Optional file.
  }
}

function getDesktopEnvPath(): string {
  return path.join(app.getPath("userData"), ".env");
}

function getDesktopSecretPath(): string {
  return path.join(app.getPath("userData"), "desktop-secret.bin");
}

function getProviderSessionsPath(): string {
  return path.join(app.getPath("userData"), "provider-sessions.json");
}

function getArtworkCacheDirectory(): string {
  return path.join(app.getPath("userData"), "artwork-cache");
}

function createEmptyDesktopConfig(): DesktopConfig {
  return {
    spotifyClientId: "",
    soundCloudClientId: "",
    soundCloudClientSecret: "",
    soundCloudClientSecretConfigured: false
  };
}

function parseDesktopConfig(value: unknown): DesktopConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Desktop configuration is malformed.");
  }
  const input = value as Record<string, unknown>;
  const readValue = (key: string) => {
    const candidate = input[key];
    if (typeof candidate !== "string" || candidate.length > 4_096) {
      throw new Error("Desktop configuration is malformed.");
    }
    return candidate;
  };
  return {
    spotifyClientId: readValue("spotifyClientId"),
    soundCloudClientId: readValue("soundCloudClientId"),
    soundCloudClientSecret: readValue("soundCloudClientSecret"),
    soundCloudClientSecretConfigured: input.soundCloudClientSecretConfigured === true
  };
}

async function writeEncryptedDesktopSecret(secret: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable on this device.");
  }
  const tempPath = `${getDesktopSecretPath()}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, safeStorage.encryptString(secret));
    await fs.rename(tempPath, getDesktopSecretPath());
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readEncryptedDesktopSecret(): Promise<string> {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return "";
    }
    return safeStorage.decryptString(await fs.readFile(getDesktopSecretPath())).trim();
  } catch {
    return "";
  }
}

async function writePublicDesktopConfig(config: Pick<DesktopConfig, "spotifyClientId" | "soundCloudClientId">) {
  const contents = serializeEnvFile({
    SPOTIFY_CLIENT_ID: config.spotifyClientId,
    SOUNDCLOUD_CLIENT_ID: config.soundCloudClientId,
    SOUNDCLOUD_CLIENT_SECRET: ""
  });
  const tempPath = `${getDesktopEnvPath()}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, getDesktopEnvPath());
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readDesktopConfig(): Promise<DesktopConfig> {
  const config = createEmptyDesktopConfig();

  try {
    const parsed = parseEnvFile(await fs.readFile(getDesktopEnvPath(), "utf8"));
    config.spotifyClientId = parsed.SPOTIFY_CLIENT_ID ?? "";
    config.soundCloudClientId = parsed.SOUNDCLOUD_CLIENT_ID ?? "";
    const encryptedSecret = await readEncryptedDesktopSecret();
    const legacySecret = parsed.SOUNDCLOUD_CLIENT_SECRET?.trim() ?? "";
    if (!encryptedSecret && legacySecret && safeStorage.isEncryptionAvailable()) {
      await writeEncryptedDesktopSecret(legacySecret);
      await writePublicDesktopConfig(config);
    }
    config.soundCloudClientSecretConfigured = Boolean(encryptedSecret || legacySecret);
  } catch {
    // Optional file.
  }

  if (!config.soundCloudClientSecretConfigured) {
    config.soundCloudClientSecretConfigured = Boolean(await readEncryptedDesktopSecret());
  }

  return config;
}

async function readResolvedDesktopConfig(): Promise<DesktopConfig> {
  const config = await readDesktopConfig();
  const storedSecret = await readEncryptedDesktopSecret();
  return {
    spotifyClientId: config.spotifyClientId || process.env.SPOTIFY_CLIENT_ID || "",
    soundCloudClientId: config.soundCloudClientId || process.env.SOUNDCLOUD_CLIENT_ID || "",
    soundCloudClientSecret: storedSecret || process.env.SOUNDCLOUD_CLIENT_SECRET || "",
    soundCloudClientSecretConfigured: Boolean(storedSecret || process.env.SOUNDCLOUD_CLIENT_SECRET)
  };
}

async function writeDesktopConfig(config: DesktopConfig): Promise<DesktopConfig> {
  await fs.mkdir(app.getPath("userData"), { recursive: true });

  const normalized: DesktopConfig = {
    spotifyClientId: config.spotifyClientId.trim(),
    soundCloudClientId: config.soundCloudClientId.trim(),
    soundCloudClientSecret: "",
    soundCloudClientSecretConfigured: config.soundCloudClientSecretConfigured
  };
  const incomingSecret = config.soundCloudClientSecret.trim();
  if (incomingSecret) {
    await writeEncryptedDesktopSecret(incomingSecret);
  } else if (!config.soundCloudClientSecretConfigured) {
    await fs.rm(getDesktopSecretPath(), { force: true });
  }
  normalized.soundCloudClientSecretConfigured = Boolean(
    incomingSecret || (await readEncryptedDesktopSecret()) || process.env.SOUNDCLOUD_CLIENT_SECRET
  );
  await writePublicDesktopConfig(normalized);
  await reloadManagedDesktopEnv();
  return normalized;
}

async function reloadManagedDesktopEnv() {
  const config = await readDesktopConfig();

  for (const key of managedDesktopEnvKeys) {
    const fallback = fallbackManagedEnv.get(key);
    if (fallback) {
      process.env[key] = fallback;
    } else {
      delete process.env[key];
    }
  }

  if (config.spotifyClientId) {
    process.env.SPOTIFY_CLIENT_ID = config.spotifyClientId;
  }
  if (config.soundCloudClientId) {
    process.env.SOUNDCLOUD_CLIENT_ID = config.soundCloudClientId;
  }
  const storedSecret = await readEncryptedDesktopSecret();
  if (storedSecret) {
    process.env.SOUNDCLOUD_CLIENT_SECRET = storedSecret;
  }
}

async function initializeEnv() {
  logStartup("initializeEnv:start");
  const candidateDirs = new Set<string>([
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    path.dirname(process.execPath),
    process.resourcesPath,
    app.getAppPath(),
    path.resolve(app.getAppPath(), ".."),
    path.resolve(app.getAppPath(), "../..")
  ]);

  for (const directory of candidateDirs) {
    await tryLoadEnvFile(path.join(directory, ".env"));
    await tryLoadEnvFile(path.join(directory, ".env.local"));
    await tryLoadBundledDesktopConfig(path.join(directory, "bundled-desktop-config.json"));
    await tryLoadBundledDesktopConfig(path.join(directory, "dist-electron", "bundled-desktop-config.json"));
  }

  for (const key of managedDesktopEnvKeys) {
    fallbackManagedEnv.set(key, process.env[key]);
  }

  await reloadManagedDesktopEnv();
  logStartup("initializeEnv:done");
}

function getWindowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

async function loadWindowState() {
  try {
    const file = await fs.readFile(getWindowStatePath(), "utf8");
    return JSON.parse(file) as { width: number; height: number; x?: number; y?: number };
  } catch {
    return { width: 1300, height: 860 };
  }
}

async function saveWindowState(window: BrowserWindow) {
  const bounds = window.getBounds();
  await fs.writeFile(getWindowStatePath(), JSON.stringify(bounds, null, 2), "utf8");
}

function createCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

function createCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function waitForLoopbackAuthorizationCode(
  provider: Provider,
  authUrlFactory: (redirectUri: string) => Promise<string> | string,
  preferredPort?: number
): Promise<LoopbackResult> {
  let settled = false;
  let resolveCallback!: (value: LoopbackResult) => void;
  const callbackPromise = new Promise<LoopbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const closeServer = () =>
    new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });

  const resolveOnce = (value: LoopbackResult) => {
    if (settled) {
      return;
    }

    settled = true;
    resolveCallback(value);
  };

  const server = createServer((req, res) => {
    const address = server.address() as AddressInfo;
    const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${address.port}`);
    if (requestUrl.pathname !== `/${provider}/callback`) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const result: LoopbackResult = {
      code: requestUrl.searchParams.get("code") ?? undefined,
      state: requestUrl.searchParams.get("state") ?? undefined,
      error: requestUrl.searchParams.get("error") ?? undefined,
      redirectUri: `http://127.0.0.1:${address.port}/${provider}/callback`
    };

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <!doctype html>
      <html lang="en">
        <body style="font-family: system-ui; background: #0f1111; color: #f7f2e8; display: grid; place-items: center; min-height: 100vh;">
          <div style="max-width: 480px; padding: 32px; border-radius: 24px; background: #161818; border: 1px solid #2e3131;">
            <h1 style="margin: 0 0 12px;">AMP</h1>
            <p style="margin: 0; color: #c0b8ab;">${result.error ? "The provider returned an error." : "You can close this window and return to AMP."}</p>
          </div>
        </body>
      </html>
    `);

    resolveOnce(result);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(error));
    server.listen(preferredPort ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${address.port}/${provider}/callback`;
  const cancel = () => resolveOnce({ error: AUTH_CANCELLED_MESSAGE, redirectUri });
  pendingAuthCancellers.get(provider)?.();
  pendingAuthCancellers.set(provider, cancel);

  // Install cleanup and the timeout before doing anything else that can reject. This prevents a
  // failed auth URL build or browser launch from leaving a listening server behind.
  const timeout = setTimeout(() => {
    resolveOnce({
      error: "Sign-in timed out before authorization completed (no response from the browser).",
      redirectUri
    });
  }, 90000);

  try {
    const authUrl = await authUrlFactory(redirectUri);
    // Open the provider sign-in in the user's DEFAULT BROWSER. The loopback server above
    // catches the redirect back to 127.0.0.1, so no in-app auth window is needed.
    await openAllowedExternalUrl(authUrl);
    return await callbackPromise;
  } finally {
    clearTimeout(timeout);
    if (pendingAuthCancellers.get(provider) === cancel) {
      pendingAuthCancellers.delete(provider);
    }
    await closeServer();
  }
}

function handleProtocolCallback(rawUrl: string): boolean {
  try {
    const requestUrl = new URL(rawUrl);
    const provider = requestUrl.hostname as Provider;
    if (!["spotify", "soundcloud"].includes(provider) || requestUrl.pathname !== "/callback") {
      return false;
    }

    const pending = pendingProtocolResolvers.get(provider);
    if (!pending) {
      return false;
    }

    pendingProtocolResolvers.delete(provider);
    pending.resolve({
      code: requestUrl.searchParams.get("code") ?? undefined,
      state: requestUrl.searchParams.get("state") ?? undefined,
      error: requestUrl.searchParams.get("error") ?? undefined,
      // Echo the scheme the callback actually arrived on — the token exchange's redirect_uri must
      // match the auth request's, and that could be either registered scheme.
      redirectUri: `${requestUrl.protocol}//${provider}/callback`
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }

    return true;
  } catch (error) {
    logStartup("protocol:parse-failed", error);
    return false;
  }
}

function registerCustomProtocolClient() {
  for (const scheme of protocolSchemes) {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  }
}

async function waitForCustomProtocolAuthorizationCode(
  provider: Provider,
  authUrlFactory: (redirectUri: string) => Promise<string> | string
): Promise<LoopbackResult> {
  const redirectUri = `${customProtocolScheme}://${provider}/callback`;
  const authUrl = await authUrlFactory(redirectUri);

  let settled = false;
  let resolveCallback!: (value: LoopbackResult) => void;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const callbackPromise = new Promise<LoopbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const resolveOnce = (value: LoopbackResult) => {
    if (settled) {
      return;
    }

    settled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    if (pendingProtocolResolvers.get(provider) === resolver) {
      pendingProtocolResolvers.delete(provider);
    }
    if (pendingAuthCancellers.get(provider) === cancel) {
      pendingAuthCancellers.delete(provider);
    }
    resolveCallback(value);
  };

  const resolver = { resolve: resolveOnce };
  const cancel = () => resolveOnce({ error: AUTH_CANCELLED_MESSAGE, redirectUri });

  timeout = setTimeout(() => {
    resolveOnce({
      error: "Sign-in timed out before authorization completed (no response from the browser).",
      redirectUri
    });
  }, 90000);

  pendingAuthCancellers.get(provider)?.();
  pendingProtocolResolvers.set(provider, resolver);
  // Let the renderer cancel this wait (e.g. the user closed the browser tab without finishing).
  pendingAuthCancellers.set(provider, cancel);

  try {
    // Open the provider sign-in in the user's DEFAULT BROWSER. The musync:// redirect
    // is delivered back to the app by the OS protocol handler (open-url / second-instance).
    await openAllowedExternalUrl(authUrl);
  } catch (error) {
    resolveOnce({ error: AUTH_CANCELLED_MESSAGE, redirectUri });
    throw error;
  }

  return callbackPromise;
}

function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptToken(value: string | undefined): string | undefined {
  if (!value || !isSecureStorageAvailable()) {
    return undefined;
  }

  return safeStorage.encryptString(value).toString("base64");
}

function decryptToken(value: string | undefined): string | undefined {
  if (!value || !isSecureStorageAvailable()) {
    return undefined;
  }

  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch (error) {
    logStartup("session:decrypt-failed", error);
    return undefined;
  }
}

function soundCloudLocalConnectError<T = unknown>(
  code: SoundCloudLocalConnectErrorCode,
  message: string
): GatewayResponse<T> {
  return {
    ok: false,
    error: message,
    data: { code } as T,
    source: "internal"
  };
}

interface ChromiumBrowserCandidate {
  browserKey: string;
  browserName: string;
  userDataDirectory: string;
  executableCandidates: string[];
  /** macOS Keychain "Safe Storage" entry that holds this browser's cookie-encryption key. */
  macKeychain?: { service: string; account: string };
}

/** macOS Keychain "Safe Storage" coordinates per Chromium browser. */
function macKeychainForBrowserKey(browserKey: string): { service: string; account: string } | undefined {
  switch (browserKey) {
    case "chrome":
      return { service: "Chrome Safe Storage", account: "Chrome" };
    case "edge":
      return { service: "Microsoft Edge Safe Storage", account: "Microsoft Edge" };
    case "brave":
      return { service: "Brave Safe Storage", account: "Brave" };
    default:
      return undefined;
  }
}

function getChromiumBrowserCandidates(): ChromiumBrowserCandidate[] {
  if (process.platform === "darwin") {
    const appSupport = path.join(os.homedir(), "Library", "Application Support");
    const appDirs = ["/Applications", path.join(os.homedir(), "Applications")];
    const apps = (bundleName: string) => appDirs.map((dir) => path.join(dir, bundleName));
    return [
      {
        browserKey: "chrome",
        browserName: "Chrome",
        userDataDirectory: path.join(appSupport, "Google", "Chrome"),
        executableCandidates: apps("Google Chrome.app"),
        macKeychain: macKeychainForBrowserKey("chrome")
      },
      {
        browserKey: "edge",
        browserName: "Edge",
        userDataDirectory: path.join(appSupport, "Microsoft Edge"),
        executableCandidates: apps("Microsoft Edge.app"),
        macKeychain: macKeychainForBrowserKey("edge")
      },
      {
        browserKey: "brave",
        browserName: "Brave",
        userDataDirectory: path.join(appSupport, "BraveSoftware", "Brave-Browser"),
        executableCandidates: apps("Brave Browser.app"),
        macKeychain: macKeychainForBrowserKey("brave")
      }
    ];
  }

  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  return [
    {
      browserKey: "chrome",
      browserName: "Chrome",
      userDataDirectory: path.join(localAppData, "Google", "Chrome", "User Data"),
      executableCandidates: [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
      ]
    },
    {
      browserKey: "edge",
      browserName: "Edge",
      userDataDirectory: path.join(localAppData, "Microsoft", "Edge", "User Data"),
      executableCandidates: [
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
      ]
    },
    {
      browserKey: "brave",
      browserName: "Brave",
      userDataDirectory: path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data"),
      executableCandidates: [
        path.join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
      ]
    }
  ];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Absolute path to Safari's sandboxed `Cookies.binarycookies` file (macOS). */
function getSafariCookieFilePath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Containers",
    "com.apple.Safari",
    "Data",
    "Library",
    "Cookies",
    "Cookies.binarycookies"
  );
}

/**
 * Resolves a profile's Cookies SQLite DB. Newer Chromium keeps it under `Network/Cookies`; older
 * profiles (and some macOS installs, e.g. Brave) keep it directly at `Cookies`. Returns the first
 * that exists, or undefined.
 */
async function resolveCookieDbPath(
  userDataDirectory: string,
  profileDirectory: string
): Promise<string | undefined> {
  return firstExistingPath([
    path.join(userDataDirectory, profileDirectory, "Network", "Cookies"),
    path.join(userDataDirectory, profileDirectory, "Cookies")
  ]);
}

function encodeSoundCloudProfileId(browserKey: string, profileDirectory: string): string {
  return `${browserKey}:${profileDirectory}`;
}

async function readChromiumProfileLabels(userDataDirectory: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(userDataDirectory, "Local State"), "utf8");
    const parsed = JSON.parse(raw) as {
      profile?: { info_cache?: Record<string, { name?: string; shortcut_name?: string }> };
    };
    const labels: Record<string, string> = {};
    for (const [directory, details] of Object.entries(parsed.profile?.info_cache ?? {})) {
      labels[directory] = details.name?.trim() || details.shortcut_name?.trim() || directory;
    }
    return labels;
  } catch {
    return {};
  }
}

/** Candidate Firefox executable locations per platform (used for "is it installed" + launching). */
function getFirefoxExecutableCandidates(): string[] {
  if (process.platform === "darwin") {
    return ["/Applications/Firefox.app", path.join(os.homedir(), "Applications", "Firefox.app")];
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return [
      path.join(programFiles, "Mozilla Firefox", "firefox.exe"),
      path.join(programFilesX86, "Mozilla Firefox", "firefox.exe"),
      path.join(localAppData, "Mozilla Firefox", "firefox.exe")
    ];
  }
  return ["/usr/bin/firefox", "/usr/local/bin/firefox", "/snap/bin/firefox"];
}

/**
 * Lists Firefox profiles as SoundCloud connect candidates. Firefox isn't Chromium: cookies live
 * unencrypted in each profile's `cookies.sqlite`, so `userDataDirectory` here is the absolute
 * profile directory that holds that file.
 */
async function listFirefoxBrowserProfiles(): Promise<SoundCloudBrowserProfile[]> {
  const executablePath = await firstExistingPath(getFirefoxExecutableCandidates());
  const profiles: SoundCloudBrowserProfile[] = [];
  for (const profile of await listFirefoxProfiles()) {
    const hasCookies = await pathExists(path.join(profile.directory, "cookies.sqlite"));
    profiles.push({
      // Key the id off the unique profile folder, not the (possibly duplicated) display name.
      id: encodeSoundCloudProfileId("firefox", path.basename(profile.directory)),
      browserName: "Firefox",
      profileName: profile.name,
      browserKey: "firefox",
      profileDirectory: path.basename(profile.directory),
      userDataDirectory: profile.directory,
      executablePath,
      status: executablePath && hasCookies ? "available" : executablePath ? "profile-locked" : "unsupported",
      statusLabel: executablePath
        ? hasCookies
          ? "Ready"
          : "No saved session in this profile"
        : "Browser app not found"
    });
  }
  return profiles;
}

async function listSoundCloudBrowserProfiles(): Promise<SoundCloudBrowserProfile[]> {
  const profiles: SoundCloudBrowserProfile[] = [];

  for (const browser of getChromiumBrowserCandidates()) {
    if (!(await pathExists(browser.userDataDirectory))) {
      continue;
    }

    const executablePath = await firstExistingPath(browser.executableCandidates);
    const labels = await readChromiumProfileLabels(browser.userDataDirectory);
    const entries = await fs.readdir(browser.userDataDirectory, { withFileTypes: true }).catch(() => []);
    const profileDirectories = entries
      .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/i.test(entry.name)))
      .map((entry) => entry.name);

    for (const profileDirectory of profileDirectories) {
      const cookiePath = await resolveCookieDbPath(browser.userDataDirectory, profileDirectory);
      const hasCookies = Boolean(cookiePath);
      profiles.push({
        id: encodeSoundCloudProfileId(browser.browserKey, profileDirectory),
        browserName: browser.browserName,
        profileName: labels[profileDirectory] ?? profileDirectory,
        browserKey: browser.browserKey,
        profileDirectory,
        userDataDirectory: browser.userDataDirectory,
        executablePath,
        status: executablePath && hasCookies ? "available" : executablePath ? "profile-locked" : "unsupported",
        statusLabel: executablePath
          ? hasCookies
            ? "Ready"
            : process.platform === "darwin"
              ? "No saved session in this profile"
              : "Close browser and try again"
          : "Browser app not found"
      });
    }
  }

  // Firefox (all platforms) — not Chromium: cookies live unencrypted in each profile's
  // cookies.sqlite, so this path works on Windows even though Chrome/Edge there use App-Bound
  // Encryption.
  profiles.push(...(await listFirefoxBrowserProfiles()));

  // Safari (macOS only) — not Chromium: cookies live in a binarycookies file in Safari's container.
  if (process.platform === "darwin") {
    const safariCookieFile = getSafariCookieFilePath();
    if (await pathExists(safariCookieFile)) {
      const safariApp = "/Applications/Safari.app";
      profiles.push({
        id: encodeSoundCloudProfileId("safari", "Default"),
        browserName: "Safari",
        profileName: "Default",
        browserKey: "safari",
        profileDirectory: "Default",
        userDataDirectory: path.dirname(safariCookieFile),
        executablePath: (await pathExists(safariApp)) ? safariApp : safariCookieFile,
        status: "available",
        statusLabel: "Ready · needs Full Disk Access"
      });
    }
  }

  return profiles;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSoundCloudOAuthTokenFromCookies(
  cookies: Array<{ name: string; value: string; domain: string }>
): string | undefined {
  const raw = cookies
    .filter(
      (cookie) => cookie.name === "oauth_token" && /(^|\.)soundcloud\.com$/i.test(cookie.domain)
    )
    .map((cookie) => cookie.value)
    .find((value) => value && value.length > 8);
  return raw ? decodeURIComponent(raw) : undefined;
}

function getLocalConnectMessage(code: SoundCloudLocalConnectErrorCode): string {
  switch (code) {
    case "no-session-found":
      return "No SoundCloud sign-in was found in the selected browser profile. Sign into SoundCloud in that browser, then try again.";
    case "session-expired":
      return "Your SoundCloud session appears to be expired. Refresh your SoundCloud login in the browser, then reconnect.";
    case "access-blocked":
      return "SoundCloud blocked this connection attempt. Try again later or use Public Profile Import.";
    case "profile-locked":
      return "AMP could not access this browser profile. Close the browser completely, then try again.";
    case "browser-running":
      return "Your browser is still running. Fully quit it (including any background or system-tray instance) to finish connecting.";
    case "app-bound-encryption":
      return "AMP couldn't read this Chrome/Edge profile's SoundCloud sign-in on Windows. Make sure the browser is fully closed and try again, or connect with Firefox or Brave instead.";
    case "full-disk-access":
      return "AMP needs Full Disk Access to read Safari's cookies. Grant it in System Settings → Privacy & Security → Full Disk Access, enable AMP (or Electron in dev), then try again.";
    case "keychain-denied":
      return "macOS blocked AMP from reading the browser's encryption key from your Keychain. When the Keychain prompt appears, choose Always Allow, then reconnect.";
    case "unsupported-browser":
      return "This browser profile is not currently supported. Try Chrome, Edge, Firefox, Brave, or another supported browser.";
    case "validation-failed":
      return "AMP could not validate that SoundCloud session locally.";
  }
}

/** macOS process name for a browser, derived from its `.app` bundle path (e.g. "Google Chrome"). */
function macProcessName(executablePath: string): string {
  return path.basename(executablePath).replace(/\.app$/i, "");
}

async function isTargetBrowserRunning(executablePath: string): Promise<boolean> {
  if (process.platform === "darwin") {
    const processName = macProcessName(executablePath);
    if (!processName) {
      return false;
    }
    return new Promise((resolve) => {
      // `pgrep -x` exits 0 when an exactly-named process exists, 1 otherwise.
      execFile("pgrep", ["-x", processName], (error) => resolve(!error));
    });
  }

  const imageName = path.basename(executablePath);
  if (!imageName) {
    return false;
  }
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", `IMAGENAME eq ${imageName}`, "/NH", "/FO", "CSV"],
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(stdout.toLowerCase().includes(imageName.toLowerCase()));
      }
    );
  });
}

const SOUNDCLOUD_LOCAL_PARTITION = "persist:soundcloud";

/** Shared SoundCloud OAuth token used to add the oauth_token cookie to license requests. */
let soundCloudOAuthToken: string | undefined;

async function setSoundCloudOAuthCookie(token: string): Promise<void> {
  const cookie = {
    url: "https://soundcloud.com",
    name: "oauth_token",
    value: token,
    domain: ".soundcloud.com",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "no_restriction" as const
  };
  await session.defaultSession.cookies.set(cookie).catch(() => undefined);
  const ses = session.fromPartition(SOUNDCLOUD_LOCAL_PARTITION);
  const oneYearFromNow = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  for (const url of ["https://soundcloud.com", "https://api-v2.soundcloud.com"]) {
    await ses.cookies.set({ ...cookie, url, httpOnly: true, expirationDate: oneYearFromNow }).catch(() => undefined);
  }
}

async function injectSoundCloudLocalSession(token: string): Promise<void> {
  soundCloudOAuthToken = token;
  await setSoundCloudOAuthCookie(token);
}

async function closeBrowserByExecutable(executablePath: string): Promise<boolean> {
  const runCommand = (file: string, args: string[]) =>
    new Promise<void>((resolve) => {
      execFile(file, args, { windowsHide: true }, () => resolve());
    });

  if (process.platform === "darwin") {
    const processName = macProcessName(executablePath);
    if (!processName) {
      return false;
    }
    // Graceful AppleScript quit first (lets the browser save its tabs), then force any lingering
    // process if needed.
    await runCommand("osascript", ["-e", `tell application "${processName}" to quit`]);
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!(await isTargetBrowserRunning(executablePath))) {
        return true;
      }
      await wait(400);
    }
    await runCommand("pkill", ["-x", processName]);
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!(await isTargetBrowserRunning(executablePath))) {
        return true;
      }
      await wait(400);
    }
    return !(await isTargetBrowserRunning(executablePath));
  }

  const imageName = path.basename(executablePath);
  if (!imageName) {
    return false;
  }
  // Graceful close first (lets the browser save its tabs), then force any lingering
  // background/tray process so the cookie store unlocks.
  await runCommand("taskkill", ["/IM", imageName]);
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!(await isTargetBrowserRunning(executablePath))) {
      return true;
    }
    await wait(400);
  }
  await runCommand("taskkill", ["/F", "/IM", imageName]);
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!(await isTargetBrowserRunning(executablePath))) {
      return true;
    }
    await wait(400);
  }
  return !(await isTargetBrowserRunning(executablePath));
}

const SOUNDCLOUD_SIGNIN_URL = "https://soundcloud.com/signin";

/**
 * Opens a profile's real browser to a URL (e.g. the SoundCloud login). Login happens in the user's
 * own browser — never an automated/Electron window — so SoundCloud sees a normal session. The
 * caller then polls the existing cookie-read connect until the `oauth_token` appears.
 */
async function openProfileBrowserToUrl(profile: SoundCloudBrowserProfile, url: string): Promise<void> {
  if (process.platform === "darwin") {
    const appPath =
      profile.executablePath && profile.executablePath.endsWith(".app")
        ? profile.executablePath
        : profile.browserKey === "safari"
          ? "/Applications/Safari.app"
          : undefined;
    const args = appPath ? ["-a", appPath, url] : [url];
    await new Promise<void>((resolve) => execFile("open", args, () => resolve()));
    return;
  }

  // Windows / Linux: launch the executable directly so we can target the right profile.
  if (profile.executablePath && profile.browserKey !== "safari") {
    const args: string[] = [];
    // Chromium uses --profile-directory; Firefox doesn't understand it (and opens in its current
    // profile by default), so only pass it for Chromium browsers.
    if (profile.browserKey !== "firefox" && profile.profileDirectory) {
      args.push(`--profile-directory=${profile.profileDirectory}`);
    }
    args.push(url);
    try {
      const child = spawn(profile.executablePath, args, { detached: true, stdio: "ignore" });
      child.unref();
      return;
    } catch {
      // fall through to the OS default handler
    }
  }
  await shell.openExternal(url);
}

/**
 * True when a profile is a Windows Chromium browser (Chrome/Edge/Brave) we can fall back to reading
 * via a headless DevTools relaunch — the route used when App-Bound Encryption blocks the disk read.
 */
function canUseChromiumRemoteFallback(profile: SoundCloudBrowserProfile): boolean {
  return (
    process.platform === "win32" &&
    profile.browserKey !== "safari" &&
    profile.browserKey !== "firefox" &&
    Boolean(profile.executablePath)
  );
}

async function connectSoundCloudBrowserProfile(
  request: SoundCloudLocalConnectRequest
): Promise<GatewayResponse<SoundCloudLocalConnectResult>> {
  const profiles = await listSoundCloudBrowserProfiles();
  const selectedProfile = profiles.find((profile) => profile.id === request.profileId);
  if (!selectedProfile) {
    return soundCloudLocalConnectError("unsupported-browser", getLocalConnectMessage("unsupported-browser"));
  }
  if (selectedProfile.status !== "available" || !selectedProfile.executablePath) {
    return soundCloudLocalConnectError(
      selectedProfile.status === "profile-locked" ? "profile-locked" : "unsupported-browser",
      getLocalConnectMessage(selectedProfile.status === "profile-locked" ? "profile-locked" : "unsupported-browser")
    );
  }

  // On Windows the on-disk Cookies DB is OS-locked while the browser runs. Browsers we can relaunch
  // headless over CDP (Chrome/Edge/Brave) read their session from a profile *copy* in a separate
  // user-data-dir, so they work even while the browser is open — only hard-block the read-only paths
  // (Firefox) that genuinely need the DB unlocked. Chromium browsers fall through; if their reads
  // still come up empty because the browser is running, we surface the "close it" option at the end.
  const browserRunning =
    process.platform !== "darwin" && (await isTargetBrowserRunning(selectedProfile.executablePath));
  if (browserRunning && !canUseChromiumRemoteFallback(selectedProfile)) {
    return soundCloudLocalConnectError(
      "browser-running",
      `${selectedProfile.browserName} is still running. Fully quit ${selectedProfile.browserName} (including any background or system-tray instance) to finish — or use the "Close ${selectedProfile.browserName} for me" option.`
    );
  }
  logStartup(
    `soundcloud:local-connect:start browser=${selectedProfile.browserKey} running=${browserRunning} canRemote=${canUseChromiumRemoteFallback(selectedProfile)}`
  );

  let token: string | undefined;
  let appBoundBlocked = false;
  let cookieCount = 0;
  // All soundcloud.com cookies from whichever read path succeeds — we pull both the oauth_token and
  // the datadome anti-bot cookie out of this so authenticated writes (likes) get past DataDome.
  let capturedCookies: Array<{ name: string; value: string; domain: string }> = [];
  try {
    if (selectedProfile.browserKey === "safari") {
      const safariCookies = await readSafariCookies(getSafariCookieFilePath(), "soundcloud.com");
      cookieCount = safariCookies.length;
      capturedCookies = safariCookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.hostKey
      }));
      token = getSoundCloudOAuthTokenFromCookies(capturedCookies);
    } else if (selectedProfile.browserKey === "firefox") {
      // Firefox stores cookies unencrypted; userDataDirectory is the profile dir holding the DB.
      const cookieDbPath = path.join(selectedProfile.userDataDirectory, "cookies.sqlite");
      if (!(await pathExists(cookieDbPath))) {
        return soundCloudLocalConnectError("no-session-found", getLocalConnectMessage("no-session-found"));
      }
      const firefoxCookies = await readFirefoxCookies(cookieDbPath, "%soundcloud.com");
      cookieCount = firefoxCookies.length;
      capturedCookies = firefoxCookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.hostKey
      }));
      token = getSoundCloudOAuthTokenFromCookies(capturedCookies);
    } else {
      const cookieDbPath = await resolveCookieDbPath(
        selectedProfile.userDataDirectory,
        selectedProfile.profileDirectory
      );
      if (!cookieDbPath) {
        return soundCloudLocalConnectError("no-session-found", getLocalConnectMessage("no-session-found"));
      }
      const localStatePath = path.join(selectedProfile.userDataDirectory, "Local State");
      const cookieResult = await readDecryptedCookies({
        cookieDbPath,
        localStatePath,
        hostLike: "%soundcloud.com",
        macKeychain: macKeychainForBrowserKey(selectedProfile.browserKey)
      });
      cookieCount = cookieResult.cookies.length;
      appBoundBlocked = cookieResult.appBoundBlocked;
      capturedCookies = cookieResult.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.hostKey
      }));
      token = getSoundCloudOAuthTokenFromCookies(capturedCookies);
    }
    logStartup(
      `soundcloud:local-connect:read browser=${selectedProfile.browserKey} cookies=${cookieCount} hasToken=${Boolean(token)} appBound=${appBoundBlocked}`
    );
  } catch (error) {
    logStartup("soundcloud:local-connect:cookie-read-failed", error);
    if (error instanceof FullDiskAccessError) {
      return soundCloudLocalConnectError("full-disk-access", getLocalConnectMessage("full-disk-access"));
    }
    if (error instanceof KeychainAccessError) {
      return soundCloudLocalConnectError("keychain-denied", getLocalConnectMessage("keychain-denied"));
    }
    // On Windows, Chrome/Edge disk reads can fail because of App-Bound Encryption. The headless
    // relaunch below is the real path for those browsers, so only abort here when no fallback exists.
    if (!canUseChromiumRemoteFallback(selectedProfile)) {
      return soundCloudLocalConnectError("validation-failed", getLocalConnectMessage("validation-failed"));
    }
  }

  // Windows: Chrome/Edge seal cookies with App-Bound Encryption (v20) that can't be read from disk.
  // Briefly relaunch the real browser headless against a copy of the profile and read the live
  // session over the DevTools protocol — the browser decrypts its own cookies. Nothing is injected
  // into the user's browser; we only spawn it with standard flags.
  if (!token && canUseChromiumRemoteFallback(selectedProfile) && selectedProfile.executablePath) {
    const executablePath = selectedProfile.executablePath;
    try {
      const remoteCookies = await readChromiumCookiesViaRemoteDebugging({
        executablePath,
        userDataDirectory: selectedProfile.userDataDirectory,
        profileDirectory: selectedProfile.profileDirectory
      });
      cookieCount = remoteCookies.length;
      capturedCookies = remoteCookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain
      }));
      token = getSoundCloudOAuthTokenFromCookies(capturedCookies);
      // A successful read means App-Bound Encryption was bypassed; if there's still no token the
      // profile simply isn't signed into SoundCloud (a no-session case, not an ABE failure).
      if (remoteCookies.length > 0) {
        appBoundBlocked = false;
      }
      logStartup(
        `soundcloud:local-connect:remote browser=${selectedProfile.browserKey} cookies=${cookieCount} hasToken=${Boolean(token)}`
      );
    } catch (error) {
      logStartup("soundcloud:local-connect:remote-failed", error);
    }
  }

  // A running Chromium browser can leave the copied Cookies DB stale/locked enough that the CDP
  // relaunch reads nothing. Before declaring "no session", give the user the clean close-first path.
  if (!token && browserRunning) {
    return soundCloudLocalConnectError(
      "browser-running",
      `Couldn't read ${selectedProfile.browserName}'s SoundCloud sign-in while it's running. Use the "Close ${selectedProfile.browserName} for me" option (or fully quit it), then try again.`
    );
  }

  if (!token && appBoundBlocked) {
    return soundCloudLocalConnectError("app-bound-encryption", getLocalConnectMessage("app-bound-encryption"));
  }

  if (!token) {
    return soundCloudLocalConnectError("no-session-found", getLocalConnectMessage("no-session-found"));
  }

  if (!providerGateway) {
    return { ok: false, error: "Provider gateway is not ready.", source: "fallback" };
  }

  const profileResult = await providerGateway.request({
    provider: "soundcloud",
    operation: "resolveAuthenticatedProfile",
    variables: { oauthToken: token }
  });
  if (!profileResult.ok || !profileResult.data) {
    const error = profileResult.error ?? getLocalConnectMessage("validation-failed");
    const code =
      /expired|401|403/i.test(error) ? "session-expired" : /blocked|429/i.test(error) ? "access-blocked" : "validation-failed";
    return soundCloudLocalConnectError(code, getLocalConnectMessage(code));
  }

  // Inject the token into our own persistent Electron session so the app holds an
  // independent, signed-in SoundCloud session — no dependency on the external browser.
  await injectSoundCloudLocalSession(token).catch((error) =>
    logStartup("soundcloud:local-connect:session-inject-failed", error)
  );

  const profile = profileResult.data as SoundCloudLocalConnectResult["profile"];
  const lastSyncedAt = new Date().toISOString();
  const payload: ProviderConnectionPayload = {
    provider: "soundcloud",
    accessToken: token,
    displayName: profile.displayName,
    metadata: {
      source: "local-connect",
      connectionMode: "local-connect",
      profileId: selectedProfile.id,
      browserName: selectedProfile.browserName,
      profileName: selectedProfile.profileName,
      likesCount: String(profile.likes.length),
      playlistsCount: String(profile.playlists.length),
      lastSyncedAt
    }
  };
  const persisted = await persistLocalProviderSession(payload);
  const connection = toProviderOAuthResult(payload, persisted.connectedAt, persisted.sessionSource, persisted.storageMode);

  return {
    ok: true,
    source: "internal",
    data: {
      connection,
      profile,
      likesCount: profile.likes.length,
      playlistsCount: profile.playlists.length,
      lastSyncedAt
    }
  };
}

// ---- In-app SoundCloud sign-in ----
// The universal connect path: instead of reading another browser's saved cookies (which Chrome/Edge
// now lock behind App-Bound Encryption on Windows), the user signs into SoundCloud in a window AMP
// OWNS, on our own persistent partition. We read the oauth_token from that partition — no cookie
// theft, no encryption to defeat, works on every OS and browser. The signed-in partition is the same
// one the like window uses, so likes inherit a fully cleared (cookie + DataDome) session for free.
let soundCloudSignInWindow: BrowserWindow | undefined;

// A normal desktop Chrome UA so SoundCloud serves its standard site (Electron's default UA can trip
// "unsupported browser" interstitials).
const SOUNDCLOUD_SIGNIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

async function readSoundCloudPartitionToken(): Promise<string | undefined> {
  try {
    const ses = session.fromPartition(SOUNDCLOUD_LOCAL_PARTITION);
    const cookies = await ses.cookies.get({ name: "oauth_token" });
    const raw = cookies
      .filter((cookie) => /(^|\.)soundcloud\.com$/i.test(cookie.domain ?? ""))
      .map((cookie) => cookie.value)
      .find((value) => value && value.length > 8);
    return raw ? decodeURIComponent(raw) : undefined;
  } catch {
    return undefined;
  }
}

// The persistent AMP-owned browser profile used for the system-browser SoundCloud sign-in. Lives
// under userData so it survives restarts (silent re-syncs, no re-login) and is wiped on disconnect.
function soundCloudLoginProfileDir(): string {
  return path.join(app.getPath("userData"), "soundcloud-login");
}

/** First Chrome/Edge/Brave we can drive (Firefox/Safari speak no CDP, so they use Local Connect). */
function pickChromiumForSignIn(
  profiles: SoundCloudBrowserProfile[]
): { executablePath: string; browserName: string } | undefined {
  const chromium = profiles.find(
    (profile) =>
      profile.executablePath && profile.browserKey !== "firefox" && profile.browserKey !== "safari"
  );
  return chromium?.executablePath
    ? { executablePath: chromium.executablePath, browserName: chromium.browserName }
    : undefined;
}

/**
 * Universal, DataDome-safe SoundCloud sign-in: log in inside the user's REAL browser (not the
 * blocked Electron window), reading the token from the live session over CDP. Tries a silent
 * re-read of the persistent AMP profile first (no window if already signed in), then falls back to
 * an interactive login. Works on Chrome/Edge/Brave — App-Bound Encryption never applies because we
 * read the running browser, not the disk.
 */
async function signInSoundCloudViaSystemBrowser(): Promise<GatewayResponse<SoundCloudLocalConnectResult>> {
  if (!providerGateway) {
    return { ok: false, error: "Provider gateway is not ready.", source: "fallback" as const };
  }
  const browser = pickChromiumForSignIn(await listSoundCloudBrowserProfiles());
  if (!browser) {
    return {
      ok: false,
      error:
        "No Chrome, Edge, or Brave was found to sign in with. Install one of those, or use Local Connect with Firefox.",
      source: "internal" as const
    };
  }

  const loginProfileDir = soundCloudLoginProfileDir();
  // If we've signed in here before, try reading the refreshed token headlessly first — no window.
  let result = (await pathExists(loginProfileDir))
    ? await signInToSoundCloudViaBrowser({ executablePath: browser.executablePath, loginProfileDir, silent: true })
    : { ok: false, cookies: [], stage: "spawn" as const };
  let token = result.ok ? result.token : undefined;

  if (!token) {
    // Let the silent headless instance fully exit so it releases the profile's SingletonLock before
    // the interactive launch reuses the same --user-data-dir (otherwise Chrome refuses to start).
    if (result.stage !== "spawn") {
      await wait(1200);
    }
    // Interactive: open the real browser at the login page so the user signs in normally.
    result = await signInToSoundCloudViaBrowser({
      executablePath: browser.executablePath,
      loginProfileDir,
      silent: false
    });
    token = result.ok ? result.token : undefined;
  }

  if (!token) {
    const message =
      result.stage === "cancelled"
        ? "SoundCloud sign-in was cancelled."
        : result.stage === "timeout"
          ? "SoundCloud sign-in timed out. Try again."
          : result.message ?? "Could not complete SoundCloud sign-in.";
    return { ok: false, error: message, source: "internal" as const };
  }

  const profileResult = await providerGateway.request({
    provider: "soundcloud",
    operation: "resolveAuthenticatedProfile",
    variables: { oauthToken: token }
  });
  if (!profileResult.ok || !profileResult.data) {
    return {
      ok: false,
      error: profileResult.error ?? "Couldn't validate that SoundCloud sign-in.",
      source: "internal" as const
    };
  }

  await injectSoundCloudLocalSession(token).catch((error) =>
    logStartup("soundcloud:system-browser-signin:session-inject-failed", error)
  );
  const profile = profileResult.data as SoundCloudLocalConnectResult["profile"];
  const lastSyncedAt = new Date().toISOString();
  const payload: ProviderConnectionPayload = {
    provider: "soundcloud",
    accessToken: token,
    displayName: profile.displayName,
    metadata: {
      source: "local-connect",
      connectionMode: "system-browser",
      browserName: browser.browserName,
      likesCount: String(profile.likes.length),
      playlistsCount: String(profile.playlists.length),
      lastSyncedAt
    }
  };
  const persisted = await persistLocalProviderSession(payload);
  const connection = toProviderOAuthResult(
    payload,
    persisted.connectedAt,
    persisted.sessionSource,
    persisted.storageMode
  );
  return {
    ok: true,
    source: "internal",
    data: {
      connection,
      profile,
      likesCount: profile.likes.length,
      playlistsCount: profile.playlists.length,
      lastSyncedAt
    }
  };
}

async function signInSoundCloudInApp(): Promise<GatewayResponse<SoundCloudLocalConnectResult>> {
  if (!providerGateway) {
    return { ok: false, error: "Provider gateway is not ready.", source: "fallback" as const };
  }
  if (soundCloudSignInWindow && !soundCloudSignInWindow.isDestroyed()) {
    soundCloudSignInWindow.focus();
    return { ok: false, error: "A SoundCloud sign-in window is already open.", source: "internal" as const };
  }

  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const win = new BrowserWindow({
    width: 460,
    height: 720,
    parent,
    show: false,
    title: "Sign in to SoundCloud",
    autoHideMenuBar: true,
    backgroundColor: "#0c0c0d",
    webPreferences: {
      partition: SOUNDCLOUD_LOCAL_PARTITION,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  soundCloudSignInWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guardSoundCloudSignInNavigation = (event: { preventDefault(): void }, url: string) => {
    if (!isTrustedSoundCloudPage(url)) {
      event.preventDefault();
      logStartup("soundcloud:signin:blocked-navigation");
    }
  };
  win.webContents.on("will-navigate", guardSoundCloudSignInNavigation);
  win.webContents.on("will-redirect", guardSoundCloudSignInNavigation);

  return new Promise<GatewayResponse<SoundCloudLocalConnectResult>>((resolve) => {
    let settled = false;
    // Serialize tryComplete so an overlapping poll + did-navigate can't both run the persist.
    let completing = false;
    let poller: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (poller) clearInterval(poller);
      if (timeout) clearTimeout(timeout);
      soundCloudSignInWindow = undefined;
      if (!win.isDestroyed()) {
        win.removeAllListeners("closed");
        win.close();
      }
    };

    const finish = (result: GatewayResponse<SoundCloudLocalConnectResult>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // After each navigation (and on a steady poll), check whether a real signed-in token now exists
    // in our partition and resolves to a profile. Only a genuine sign-in resolves; an anonymous
    // guest token won't satisfy resolveAuthenticatedProfile, so we keep waiting.
    const tryComplete = async () => {
      if (settled || completing) return;
      completing = true;
      try {
        await completeIfSignedIn();
      } finally {
        completing = false;
      }
    };

    const completeIfSignedIn = async () => {
      const token = await readSoundCloudPartitionToken();
      if (!token) return;
      const profileResult = await providerGateway!.request({
        provider: "soundcloud",
        operation: "resolveAuthenticatedProfile",
        variables: { oauthToken: token }
      });
      if (settled || !profileResult.ok || !profileResult.data) return;

      await injectSoundCloudLocalSession(token).catch((error) =>
        logStartup("soundcloud:in-app-signin:session-inject-failed", error)
      );
      const profile = profileResult.data as SoundCloudLocalConnectResult["profile"];
      const lastSyncedAt = new Date().toISOString();
      const payload: ProviderConnectionPayload = {
        provider: "soundcloud",
        accessToken: token,
        displayName: profile.displayName,
        metadata: {
          source: "local-connect",
          connectionMode: "in-app-signin",
          likesCount: String(profile.likes.length),
          playlistsCount: String(profile.playlists.length),
          lastSyncedAt
        }
      };
      const persisted = await persistLocalProviderSession(payload);
      const connection = toProviderOAuthResult(
        payload,
        persisted.connectedAt,
        persisted.sessionSource,
        persisted.storageMode
      );
      finish({
        ok: true,
        source: "internal",
        data: {
          connection,
          profile,
          likesCount: profile.likes.length,
          playlistsCount: profile.playlists.length,
          lastSyncedAt
        }
      });
    };

    win.on("closed", () => {
      // User dismissed the window before signing in.
      finish({ ok: false, error: "Sign-in was cancelled.", source: "internal" as const });
    });
    win.webContents.on("did-navigate", () => void tryComplete());
    win.webContents.on("did-navigate-in-page", () => void tryComplete());
    // The token can land without a navigation (XHR login), so also poll.
    poller = setInterval(() => void tryComplete(), 1500);
    // Don't leave the window hanging forever if the user wanders off.
    timeout = setTimeout(
      () => finish({ ok: false, error: "Sign-in timed out. Try again.", source: "internal" as const }),
      5 * 60_000
    );

    win.webContents.setUserAgent(SOUNDCLOUD_SIGNIN_USER_AGENT);
    win
      .loadURL(SOUNDCLOUD_SIGNIN_URL, { userAgent: SOUNDCLOUD_SIGNIN_USER_AGENT })
      .then(() => {
        if (!win.isDestroyed()) win.show();
      })
      .catch(() =>
        finish({ ok: false, error: "Could not open the SoundCloud sign-in page.", source: "internal" as const })
      );
  });
}

// ---- SoundCloud track download (free / non-DRM only) ----
// Reuses the playback stream resolver: for a free track it yields a directly-fetchable progressive
// MP3 (or a non-DRM HLS playlist we concatenate). Go+/DRM tracks resolve WITH a `drm` block and are
// refused — we never touch Widevine-encrypted media for downloads. Files land in <Music>/AMP.

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

function sanitizeDownloadName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return (cleaned || "track").slice(0, 180);
}

async function uniqueDownloadPath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName) || ".audio";
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, `${stem}${ext}`);
  for (let i = 2; i <= 999; i += 1) {
    try {
      await fs.access(candidate);
    } catch {
      return candidate; // free name
    }
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

const DOWNLOAD_MAX_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const HLS_PLAYLIST_MAX_BYTES = 1024 * 1024;

function detectAudioExtension(data: Buffer): string | undefined {
  if (data.subarray(0, 3).toString("ascii") === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) {
    // ADTS AAC uses the 0xFFF sync word too. Layer bits are zero for ADTS and non-zero for MP3.
    return (data[1] & 0x06) === 0 ? ".aac" : ".mp3";
  }
  if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") {
    return ".m4a";
  }
  if (data[0] === 0x47 && (data.length < 189 || data[188] === 0x47)) {
    return ".ts";
  }
  if (data.subarray(0, 4).toString("ascii") === "OggS") {
    return ".ogg";
  }
  if (data.subarray(0, 4).toString("ascii") === "fLaC") {
    return ".flac";
  }
  if (
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return ".wav";
  }
  return undefined;
}

/** Fetch + concatenate a non-DRM HLS media playlist's segments. Descends one level for a master. */
async function fetchHlsAudio(playlistUrl: string, depth = 0): Promise<Buffer> {
  const response = await fetch(playlistUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Stream playlist failed (HTTP ${response.status}).`);
  }
  const text = (await readLimitedResponse(response, HLS_PLAYLIST_MAX_BYTES)).toString("utf8");
  const urls = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => new URL(line, playlistUrl).toString());
  if (urls.length === 0) {
    throw new Error("Stream playlist had no segments.");
  }
  // Master playlist (every entry is itself a playlist) → descend into the first variant.
  if (depth < 2 && urls.every((url) => /\.m3u8(\?|$)/i.test(url))) {
    return fetchHlsAudio(urls[0], depth + 1);
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (const url of urls) {
    const segment = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!segment.ok) {
      throw new Error(`Stream segment failed (HTTP ${segment.status}).`);
    }
    const remaining = DOWNLOAD_MAX_BYTES - totalBytes;
    if (remaining <= 0) {
      throw new Error("Download exceeded the 250 MB safety limit.");
    }
    const chunk = await readLimitedResponse(segment, remaining);
    totalBytes += chunk.length;
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new Error("No audio segments could be downloaded.");
  }
  return Buffer.concat(chunks);
}

async function downloadSoundCloudTrack(
  track: UnifiedTrack
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!providerGateway) {
    return { ok: false, error: "Provider gateway is not ready." };
  }
  if (track.provider !== "soundcloud") {
    return { ok: false, error: "Only SoundCloud tracks can be downloaded." };
  }

  const streamResult = await providerGateway.request({
    provider: "soundcloud",
    operation: "resolveStream",
    variables: { track }
  });
  if (!streamResult.ok || !streamResult.data) {
    return { ok: false, error: streamResult.error ?? "Couldn't find a downloadable stream for this track." };
  }
  const stream = streamResult.data as { url?: string; drm?: unknown };
  if (stream.drm) {
    return { ok: false, error: "This is a Go+ / DRM-protected track and can't be downloaded." };
  }
  if (!stream.url) {
    return { ok: false, error: "No download URL was available for this track." };
  }

  const dir = path.join(app.getPath("music"), "AMP");
  await fs.mkdir(dir, { recursive: true });
  const artist = track.creators?.find((name) => name && name.trim()) ?? "Unknown Artist";
  const baseName = sanitizeDownloadName(`${artist} - ${track.title}`);
  let tempPath: string | undefined;

  try {
    const response = await fetch(stream.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      return { ok: false, error: `Download failed (HTTP ${response.status}).` };
    }
    const body = await readLimitedResponse(response, DOWNLOAD_MAX_BYTES);
    const isPlaylist = body.subarray(0, 7).toString("utf8") === "#EXTM3U";
    const audio = isPlaylist ? await fetchHlsAudio(stream.url) : body;
    const extension = detectAudioExtension(audio);
    if (!extension) {
      return { ok: false, error: "The stream used an unsupported audio container." };
    }
    const outPath = await uniqueDownloadPath(dir, `${baseName}${extension}`);
    tempPath = `${outPath}.${randomBytes(8).toString("hex")}.part`;
    await fs.writeFile(tempPath, audio);
    await fs.rename(tempPath, outPath);
    return { ok: true, path: outPath };
  } catch (error) {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined); // never leave a partial file
    }
    return { ok: false, error: error instanceof Error ? error.message : "Download failed." };
  }
}

async function clearDefaultSoundCloudOAuthCookies(): Promise<void> {
  const cookies = await session.defaultSession.cookies.get({ name: "oauth_token" }).catch(() => []);
  await Promise.all(
    cookies
      .filter((cookie) => /(^|\.)soundcloud\.com$/i.test(cookie.domain ?? ""))
      .map((cookie) => {
        const hostname = (cookie.domain ?? "soundcloud.com").replace(/^\./, "");
        return session.defaultSession.cookies
          .remove(`https://${hostname}${cookie.path || "/"}`, "oauth_token")
          .catch(() => undefined);
      })
  );
}

const ARTWORK_MAX_BYTES = 8 * 1024 * 1024;
const ARTWORK_TIMEOUT_MS = 10_000;
const ARTWORK_HOST_SUFFIXES = [
  "scdn.co",
  "spotifycdn.com",
  "sndcdn.com",
  "ytimg.com",
  "ggpht.com",
  "dzcdn.net"
];

function isAllowedArtworkUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      ARTWORK_HOST_SUFFIXES.some(
        (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
      )
    );
  } catch {
    return false;
  }
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Response was too large.");
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Response was too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function resolveArtworkAsset(request: ArtworkRequest): Promise<ResolvedArtwork> {
  if (!request.artworkUrl) {
    return { source: "none" };
  }

  if (!/^https?:\/\//i.test(request.artworkUrl)) {
    return /^(data:|blob:|amp-local:)/i.test(request.artworkUrl)
      ? { dataUrl: request.artworkUrl, source: "passthrough" }
      : { source: "none" };
  }

  // Provider metadata is untrusted. Unknown hosts fail closed instead of becoming a direct image
  // request that bypasses the main-process type, size, redirect, and timeout checks.
  if (!isAllowedArtworkUrl(request.artworkUrl)) {
    return { source: "none" };
  }

  const cacheKey = createHash("sha1")
    .update(request.cacheKey ?? request.artworkUrl)
    .digest("hex");

  const cached = artworkRequests.get(cacheKey);
  if (cached) {
    return cached;
  }

  const resolution = (async () => {
    await fs.mkdir(getArtworkCacheDirectory(), { recursive: true });
    const cachePath = path.join(getArtworkCacheDirectory(), `${cacheKey}.txt`);

    try {
      const dataUrl = await fs.readFile(cachePath, "utf8");
      if (dataUrl.trim()) {
        return {
          dataUrl,
          source: "cache" as const
        };
      }
    } catch {
      // Cache miss.
    }

    try {
      const response = await fetch(request.artworkUrl!, {
        signal: AbortSignal.timeout(ARTWORK_TIMEOUT_MS)
      });
      if (!response.ok) {
        return { source: "none" as const };
      }

      if (!isAllowedArtworkUrl(response.url)) {
        return { source: "none" as const };
      }

      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
      if (!contentType.startsWith("image/")) {
        return { source: "none" as const };
      }
      const buffer = await readLimitedResponse(response, ARTWORK_MAX_BYTES);
      const dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
      const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, dataUrl, "utf8");
      await fs.rename(tempPath, cachePath).catch(async (error) => {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      });
      return {
        dataUrl,
        source: "download" as const
      };
    } catch (error) {
      logStartup("artwork:resolve-failed", error);
      return { source: "none" as const };
    }
  })();

  artworkRequests.set(cacheKey, resolution);

  try {
    return await resolution;
  } finally {
    artworkRequests.delete(cacheKey);
  }
}

async function readProviderSessionsFile(): Promise<Record<Provider, StoredProviderSessionRecord | undefined>> {
  try {
    const file = await fs.readFile(getProviderSessionsPath(), "utf8");
    const parsed = JSON.parse(file) as Record<Provider, StoredProviderSessionRecord | undefined>;
    let scrubbedLegacyMetadata = false;
    const scrub = (record: StoredProviderSessionRecord | undefined) => {
      if (!record?.metadata || !("dataDomeCookie" in record.metadata)) {
        return record;
      }
      const { dataDomeCookie: _discarded, ...metadata } = record.metadata;
      scrubbedLegacyMetadata = true;
      return { ...record, metadata };
    };
    const sessions = {
      spotify: scrub(parsed?.spotify),
      soundcloud: scrub(parsed?.soundcloud)
    };
    if (scrubbedLegacyMetadata) {
      await writeProviderSessionsFile(sessions);
    }
    return sessions;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        spotify: undefined,
        soundcloud: undefined
      };
    }
    if (error instanceof SyntaxError) {
      const sourcePath = getProviderSessionsPath();
      const backupPath = `${sourcePath}.corrupt-${Date.now()}`;
      await fs.rename(sourcePath, backupPath).catch(() => undefined);
      logStartup("auth:quarantined-corrupt-session-file");
      return {
        spotify: undefined,
        soundcloud: undefined
      };
    }
    throw error;
  }
}

async function writeProviderSessionsFile(
  sessions: Record<Provider, StoredProviderSessionRecord | undefined>
): Promise<void> {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  const targetPath = getProviderSessionsPath();
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(sessions, null, 2), "utf8");
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

let providerSessionMutationQueue: Promise<void> = Promise.resolve();

function mutateProviderSessions<T>(
  mutation: (sessions: Record<Provider, StoredProviderSessionRecord | undefined>) => T | Promise<T>
): Promise<T> {
  const run = providerSessionMutationQueue.then(async () => {
    const sessions = await readProviderSessionsFile();
    const result = await mutation(sessions);
    await writeProviderSessionsFile(sessions);
    return result;
  });
  providerSessionMutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const providerSessionEpoch = new Map<Provider, number>([
  ["spotify", 0],
  ["soundcloud", 0]
]);

function getProviderSessionEpoch(provider: Provider): number {
  return providerSessionEpoch.get(provider) ?? 0;
}

class StaleProviderSessionError extends Error {}

async function persistLocalProviderSession(
  payload: ProviderConnectionPayload,
  connectedAt = new Date().toISOString(),
  expectedEpoch?: number
): Promise<{ storageMode: ProviderStorageMode; sessionSource: ProviderSessionSource; connectedAt: string }> {
  const assertCurrentSession = () => {
    if (expectedEpoch !== undefined && getProviderSessionEpoch(payload.provider) !== expectedEpoch) {
      throw new StaleProviderSessionError("Provider session changed while credentials were refreshing.");
    }
  };
  assertCurrentSession();
  const volatileSession: VolatileProviderSession = {
    ...payload,
    connectedAt,
    storageMode: isSecureStorageAvailable() ? "local-secure" : "memory-only"
  };
  if (!isSecureStorageAvailable()) {
    await mutateProviderSessions((sessions) => {
      assertCurrentSession();
      sessions[payload.provider] = undefined;
    });
    assertCurrentSession();
    volatileProviderSessions.set(payload.provider, volatileSession);
    return {
      storageMode: "memory-only",
      sessionSource: "memory",
      connectedAt
    };
  }

  await mutateProviderSessions((sessions) => {
    assertCurrentSession();
    sessions[payload.provider] = {
      provider: payload.provider,
      encryptedAccessToken: encryptToken(payload.accessToken),
      encryptedRefreshToken: encryptToken(payload.refreshToken),
      expiresAt: payload.expiresAt,
      displayName: payload.displayName,
      requiresPremium: payload.requiresPremium,
      metadata: payload.metadata,
      connectedAt,
      storageMode: "local-secure"
    };
  });
  assertCurrentSession();
  volatileProviderSessions.set(payload.provider, volatileSession);

  return {
    storageMode: "local-secure",
    sessionSource: "local",
    connectedAt
  };
}

async function clearLocalProviderSession(provider: Provider): Promise<void> {
  providerSessionEpoch.set(provider, getProviderSessionEpoch(provider) + 1);
  volatileProviderSessions.delete(provider);
  await mutateProviderSessions((sessions) => {
    sessions[provider] = undefined;
  });

  if (provider === "soundcloud") {
    // Full sign-out: wipe AMP's OWN SoundCloud session (the persist:soundcloud partition the in-app
    // sign-in and like windows use). Without this the oauth_token cookie survives a disconnect, so
    // the next "Sign in to SoundCloud" would silently reuse the old account and you could never
    // switch accounts or see a fresh login.
    soundCloudOAuthToken = undefined;
    providerGateway?.clearSoundCloudSession();
    await clearDefaultSoundCloudOAuthCookies();
    if (soundCloudSignInWindow && !soundCloudSignInWindow.isDestroyed()) {
      soundCloudSignInWindow.close();
    }
    if (soundCloudLikeWindow && !soundCloudLikeWindow.isDestroyed()) {
      soundCloudLikeWindow.close();
    }
    await session.fromPartition(SOUNDCLOUD_LOCAL_PARTITION).clearStorageData().catch(() => undefined);
    await clearSoundCloudResolverSession();
    // Also wipe the persistent system-browser login profile so a fresh sign-in / account switch
    // starts clean instead of silently re-reading the old account.
    await fs.rm(soundCloudLoginProfileDir(), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function getStoredProviderSessionStatuses(): Promise<StoredProviderSessionStatus[]> {
  const sessions = await readProviderSessionsFile();
  return (["spotify", "soundcloud"] as Provider[]).map((provider) => {
    const session = sessions[provider];
    const volatile = volatileProviderSessions.get(provider);
    return {
      provider,
      hasStoredSession: Boolean(session?.encryptedRefreshToken || session?.encryptedAccessToken || volatile),
      storageMode: session?.storageMode ?? volatile?.storageMode ?? "none",
      displayName: session?.displayName ?? volatile?.displayName,
      connectedAt: session?.connectedAt ?? volatile?.connectedAt,
      expiresAt: session?.expiresAt ?? volatile?.expiresAt
    };
  });
}

function toProviderOAuthResult(
  payload: ProviderConnectionPayload,
  connectedAt: string,
  sessionSource: ProviderSessionSource,
  storageMode: ProviderStorageMode
): ProviderOAuthResult {
  return {
    ...payload,
    connectedAt,
    sessionSource,
    storageMode
  };
}

function shouldRefresh(expiresAt?: string): boolean {
  if (!expiresAt) {
    return true;
  }

  return new Date(expiresAt).getTime() - Date.now() < 60_000;
}

function usesCustomWindowChrome(): boolean {
  return process.platform === "win32" || process.platform === "linux";
}

function getDesktopWindowState(): DesktopWindowState {
  return {
    canCustomize: usesCustomWindowChrome(),
    isMaximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized())
  };
}

function createStoredProviderRuntimeStatus(
  provider: Provider,
  config: DesktopConfig,
  storedSession?: StoredProviderSessionRecord,
  hasVolatileSession = false
): ProviderRuntimeOAuthStatus {
  const hasSoundCloudDesktopOAuth = Boolean(config.soundCloudClientId && config.soundCloudClientSecret);
  const hasPersistedSession = Boolean(storedSession?.encryptedRefreshToken || storedSession?.encryptedAccessToken);
  const configured =
    (provider === "spotify" ? Boolean(config.spotifyClientId) : hasSoundCloudDesktopOAuth) ||
    hasPersistedSession ||
    hasVolatileSession;

  if (!configured) {
    return {
      configured: false,
      hasStoredSession: false,
      storageMode: "none",
      message:
        provider === "spotify"
          ? "Spotify sign-in needs SPOTIFY_CLIENT_ID in this build."
          : "SoundCloud API sign-in needs a client ID and secret configured in Settings. Public SoundCloud search and playback still work without it."
    };
  }

  if (hasPersistedSession && storedSession) {
    return {
      configured: true,
      hasStoredSession: true,
      storageMode: storedSession.storageMode,
      message: "Ready to reconnect on this device."
    };
  }

  if (hasVolatileSession) {
    return {
      configured: true,
      hasStoredSession: false,
      storageMode: "memory-only",
      message: "Connected for this app session only."
    };
  }

  return {
    configured: true,
    hasStoredSession: false,
    storageMode: "none",
    message:
      provider === "soundcloud"
        ? hasSoundCloudDesktopOAuth
          ? "Ready to connect inside AMP and sync your SoundCloud likes plus playlists."
          : "SoundCloud library sign-in needs bundled desktop OAuth credentials in this standalone build. Public SoundCloud tracks can still search and play without them."
        : "Ready to connect and sync your library."
  };
}

async function buildRuntimeInfo(): Promise<RuntimeInfo> {
  const config = await readResolvedDesktopConfig();
  const sessions = await readProviderSessionsFile();

  return {
    platform: process.platform,
    isPackaged: app.isPackaged,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    configDirectory: app.getPath("userData"),
    oauth: {
      spotify: createStoredProviderRuntimeStatus(
        "spotify",
        config,
        sessions.spotify,
        volatileProviderSessions.has("spotify")
      ),
      soundcloud: createStoredProviderRuntimeStatus(
        "soundcloud",
        config,
        sessions.soundcloud,
        volatileProviderSessions.has("soundcloud")
      )
    },
    devServerUrl: isDev ? process.env.VITE_DEV_SERVER_URL : undefined
  };
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw await createHttpError(response, `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

async function createHttpError(response: Response, fallback: string): Promise<Error> {
  const rawBody = await response.text();
  let message = rawBody.trim();

  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as JsonErrorBody;
      message =
        parsed.errors?.[0]?.error_message?.trim() ||
        parsed.errors?.[0]?.detail?.trim() ||
        parsed.errors?.[0]?.title?.trim() ||
        parsed.error?.message?.trim() ||
        parsed.message?.trim() ||
        message;
    } catch {
      // Some provider responses are plain text or HTML.
    }
  }

  if (response.status === 429) {
    return new Error("The provider is rate limiting AMP right now. Wait a moment, then try again.");
  }

  return new Error(message || fallback);
}

async function fetchSpotifyProfile(accessToken: string) {
  return fetchJson<{
    display_name?: string;
    id: string;
    product?: string;
    email?: string;
  }>("https://api.spotify.com/v1/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

async function fetchSoundCloudProfile(accessToken: string) {
  return fetchJson<{
    username?: string;
    full_name?: string;
    urn?: string;
  }>("https://api.soundcloud.com/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
}

async function refreshSpotifyProviderSession(refreshToken: string): Promise<ProviderConnectionPayload> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    throw new Error("Spotify sign-in is not enabled in this build yet.");
  }

  const tokenResponse = await fetchJson<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }>("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  const profile = await fetchSpotifyProfile(tokenResponse.access_token);
  return {
    provider: "spotify",
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
    displayName: profile.display_name ?? profile.id,
    requiresPremium: profile.product !== "premium",
    metadata: {
      product: profile.product ?? "unknown",
      email: profile.email ?? ""
    }
  };
}

async function refreshSoundCloudProviderSession(refreshToken: string): Promise<ProviderConnectionPayload> {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "SoundCloud API sign-in is not configured. Add a client ID and secret in Settings, or use SoundCloud Local Connect. Public search and playback still work without it."
    );
  }

  const tokenResponse = await fetchJson<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }>("https://secure.soundcloud.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken
    })
  });

  const profile = await fetchSoundCloudProfile(tokenResponse.access_token);
  return {
    provider: "soundcloud",
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
    displayName: profile.full_name || profile.username || profile.urn,
    metadata: {
      urn: profile.urn ?? ""
    }
  };
}

async function readLocalProviderSession(provider: Provider): Promise<VolatileProviderSession | null> {
  const volatileSession = volatileProviderSessions.get(provider);
  if (volatileSession) {
    return volatileSession;
  }

  const sessions = await readProviderSessionsFile();
  const storedSession = sessions[provider];
  if (!storedSession || !isSecureStorageAvailable()) {
    return null;
  }

  const accessToken = decryptToken(storedSession.encryptedAccessToken);
  const refreshToken = decryptToken(storedSession.encryptedRefreshToken);
  const isLocalSoundCloudSession =
    provider === "soundcloud" && storedSession.metadata?.source === "local-connect";

  if (!refreshToken && (!isLocalSoundCloudSession || !accessToken)) {
    await clearLocalProviderSession(provider);
    return null;
  }

  const hydrated: VolatileProviderSession = {
    provider,
    accessToken: accessToken ?? "",
    refreshToken,
    expiresAt: storedSession.expiresAt,
    displayName: storedSession.displayName,
    requiresPremium: storedSession.requiresPremium,
    metadata: storedSession.metadata,
    connectedAt: storedSession.connectedAt,
    storageMode: storedSession.storageMode
  };

  volatileProviderSessions.set(provider, hydrated);
  return hydrated;
}

// Serialize token refreshes per provider. Spotify rotates its refresh token on every refresh, so two
// refreshes firing at once (the SDK's getOAuthToken callback racing the startup restore, etc.) would
// both POST the SAME token — the first rotates it, the second then uses a token Spotify just revoked,
// and the whole session dies mid-playback. One in-flight refresh per provider means the next caller
// always sees the rotated token instead of racing it.
const inFlightProviderRefresh = new Map<Provider, Promise<ProviderOAuthResult | null>>();

function refreshLocalProviderSession(provider: Provider): Promise<ProviderOAuthResult | null> {
  const existing = inFlightProviderRefresh.get(provider);
  if (existing) {
    return existing;
  }
  const run = refreshLocalProviderSessionInner(provider).finally(() => {
    inFlightProviderRefresh.delete(provider);
  });
  inFlightProviderRefresh.set(provider, run);
  return run;
}

async function refreshLocalProviderSessionInner(provider: Provider): Promise<ProviderOAuthResult | null> {
  const expectedEpoch = getProviderSessionEpoch(provider);
  const session = await readLocalProviderSession(provider);
  if (!session || getProviderSessionEpoch(provider) !== expectedEpoch) {
    return null;
  }

  if (provider === "soundcloud" && session.accessToken) {
    soundCloudOAuthToken = session.accessToken;
    void setSoundCloudOAuthCookie(session.accessToken).catch(() => undefined);
    if (providerGateway) {
      // Prime the gateway with the signed-in token on launch so monetized / ad-supported tracks
      // (which 404 anonymously) resolve their stream even before the first manual library sync.
      // Fire-and-forget: resolveAuthenticatedProfile stores the token and is served from cache.
      void providerGateway
        .request({
          provider: "soundcloud",
          operation: "resolveAuthenticatedProfile",
          variables: { oauthToken: session.accessToken }
        })
        .catch(() => undefined);
    }
  }

  if (session.accessToken && !shouldRefresh(session.expiresAt)) {
    return toProviderOAuthResult(
      session,
      session.connectedAt,
      session.storageMode === "memory-only" ? "memory" : "local",
      session.storageMode
    );
  }

  if (!session.refreshToken) {
    if (provider === "soundcloud" && session.metadata?.source === "local-connect" && session.accessToken) {
      return toProviderOAuthResult(
        session,
        session.connectedAt,
        session.storageMode === "memory-only" ? "memory" : "local",
        session.storageMode
      );
    }
    return null;
  }

  const refreshed =
    provider === "spotify"
      ? await refreshSpotifyProviderSession(session.refreshToken)
      : await refreshSoundCloudProviderSession(session.refreshToken);

  if (getProviderSessionEpoch(provider) !== expectedEpoch) {
    return null;
  }
  const persisted = await persistLocalProviderSession(refreshed, session.connectedAt, expectedEpoch);
  if (getProviderSessionEpoch(provider) !== expectedEpoch) {
    return null;
  }
  return toProviderOAuthResult(
    refreshed,
    persisted.connectedAt,
    persisted.sessionSource,
    persisted.storageMode
  );
}

async function refreshProviderSession(provider: Provider): Promise<ProviderOAuthResult | null> {
  try {
    return await refreshLocalProviderSession(provider);
  } catch (error) {
    if (error instanceof StaleProviderSessionError) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    // A revoked/expired refresh token is unrecoverable — clear the dead session so the app shows a
    // clean "reconnect" state instead of throwing on every refresh and skipping every track.
    if (/invalid_grant|revoked|invalid_token|expired/i.test(message)) {
      logStartup(`auth:${provider}:refresh-unrecoverable — clearing session`, error);
      await clearLocalProviderSession(provider).catch(() => undefined);
      return null;
    }
    // Transient failure (e.g. offline at boot): keep the stored session for a later retry, but
    // resolve null instead of rejecting — a rejection here left the renderer's session-restore
    // await hanging in a permanent "connecting" state.
    logStartup(`auth:${provider}:refresh-transient-failure`, error);
    return null;
  }
}

async function connectSpotify(): Promise<ProviderOAuthResult> {
  const config = await readResolvedDesktopConfig();
  const clientId = config.spotifyClientId || process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    throw new Error("Spotify sign-in needs SPOTIFY_CLIENT_ID in this standalone build.");
  }
  const expectedEpoch = getProviderSessionEpoch("spotify") + 1;
  providerSessionEpoch.set("spotify", expectedEpoch);

  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = randomBytes(12).toString("hex");
  const scope = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-library-read",
    "user-library-modify",
    "user-modify-playback-state",
    "user-read-playback-state",
    "playlist-read-private",
    "playlist-read-collaborative"
  ].join(" ");

  let result: LoopbackResult;
  try {
    result = await waitForLoopbackAuthorizationCode(
      "spotify",
      (redirectUri) => {
        const params = new URLSearchParams({
          client_id: clientId,
          response_type: "code",
          redirect_uri: redirectUri,
          code_challenge_method: "S256",
          code_challenge: challenge,
          state,
          scope
        });
        return `https://accounts.spotify.com/authorize?${params.toString()}`;
      },
      8000
    );
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
    if (code === "EADDRINUSE") {
      throw new Error(
        "Spotify sign-in needs port 8000, but another app is already using it. Close the other app or free port 8000 and try again."
      );
    }
    throw error;
  }

  if (result.error) {
    throw new Error(result.error);
  }
  if (!result.code || result.state !== state) {
    throw new Error("Spotify authorization state could not be verified.");
  }

  const tokenResponse = await fetchJson<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }>("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code: result.code,
      redirect_uri: result.redirectUri,
      code_verifier: verifier
    })
  });

  const profile = await fetchSpotifyProfile(tokenResponse.access_token);
  const payload: ProviderConnectionPayload = {
    provider: "spotify",
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
    displayName: profile.display_name ?? profile.id,
    requiresPremium: profile.product !== "premium",
    metadata: {
      product: profile.product ?? "unknown",
      email: profile.email ?? ""
    }
  };

  const persisted = await persistLocalProviderSession(payload, undefined, expectedEpoch);
  return toProviderOAuthResult(payload, persisted.connectedAt, persisted.sessionSource, persisted.storageMode);
}

async function connectSoundCloud(): Promise<ProviderOAuthResult> {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "SoundCloud API sign-in is not configured. Add a client ID and secret in Settings, or use SoundCloud Local Connect. Public search and playback still work without it."
    );
  }
  const expectedEpoch = getProviderSessionEpoch("soundcloud") + 1;
  providerSessionEpoch.set("soundcloud", expectedEpoch);

  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = randomBytes(12).toString("hex");

  const result = await waitForCustomProtocolAuthorizationCode("soundcloud", (redirectUri) => {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
      display: "popup"
    });
    return `https://secure.soundcloud.com/authorize?${params.toString()}`;
  });

  if (result.error) {
    throw new Error(result.error);
  }
  if (!result.code || result.state !== state) {
    throw new Error("SoundCloud authorization state could not be verified.");
  }

  const tokenResponse = await fetchJson<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }>("https://secure.soundcloud.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: result.redirectUri,
      code_verifier: verifier,
      code: result.code
    })
  });

  const profile = await fetchSoundCloudProfile(tokenResponse.access_token);
  const payload: ProviderConnectionPayload = {
    provider: "soundcloud",
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
    displayName: profile.full_name || profile.username || profile.urn,
    metadata: {
      urn: profile.urn ?? ""
    }
  };

  const persisted = await persistLocalProviderSession(payload, undefined, expectedEpoch);
  return toProviderOAuthResult(payload, persisted.connectedAt, persisted.sessionSource, persisted.storageMode);
}

// ---- Legacy SoundCloud web session restore ----
// Older builds could capture an oauth_token from an isolated Electron SoundCloud partition.
// New sign-in no longer opens SoundCloud inside Electron; this remains only so existing stored
// sessions can keep loading until the user signs out or clears them.
const SOUNDCLOUD_WEB_PARTITION = "persist:soundcloud-web";

async function readSoundCloudWebToken(): Promise<string | undefined> {
  try {
    const ses = session.fromPartition(SOUNDCLOUD_WEB_PARTITION);
    // Match the oauth_token cookie on any SoundCloud domain (with or without a leading dot).
    const cookies = await ses.cookies.get({ name: "oauth_token" });
    const raw = cookies
      .filter((cookie) => /(^|\.)soundcloud\.com$/i.test(cookie.domain ?? ""))
      .map((cookie) => cookie.value)
      .find((value) => value && value.length > 8);
    return raw ? decodeURIComponent(raw) : undefined;
  } catch (error) {
    logStartup("soundcloud:web-token-read-failed", error);
    return undefined;
  }
}

async function clearSoundCloudWebSession(): Promise<void> {
  try {
    await session.fromPartition(SOUNDCLOUD_WEB_PARTITION).clearStorageData();
    await clearDefaultSoundCloudOAuthCookies();
    providerGateway?.clearSoundCloudSession();
    await clearSoundCloudResolverSession();
  } catch (error) {
    logStartup("soundcloud:web-signout-failed", error);
  }
}

async function resolveSoundCloudWebLibrary(token: string) {
  if (!providerGateway) {
    return { ok: false, error: "Provider gateway is not ready.", source: "fallback" as const };
  }
  return providerGateway.request({
    provider: "soundcloud",
    operation: "resolveAuthenticatedProfile",
    variables: { oauthToken: token }
  });
}

async function setSoundCloudWebTrackLiked(request: SoundCloudTrackLikeRequest) {
  if (!providerGateway) {
    return { ok: false, error: "Provider gateway is not ready.", source: "fallback" as const };
  }

  const token = await readSoundCloudWebToken();
  if (!token) {
    return {
      ok: false,
      error: "Sign in with SoundCloud to update likes on your account.",
      source: "internal" as const
    };
  }

  return providerGateway.request({
    provider: "soundcloud",
    operation: "setTrackLiked",
    variables: {
      oauthToken: token,
      track: request.track,
      liked: request.liked
    }
  });
}

// A hidden, signed-in soundcloud.com window. Likes run from THIS real Chromium page context (with
// credentials) so DataDome sees its own browser + freshly-issued anti-bot cookie — the only way past
// the 403 that blocks api-v2 like writes made from outside a real browser.
let soundCloudLikeWindow: BrowserWindow | undefined;
let soundCloudLikeWindowReady: Promise<BrowserWindow> | undefined;

function isTrustedSoundCloudPage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      (url.hostname === "soundcloud.com" || url.hostname.endsWith(".soundcloud.com"))
    );
  } catch {
    return false;
  }
}

async function ensureSoundCloudLikeWindow(): Promise<BrowserWindow> {
  if (soundCloudLikeWindow && !soundCloudLikeWindow.isDestroyed()) {
    return soundCloudLikeWindow;
  }
  if (!soundCloudLikeWindowReady) {
    soundCloudLikeWindowReady = (async () => {
      const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const win = new BrowserWindow({
        show: false,
        width: 1024,
        height: 768,
        // Tie it to the main window so it rides along — stays in front of AMP, minimises and
        // restores with it, and closes when AMP closes instead of floating free on the desktop.
        parent,
        title: "SoundCloud",
        autoHideMenuBar: true,
        webPreferences: {
          partition: SOUNDCLOUD_LOCAL_PARTITION,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false
        }
      });
      win.on("closed", () => {
        soundCloudLikeWindow = undefined;
        soundCloudLikeWindowReady = undefined;
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const guardSoundCloudNavigation = (event: { preventDefault(): void }, url: string) => {
        if (!isTrustedSoundCloudPage(url)) {
          event.preventDefault();
          logStartup("soundcloud:like:blocked-navigation");
        }
      };
      win.webContents.on("will-navigate", guardSoundCloudNavigation);
      win.webContents.on("will-redirect", guardSoundCloudNavigation);
      try {
        // Loading a real soundcloud.com page makes DataDome issue its cookie to this session (which
        // already holds the injected oauth_token), so subsequent in-page like fetches are trusted.
        await win.loadURL("https://soundcloud.com/discover");
        if (!isTrustedSoundCloudPage(win.webContents.getURL())) {
          throw new Error("SoundCloud sign-in window navigated to an untrusted page.");
        }
      } catch (error) {
        // A failed load would otherwise cache this rejected promise forever (the window never
        // fires "closed"), permanently breaking likes until restart. Destroy + reset so the next
        // like attempt rebuilds the window.
        soundCloudLikeWindowReady = undefined;
        win.destroy();
        throw error;
      }
      soundCloudLikeWindow = win;
      return win;
    })();
  }
  return soundCloudLikeWindowReady;
}

async function setSoundCloudLocalTrackLiked(request: SoundCloudTrackLikeRequest) {
  const session = await readLocalProviderSession("soundcloud");
  if (!session?.accessToken || session.metadata?.source !== "local-connect") {
    return {
      ok: false,
      error: "Reconnect SoundCloud Local Connect to update likes on your account.",
      source: "internal" as const
    };
  }

  const numericId = (request.track.providerTrackId ?? request.track.id ?? "").match(/(\d+)(?!.*\d)/)?.[1];
  if (!numericId) {
    return { ok: false, error: "Could not resolve that SoundCloud track id for likes.", source: "internal" as const };
  }

  return setSoundCloudLocalTrackLikedViaAppWindow(request, session, numericId);
}

// Runs the like from a hidden, signed-in soundcloud.com window. The write is attempted silently first;
// only if DataDome demands a human check do we surface it (in-page, see buildCaptchaOverlayScript) for
// a one-time solve. We detect the solve by retrying the like until it goes through — the only reliable
// signal. The cleared cookie then lives in this window's persistent session, so later likes are silent.
async function setSoundCloudLocalTrackLikedViaAppWindow(
  request: SoundCloudTrackLikeRequest,
  session: VolatileProviderSession,
  numericId: string
) {
  if (!providerGateway) {
    return { ok: false, error: "Provider gateway is not ready.", source: "fallback" as const };
  }
  try {
    // Keep the app's injected session cookie fresh, fetch the client_id, then run the like from
    // inside the real soundcloud.com page.
    await injectSoundCloudLocalSession(session.accessToken).catch(() => undefined);
    const clientId = await providerGateway.getSoundCloudClientId();
    const win = await ensureSoundCloudLikeWindow();
    const method = request.liked ? "PUT" : "DELETE";
    const oauthToken = session.accessToken;
    const scriptArguments = JSON.stringify({ oauthToken, clientId, numericId, method });
    const script = `(async ({ oauthToken, clientId, numericId, method }) => {
      try {
        const auth = { Authorization: 'OAuth ' + oauthToken };
        const meUrl = 'https://api-v2.soundcloud.com/me?client_id=' + encodeURIComponent(clientId);
        const meRes = await fetch(meUrl, { headers: auth, credentials: 'include' });
        if (!meRes.ok) return { ok: false, stage: 'me', status: meRes.status, body: (await meRes.text()).slice(0, 300) };
        const me = await meRes.json();
        if (!me || !me.id) return { ok: false, stage: 'me', status: 0 };
        const url = 'https://api-v2.soundcloud.com/users/' + encodeURIComponent(me.id) +
          '/track_likes/' + encodeURIComponent(numericId) + '?client_id=' + encodeURIComponent(clientId);
        const res = await fetch(url, { method, headers: auth, credentials: 'include' });
        const body = res.ok ? '' : (await res.text()).slice(0, 4000);
        return { ok: res.ok, stage: 'write', status: res.status, body };
      } catch (e) { return { ok: false, stage: 'error', status: 0, message: String(e) }; }
    })(${scriptArguments})`;
    type LikeResult = { ok: boolean; stage: string; status: number; message?: string; body?: string };
    const exec = () => {
      if (win.isDestroyed() || !isTrustedSoundCloudPage(win.webContents.getURL())) {
        throw new Error("SoundCloud like window is no longer on a trusted page.");
      }
      return win.webContents.executeJavaScript(script) as Promise<LikeResult>;
    };
    const isCaptcha = (r: LikeResult) =>
      !r.ok && r.status === 403 && /captcha-delivery|datadome/i.test(r.body ?? "");

    logStartup(`soundcloud:like:window start track=${numericId} liked=${request.liked}`);
    let result = await exec();

    // DataDome gates the WRITE with a human check we can't (and won't) solve programmatically. When it
    // fires, surface it in-page over soundcloud.com (so the page origin stays right for the retry) and
    // poll the like until it succeeds — the reliable "did they solve it?" signal. Once solved, the
    // cleared cookie persists in this window's session, so subsequent likes never reach this branch.
    if (isCaptcha(result)) {
      const captchaUrl = extractDataDomeCaptchaUrl(result.body);
      logStartup(`soundcloud:like:window captcha url=${captchaUrl ? "yes" : "no"} bodyLen=${result.body?.length ?? 0}`);
      if (captchaUrl) {
        win.setTitle("SoundCloud — quick human check to save your like");
        // Center the prompt over AMP so it reads as part of the app, not a stray browser window.
        if (mainWindow && !mainWindow.isDestroyed()) {
          const parentBounds = mainWindow.getBounds();
          const { width, height } = win.getBounds();
          win.setBounds({
            x: Math.round(parentBounds.x + (parentBounds.width - width) / 2),
            y: Math.round(parentBounds.y + (parentBounds.height - height) / 2),
            width,
            height
          });
        }
        await win.webContents.executeJavaScript(buildCaptchaOverlayScript(captchaUrl)).catch(() => undefined);
        win.show();
        win.focus();

        const solveDeadline = Date.now() + 150_000;
        while (isCaptcha(result) && Date.now() < solveDeadline && !win.isDestroyed()) {
          await wait(2_500);
          result = await exec();
        }
        if (!win.isDestroyed()) {
          await win.webContents
            .executeJavaScript("document.getElementById('amp-datadome')?.remove();")
            .catch(() => undefined);
          win.hide();
        }
        logStartup(`soundcloud:like:window after-solve ok=${result.ok} stage=${result.stage} status=${result.status}`);
      }
    }

    if (!result.ok) {
      return {
        ok: false,
        error: isCaptcha(result)
          ? "The human-check wasn't finished in time. Tap the heart again and complete the quick check to save your like."
          : `SoundCloud like failed (HTTP ${result.status}).`,
        source: "internal" as const
      };
    }
    providerGateway.invalidateProviderCache("soundcloud");
    return { ok: true, data: { liked: request.liked }, source: "internal" as const };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "SoundCloud like failed.",
      source: "internal" as const
    };
  }
}

function createStartupWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "AMP",
    width: 420,
    height: 220,
    show: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    frame: false,
    center: true,
    backgroundColor: "#0e1110",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>AMP</title><style>html,body{height:100%;margin:0;background:#0e1110;color:#f4efe6;font-family:system-ui,sans-serif}body{display:grid;place-items:center}.card{text-align:center}.mark{font-size:38px;font-weight:800;letter-spacing:.16em}.status{margin-top:16px;color:#aaa096;font-size:13px;letter-spacing:.04em}</style><div class="card"><div class="mark">AMP</div><div class="status">Preparing secure playback...</div></div>`;
  void window
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .catch((error) => {
      if (!window.isDestroyed()) {
        logStartup("startup-window:load-failed", error);
      }
    });
  return window;
}

async function createMainWindow() {
  logStartup("createMainWindow:start");
  const preloadPath = path.join(moduleDirectory, "preload.cjs");

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindowStartupComplete = false;

  const window = new BrowserWindow({
    title: "AMP",
    icon: brandIcon(appIconDataUrl),
    width: startupWindowBounds.width,
    height: startupWindowBounds.height,
    minWidth: startupWindowBounds.width,
    minHeight: startupWindowBounds.height,
    show: false,
    backgroundColor: "#0e1110",
    autoHideMenuBar: true,
    frame: !usesCustomWindowChrome(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
      sandbox: true,
      // AMP has no prose fields (just search/rename boxes), so the spellchecker only costs memory —
      // it lazy-loads a per-language dictionary (tens of MB) into the renderer. Off = leaner.
      spellcheck: false,
      // SoundCloud audio is started after an async stream-resolve, i.e. outside the click's
      // user-gesture window. Without this the first play of a session is silently blocked and
      // only works on the second try. Let our own playback start without a gesture.
      autoplayPolicy: "no-user-gesture-required",
      // We need to fetch cross-origin SoundCloud stream playlists, license servers, and widget
      // APIs from origins that don't allow localhost/app:// in their CORS policy. Disable CORS
      // enforcement so the renderer can read these responses. Context isolation + no node
      // integration still keep the sandbox intact.
      webSecurity: false
    }
  });
  window.center();

  // Guard against a stale off-screen saved position (window spawning half off the display).
  const createdBounds = window.getBounds();
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      createdBounds.x < area.x + area.width - 80 &&
      createdBounds.x + createdBounds.width > area.x + 80 &&
      createdBounds.y < area.y + area.height - 80 &&
      createdBounds.y + createdBounds.height > area.y + 40
    );
  });
  if (!onScreen) {
    window.center();
  }

  // Grant the renderer's getDisplayMedia silently with SYSTEM AUDIO LOOPBACK (Windows). The
  // beat-reactive gradient uses this to analyse Spotify (DRM'd SDK) and SoundCloud-widget audio,
  // which the renderer cannot tap any other way. The video track is a throwaway the renderer
  // stops immediately; no picker is shown and nothing is recorded.
  if (process.platform === "win32") {
    window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      if (
        request.frame !== window.webContents.mainFrame ||
        !request.userGesture ||
        !isTrustedMainWindowUrl(request.frame.url)
      ) {
        logStartup("display-media:blocked-untrusted-request");
        callback({});
        return;
      }
      // thumbnailSize 0 skips the per-display screenshot getSources would otherwise grab on every
      // call. The renderer requests a ~1 fps tiny video and stops the track at once; we only want
      // the loopback AUDIO. (See audioReactor.ensureLoopback for why the video must stay minimal.)
      desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          if (sources.length === 0) {
            callback({});
            return;
          }
          callback({ video: sources[0], audio: "loopback" });
        })
        .catch(() => callback({}));
    });
  }

  logStartup("createMainWindow:browser-window-created");
  logStartup("createMainWindow:preload-path", preloadPath);

  try {
    await fs.access(preloadPath);
    logStartup("createMainWindow:preload-found");
  } catch (error) {
    logStartup("createMainWindow:preload-missing", error);
  }

  if (usesCustomWindowChrome()) {
    window.removeMenu();
    window.setMenuBarVisibility(false);
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openAllowedExternalUrl(url);
    return { action: "deny" };
  });

  const guardMainFrameNavigation = (event: { preventDefault(): void }, url: string) => {
    if (isTrustedMainWindowUrl(url)) {
      return;
    }
    event.preventDefault();
    void openAllowedExternalUrl(url);
  };
  window.webContents.on("will-navigate", guardMainFrameNavigation);
  window.webContents.on("will-redirect", guardMainFrameNavigation);

  window.webContents.on("preload-error", (_event, preloadFile, error) => {
    logStartup(`createMainWindow:preload-error:${preloadFile}`, error);
  });

  window.webContents.on("console-message", (event) => {
    if (!app.isPackaged || event.level === "warning" || event.level === "error") {
      logStartup(`renderer:console:${event.sourceId}:${event.lineNumber}`, event.message);
    }
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    logStartup(`renderer:gone:${details.reason}`, details.exitCode);
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logStartup(`renderer:did-fail-load:${errorCode}:${validatedURL}`, errorDescription);
  });

  window.on("close", (event) => {
    if (mainWindowStartupComplete) {
      void saveWindowState(window);
    }
    // Close-to-tray: clicking X hides AMP rather than quitting it, so it keeps playing in the
    // background with a visible tray icon. A real exit goes through quitAmp() (tray "Quit").
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
      if (!shownTrayHint) {
        shownTrayHint = true;
        try {
          tray?.displayBalloon({
            title: "AMP is still running",
            content: "Click the tray icon to reopen, or right-click it and choose Quit AMP."
          });
        } catch {
          // displayBalloon is Windows-only — ignore elsewhere.
        }
      }
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  mainWindow = window;

  // Major-label SoundCloud tracks serve from a CDN that checks Origin/Referer.
  // Spoof the headers so the CDN and license server think the request came from soundcloud.com.
  const SPOOFED_ORIGIN = "https://soundcloud.com";
  const SPOOFED_REFERER = "https://soundcloud.com/";
  // Match the current Brave/Chromium the working browser capture used (Chrome/148). SoundCloud
  // endpoints sometimes gate on UA; keep this aligned with current desktop Chrome.
  const CHROME_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

  // Remember the actual Origin header sent by each frame so we can echo it back in
  // Access-Control-Allow-Origin. The browser's CORS check uses the real frame origin,
  // not the spoofed Origin we send to the server, so ACAO must match the real origin.
  // The widget iframe loads from w.soundcloud.com; our app loads from localhost / app://.
  const actualOrigins = new Map<number, string>();

  window.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const soundCloudHost = getTrustedSoundCloudPlaybackHost(details.url);

    if (soundCloudHost) {
      // Capture the real origin before we overwrite it.
      const actualOrigin =
        details.requestHeaders["Origin"] ||
        details.requestHeaders["origin"] ||
        "";
      if (actualOrigin) {
        actualOrigins.set(details.id, actualOrigin);
        if (actualOrigins.size > 200) {
          // Prevent unbounded growth if onHeadersReceived is skipped.
          const firstKey = actualOrigins.keys().next().value;
          if (firstKey !== undefined) {
            actualOrigins.delete(firstKey);
          }
        }
      }

      // Remove any existing case variants so we don't end up with duplicate headers.
      for (const key of Object.keys(details.requestHeaders)) {
        if (key.toLowerCase() === "origin" || key.toLowerCase() === "referer") {
          delete details.requestHeaders[key];
        }
      }
      details.requestHeaders["Origin"] = SPOOFED_ORIGIN;
      details.requestHeaders["Referer"] = SPOOFED_REFERER;
      // Some SoundCloud endpoints reject requests that contain "Electron" in the UA.
      details.requestHeaders["User-Agent"] = CHROME_UA;
      // Captured from the working browser: the real
      // license POST is sent CROSS-SITE to *.soundcloud.cloud and carries NO Cookie at all — the
      // datadome cookie is SameSite=Lax on .soundcloud.com and oauth_token is host-only to
      // soundcloud.com, so neither crosses to soundcloud.cloud. The endpoint is gated solely by the
      // license_token in the query. Strip ALL cookies here to match the browser exactly; a leftover
      // oauth_token / datadome cookie is the prime 403 suspect.
      if (soundCloudHost === "license.media-streaming.soundcloud.cloud") {
        for (const key of Object.keys(details.requestHeaders)) {
          if (key.toLowerCase() === "cookie") {
            delete details.requestHeaders[key];
          }
        }
      }
      logStartup(
        `webRequest:spoof ${details.method} ${details.url.replace(/\?.*$/, "")} | actualOrigin=${actualOrigin} | ua=${details.requestHeaders["User-Agent"].slice(0, 40)}...`
      );

      // Conclusive on-wire header dump for the Widevine license endpoint so a still-403 attempt
      // is debuggable against the Safari FairPlay baseline (which sends only Origin/Referer/UA,
      // no Cookie/Authorization). Token values are redacted; only param names are logged.
      if (soundCloudHost === "license.media-streaming.soundcloud.cloud") {
        const h = details.requestHeaders;
        const pick = (k: string): string =>
          String(h[k] ?? h[k.toLowerCase()] ?? "");
        const query = (details.url.split("?")[1] ?? "").replace(/=[^&]*/g, "=…");
        logStartup(
          `webRequest:license-headers ${details.method} ${details.url.replace(/\?.*$/, "")} | ` +
            `origin=${pick("Origin")} referer=${pick("Referer")} ` +
            `ua=${pick("User-Agent").slice(0, 32)} ` +
            `cookie=${pick("Cookie") ? "present" : "none"} ` +
            `authorization=${pick("Authorization") ? "present" : "none"} ` +
            `query=[${query}]`
        );
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // Echo the real origin back in Access-Control-Allow-Origin so the browser's CORS
  // check passes regardless of whether the request came from our app or the widget iframe.
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const soundCloudHost = getTrustedSoundCloudPlaybackHost(details.url);
    if (soundCloudHost) {
      const headers = details.responseHeaders || {};
      delete headers["access-control-allow-origin"];
      delete headers["Access-Control-Allow-Origin"];
      const actualOrigin = actualOrigins.get(details.id);
      actualOrigins.delete(details.id);
      headers["Access-Control-Allow-Origin"] = [actualOrigin || SPOOFED_ORIGIN];
      headers["Access-Control-Allow-Credentials"] = ["true"];
      logStartup(`webRequest:cors ${details.statusCode} ${details.url.replace(/\?.*$/, "")} | acao=${actualOrigin || SPOOFED_ORIGIN}`);
      callback({ responseHeaders: headers });
    } else {
      callback({ responseHeaders: details.responseHeaders });
    }
  });

  window.once("ready-to-show", () => {
    logStartup("createMainWindow:ready-to-show");
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });

  try {
    if (process.env.VITE_DEV_SERVER_URL) {
      logStartup("createMainWindow:load-url", process.env.VITE_DEV_SERVER_URL);
      await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      const rendererPath = path.join(moduleDirectory, "../dist/index.html");
      logStartup("createMainWindow:load-file", rendererPath);
      await window.loadFile(rendererPath);
    }
    logStartup("createMainWindow:load-complete");

    // DevTools never auto-opens — it's available on demand via F12 or Ctrl/Cmd+Shift+I.

    try {
      const bridgeDetected = await window.webContents.executeJavaScript(
        "typeof window.spotCloud !== 'undefined'",
        true
      );
      logStartup(`createMainWindow:bridge-detected:${bridgeDetected ? "yes" : "no"}`);
    } catch (error) {
      logStartup("createMainWindow:bridge-check-failed", error);
    }
  } catch (error) {
    logStartup("createMainWindow:load-failed", error);
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      "AMP startup failed",
      `The desktop shell could not load its interface.\n\n${message}`
    );
    throw error;
  }

  if (!window.isDestroyed() && !window.isVisible()) {
    logStartup("createMainWindow:show-after-load");
    window.show();
    window.focus();
  }

  registerWindowShortcuts(window);
  logStartup("createMainWindow:done");
  return window;
}

if (singleInstanceLock) {
  app.on("second-instance", (_event, argv) => {
    const protocolUrl = argv.find((arg) =>
      protocolSchemes.some((scheme) => arg.startsWith(`${scheme}://`))
    );
    if (protocolUrl) {
      handleProtocolCallback(protocolUrl);
    }
    // Relaunching while AMP sits in the tray should just bring it back (recreating if needed).
    showMainWindow();
  });
}

// Prevent NVIDIA GeForce Experience / Instant Replay from treating the app as a game.
app.on("open-url", (event, rawUrl) => {
  event.preventDefault();
  handleProtocolCallback(rawUrl);
});

// Widevine CDM readiness, surfaced to the renderer so the first-launch "secure playback" intro can
// reflect the real castLabs `components.whenReady()` install rather than faking it.
let widevineReady = false;
let widevineStatusText = "";

app.whenReady().then(async () => {
  logStartup("app:whenReady");
  if (usesCustomWindowChrome()) {
    Menu.setApplicationMenu(null);
  }
  registerCustomProtocolClient();
  await initializeEnv();

  // Construct the gateway and start warming it (cache hydrate + SoundCloud asset-bundle scrape) in
  // the BACKGROUND. Awaiting it here used to delay the window by the full scrape ("takes a minute
  // to initialize"). Requests lazily await the bundle, so this is safe to run unblocked.
  providerGateway = new ProviderGateway(app.getPath("userData"));
  void providerGateway
    .initialize()
    .then(() => {
      logStartup("gateway:initialized");
    })
    .catch((error) => logStartup("gateway:initialization-failed", error));

  localMusicManager = new LocalMusicManager(app.getPath("userData"));
  void localMusicManager.initialize().catch((error) => logStartup("local-music:init-failed", error));
  registerMediaProtocols();
  // Warm the YouTube player host so the first YT play is instant.
  void ensureYouTubePlayerOrigin().catch((error) => logStartup("youtube-player:warm-failed", error));

  // Show a lightweight non-EME window while castLabs installs or verifies the CDM. The main
  // renderer still waits for readiness, but a cold/offline component check no longer looks like a
  // failed launch.
  const startupWindow = createStartupWindow();

  // castLabs ECS (electron-releases +wvcus) installs the Widevine CDM on demand through the
  // components service. It MUST be ready BEFORE the BrowserWindow loads any EME content, otherwise
  // the CDM initialises late/unverified — which makes the Spotify Web Playback SDK play only its
  // pre-buffered ~10s and then stall, and SoundCloud's monetized (ctr-encrypted-hls) tracks fail
  // to decrypt. Awaiting it here is the castLabs-documented requirement; the try/catch keeps a CDM
  // hiccup from blocking the whole app (components.whenReady can resolve slowly on first run).
  const widevineInitialization = components
    .whenReady()
    .then(() => {
      widevineReady = true;
      widevineStatusText = JSON.stringify(components.status());
      logStartup(`widevine:components-ready:${widevineStatusText}`);
    })
    .catch((error) => logStartup("widevine:components-failed", error));
  try {
    await Promise.race([
      widevineInitialization,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          logStartup("widevine:components-timeout:continuing-degraded");
          resolve();
        }, 12_000);
      })
    ]);

    await createMainWindow();
  } finally {
    if (!startupWindow.isDestroyed()) {
      startupWindow.destroy();
    }
  }
  createTray();
  registerMediaKeys();

  const launchProtocolUrl = process.argv.find((arg) =>
    protocolSchemes.some((scheme) => arg.startsWith(`${scheme}://`))
  );
  if (launchProtocolUrl) {
    handleProtocolCallback(launchProtocolUrl);
  }

  app.on("activate", async () => {
    if (!mainWindow || mainWindow.isDestroyed() || BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
  });
}).catch((error) => {
  logStartup("app:whenReady-failed", error);
});

app.on("before-quit", () => {
  // Any path that genuinely quits (OS shutdown, installer, Cmd+Q) must bypass close-to-tray.
  isQuitting = true;
  discordPresence.stop();
  globalShortcut.unregisterAll();
  stopYouTubePlayerServer();
  // Persist pending gateway-cache writes now — the 2s debounce alone drops them on quit.
  // Synchronous on purpose: an async write started here can be cut off when the process exits.
  providerGateway?.flushCache();
});

app.on("window-all-closed", () => {
  logStartup("app:window-all-closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

process.on("uncaughtException", (error) => {
  logStartup("process:uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  logStartup("process:unhandledRejection", reason);
});

type IpcInvokeHandler = Parameters<typeof ipcMain.handle>[1];
const rawIpcHandle = ipcMain.handle.bind(ipcMain);

function handleTrustedIpc(channel: string, listener: IpcInvokeHandler): void {
  rawIpcHandle(channel, (event, ...args) => {
    const senderFrame = event.senderFrame;
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents ||
      !senderFrame ||
      senderFrame !== mainWindow.webContents.mainFrame ||
      !isTrustedMainWindowUrl(senderFrame.url)
    ) {
      logStartup(`ipc:blocked-untrusted-sender:${channel}`);
      throw new Error("IPC request denied.");
    }
    return listener(event, ...args);
  });
}

function assertOAuthProvider(value: unknown): asserts value is Provider {
  if (value !== "spotify" && value !== "soundcloud") {
    throw new Error("Unsupported account provider.");
  }
}

handleTrustedIpc("spot-cloud:get-runtime-info", async () => buildRuntimeInfo());

handleTrustedIpc("spot-cloud:get-widevine-status", async () => ({
  ready: widevineReady,
  statusText: widevineStatusText
}));

handleTrustedIpc("spot-cloud:reload-runtime", async () => {
  await reloadManagedDesktopEnv();
  return buildRuntimeInfo();
});

handleTrustedIpc("spot-cloud:get-soundcloud-public-client-id", async () =>
  getSoundCloudPublicClientId()
);

handleTrustedIpc("spot-cloud:get-desktop-config", async () => readDesktopConfig());

handleTrustedIpc("spot-cloud:save-desktop-config", async (_, config: unknown) =>
  writeDesktopConfig(parseDesktopConfig(config))
);

handleTrustedIpc("spot-cloud:open-config-directory", async () => {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await shell.openPath(app.getPath("userData"));
  return true;
});

handleTrustedIpc("spot-cloud:list-provider-sessions", async () => getStoredProviderSessionStatuses());

handleTrustedIpc("spot-cloud:clear-provider-session", async (_, provider: Provider) => {
  assertOAuthProvider(provider);
  await clearLocalProviderSession(provider);
});

handleTrustedIpc("spot-cloud:refresh-provider-session", async (_, request: OAuthRequest) => {
  assertOAuthProvider(request?.provider);
  return refreshProviderSession(request.provider);
});

handleTrustedIpc("spot-cloud:open-external", async (_, url: string) => {
  return openAllowedExternalUrl(url);
});

handleTrustedIpc("spot-cloud:resolve-artwork", async (_, request: ArtworkRequest) => {
  return resolveArtworkAsset(request);
});

handleTrustedIpc("spot-cloud:get-window-state", async () => getDesktopWindowState());

handleTrustedIpc("spot-cloud:finish-startup-window", async () => {
  mainWindowStartupComplete = true;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setMinimumSize(mainWindowMinimumBounds.width, mainWindowMinimumBounds.height);
    mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  }

  return getDesktopWindowState();
});

handleTrustedIpc("spot-cloud:minimize-window", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

handleTrustedIpc("spot-cloud:toggle-maximize-window", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }

  return getDesktopWindowState();
});

handleTrustedIpc("spot-cloud:close-window", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});

// Mini-player: shrink the window to a small always-on-top now-playing card (and back). Audio keeps
// playing because it's the same window/renderer — we only change the window's size + the React view.
let compactRestoreBounds: { x: number; y: number; width: number; height: number } | undefined;
let compactWasMaximized = false;
// Explicit mode flag — inferring "already compact" from window properties (e.g. resizability)
// breaks the moment any other feature toggles the same property.
let isCompactMode = false;
handleTrustedIpc("spot-cloud:set-compact-mode", async (_, compact: boolean) => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    return { compact: false };
  }
  if (compact) {
    if (!isCompactMode) {
      // Only capture restore bounds on a real full→compact transition; a repeated compact call
      // would otherwise overwrite them with the mini size and "restore" to a 384×116 window.
      compactWasMaximized = win.isMaximized();
      if (compactWasMaximized) {
        win.unmaximize();
      }
      compactRestoreBounds = win.getBounds();
    }
    isCompactMode = true;
    const width = 384;
    const height = 116;
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setMinimumSize(320, 96);
    win.setResizable(false);
    win.setBounds({
      width,
      height,
      x: area.x + area.width - width - 24,
      y: area.y + area.height - height - 24
    });
    win.setAlwaysOnTop(true, "floating");
  } else {
    isCompactMode = false;
    win.setAlwaysOnTop(false);
    win.setResizable(true);
    win.setMinimumSize(mainWindowMinimumBounds.width, mainWindowMinimumBounds.height);
    if (compactWasMaximized) {
      win.maximize();
    } else if (compactRestoreBounds) {
      win.setBounds(compactRestoreBounds);
    }
    win.focus();
  }
  return { compact };
});

handleTrustedIpc("spot-cloud:open-devtools", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
});

// Custom media protocol handler: amp-local serves whitelisted local audio + extracted artwork.
function registerMediaProtocols(): void {
  protocol.handle("amp-local", async (request) => {
    try {
      const url = new URL(request.url);
      const kind = url.hostname; // "audio" | "art"
      const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (!localMusicManager || !id) {
        return new Response("Not found", { status: 404 });
      }
      const filePath =
        kind === "art" ? localMusicManager.resolveArtworkPath(id) : localMusicManager.resolveAudioPath(id);
      if (!filePath) {
        return new Response("Not found", { status: 404 });
      }
      // net.fetch on a file:// URL handles Range + content-type; forwarding the request headers
      // gives <audio> seeking for free.
      return net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
        method: request.method
      });
    } catch (error) {
      logStartup("amp-local:error", error);
      return new Response("Local media error", { status: 500 });
    }
  });
}

// Hardware media keys → renderer transport actions. Registered once at startup; failures are
// non-fatal (another player may already own a key).
function registerMediaKeys(): void {
  const bindings: Array<{ accelerator: string; action: "play-pause" | "next" | "previous" }> = [
    { accelerator: "MediaPlayPause", action: "play-pause" },
    { accelerator: "MediaNextTrack", action: "next" },
    { accelerator: "MediaPreviousTrack", action: "previous" }
  ];
  for (const { accelerator, action } of bindings) {
    try {
      globalShortcut.register(accelerator, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("spot-cloud:media-key", action);
        }
      });
    } catch (error) {
      logStartup(`media-keys:register-failed:${accelerator}`, error);
    }
  }
}

function registerWindowShortcuts(window: BrowserWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    if (
      (input.control || input.meta) &&
      input.shift &&
      input.key.toLowerCase() === "i" &&
      input.type === "keyDown"
    ) {
      event.preventDefault();
      window.webContents.openDevTools({ mode: "detach" });
    }
    if (input.key === "F12" && input.type === "keyDown") {
      event.preventDefault();
      window.webContents.openDevTools({ mode: "detach" });
    }
  });
}

handleTrustedIpc("spot-cloud:connect-provider", async (_, request: OAuthRequest) => {
  assertOAuthProvider(request?.provider);
  if (request.provider === "spotify") {
    return connectSpotify();
  }

  return connectSoundCloud();
});

handleTrustedIpc("spot-cloud:cancel-connect-provider", (_, provider: Provider) => {
  assertOAuthProvider(provider);
  providerSessionEpoch.set(provider, getProviderSessionEpoch(provider) + 1);
  // Aborts an in-flight sign-in wait if one exists; no-op otherwise. The wait resolves with the
  // cancel marker, so connectSpotify/connectSoundCloud reject and the renderer returns to idle.
  pendingAuthCancellers.get(provider)?.();
  return { ok: true };
});

handleTrustedIpc("spot-cloud:gateway-request", async (_, request) => {
  if (!providerGateway) {
    return { ok: false, error: "Provider gateway not initialized.", source: "fallback" };
  }
  // Minimal shape check so a malformed payload gets a structured failure instead of whatever the
  // gateway internals happen to throw on it.
  if (
    !request ||
    typeof request !== "object" ||
    typeof (request as { provider?: unknown }).provider !== "string" ||
    typeof (request as { operation?: unknown }).operation !== "string"
  ) {
    return { ok: false, error: "Malformed gateway request.", source: "fallback" };
  }

  try {
    return await providerGateway.request(request);
  } catch (error) {
    logStartup("gateway:request-failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Gateway request failed.",
      source: "fallback"
    };
  }
});

// ── Local music ──────────────────────────────────────────────────────────────────────────────
handleTrustedIpc("spot-cloud:local-music-list-folders", async () => {
  return (await localMusicManager?.getFolders()) ?? [];
});

handleTrustedIpc("spot-cloud:local-music-add-folder", async () => {
  // Open a native folder picker; returns the updated folder list (unchanged if cancelled).
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = parent
    ? await dialog.showOpenDialog(parent, { properties: ["openDirectory"] })
    : await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0 || !localMusicManager) {
    return (await localMusicManager?.getFolders()) ?? [];
  }
  return localMusicManager.addFolder(result.filePaths[0]);
});

handleTrustedIpc("spot-cloud:local-music-remove-folder", async (_, folder: string) => {
  return (await localMusicManager?.removeFolder(folder)) ?? [];
});

handleTrustedIpc("spot-cloud:local-music-scan", async () => {
  if (!localMusicManager) {
    return { ok: false, error: "Local music is not available.", tracks: [] as UnifiedTrack[] };
  }
  try {
    const tracks = await localMusicManager.scan();
    return { ok: true, tracks };
  } catch (error) {
    logStartup("local-music:scan-failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Local music scan failed.",
      tracks: [] as UnifiedTrack[]
    };
  }
});

// The loopback origin hosting the YouTube IFrame player page. The renderer embeds it in a hidden
// iframe (the YT player won't init from the file:// renderer origin, but works from http://127.0.0.1).
handleTrustedIpc("spot-cloud:youtube-player-origin", async () => {
  try {
    return await ensureYouTubePlayerOrigin();
  } catch (error) {
    logStartup("youtube-player:server-failed", error);
    return undefined;
  }
});

handleTrustedIpc("spot-cloud:get-anonymous-spotify-session", async () => {
  if (!providerGateway) {
    return undefined;
  }
  try {
    return await providerGateway.getAnonymousSpotifySession();
  } catch (error) {
    logStartup("gateway:anonymous-session-failed", error);
    return undefined;
  }
});

// Silently re-load the library if a SoundCloud web session is already stored (no pop-up).
handleTrustedIpc("spot-cloud:soundcloud-web-reload", async () => {
  const token = await readSoundCloudWebToken();
  if (!token) {
    return { ok: false, error: "No stored SoundCloud session.", source: "internal" };
  }
  return resolveSoundCloudWebLibrary(token);
});

handleTrustedIpc("spot-cloud:soundcloud-web-has-session", async () => {
  return Boolean(await readSoundCloudWebToken());
});

handleTrustedIpc("spot-cloud:soundcloud-web-set-track-liked", async (_, request: SoundCloudTrackLikeRequest) => {
  return setSoundCloudWebTrackLiked(request);
});

handleTrustedIpc("spot-cloud:soundcloud-web-signout", async () => {
  await clearSoundCloudWebSession();
  return { ok: true };
});

handleTrustedIpc("spot-cloud:soundcloud-local-list-profiles", async () => {
  try {
    return { ok: true, data: await listSoundCloudBrowserProfiles(), source: "internal" as const };
  } catch (error) {
    logStartup("soundcloud:local-connect:list-profiles-failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not find local browser profiles.",
      source: "internal" as const
    };
  }
});

handleTrustedIpc("spot-cloud:soundcloud-local-connect", async (_, request: SoundCloudLocalConnectRequest) => {
  try {
    // `return await` (not bare `return`) so an async rejection is caught HERE and returned as
    // the { ok:false } shape the renderer expects, instead of rejecting its invoke promise.
    return await connectSoundCloudBrowserProfile(request);
  } catch (error) {
    logStartup("soundcloud:local-connect:failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "SoundCloud Local Connect failed.",
      source: "internal" as const
    };
  }
});

handleTrustedIpc("spot-cloud:soundcloud-local-open-signin", async (_, request: SoundCloudLocalConnectRequest) => {
  try {
    const profiles = await listSoundCloudBrowserProfiles();
    const selectedProfile = profiles.find((profile) => profile.id === request.profileId);
    if (!selectedProfile) {
      return { ok: false, error: "Browser profile not found.", source: "internal" as const };
    }
    await openProfileBrowserToUrl(selectedProfile, SOUNDCLOUD_SIGNIN_URL);
    return { ok: true, data: { opened: true }, source: "internal" as const };
  } catch (error) {
    logStartup("soundcloud:local-connect:open-signin-failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not open the browser sign-in page.",
      source: "internal" as const
    };
  }
});

handleTrustedIpc("spot-cloud:soundcloud-local-close-browser", async (_, request: SoundCloudLocalConnectRequest) => {
  try {
    const profiles = await listSoundCloudBrowserProfiles();
    const selectedProfile = profiles.find((profile) => profile.id === request.profileId);
    if (!selectedProfile?.executablePath) {
      return { ok: false, error: "Browser profile not found.", source: "internal" as const };
    }
    const closed = await closeBrowserByExecutable(selectedProfile.executablePath);
    return { ok: closed, data: { closed }, source: "internal" as const };
  } catch (error) {
    logStartup("soundcloud:local-connect:close-browser-failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not close the browser.",
      source: "internal" as const
    };
  }
});

handleTrustedIpc("spot-cloud:download-soundcloud-track", async (_, request: { track: UnifiedTrack }) => {
  try {
    const result = await downloadSoundCloudTrack(request.track);
    if (result.ok && result.path) {
      // Reveal the finished file so the user can grab it for "whatever other use".
      shell.showItemInFolder(result.path);
    }
    return result;
  } catch (error) {
    logStartup("soundcloud:download:failed", error);
    return { ok: false, error: error instanceof Error ? error.message : "Download failed." };
  }
});

handleTrustedIpc("spot-cloud:soundcloud-system-browser-signin", async () => {
  try {
    return await signInSoundCloudViaSystemBrowser();
  } catch (error) {
    logStartup("soundcloud:system-browser-signin:failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "SoundCloud sign-in failed.",
      source: "internal" as const
    };
  }
});

handleTrustedIpc("spot-cloud:soundcloud-in-app-signin", async () => {
  try {
    return await signInSoundCloudInApp();
  } catch (error) {
    logStartup("soundcloud:in-app-signin:failed", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "SoundCloud sign-in failed.",
      source: "internal" as const
    };
  }
});

handleTrustedIpc("spot-cloud:soundcloud-local-set-track-liked", async (_, request: SoundCloudTrackLikeRequest) => {
  return setSoundCloudLocalTrackLiked(request);
});

handleTrustedIpc("spot-cloud:set-discord-presence", (_, payload: unknown) => {
  if (!discordPresenceEnabled) {
    // setActivity() on a stopped client would re-arm connection attempts — refuse while disabled.
    return { ok: false };
  }
  discordPresence.setActivity(discordActivityFromPayload(parseDiscordPresencePayload(payload)));
  return { ok: true };
});

handleTrustedIpc("spot-cloud:set-discord-presence-enabled", (_, enabled: boolean) => {
  discordPresenceEnabled = enabled === true;
  if (discordPresenceEnabled) {
    discordPresence.start(getDiscordClientId());
    logStartup("discord:presence-enabled");
  } else {
    // Order matters: null first clears the stored `desired` activity (stop() does not), so a
    // stale card can never be re-sent by a later start(). stop() closes the pipe — which is what
    // wipes the presence on Discord's side — and cancels the 15s reconnect timer.
    discordPresence.setActivity(null);
    discordPresence.stop();
    logStartup("discord:presence-disabled");
  }
  return { ok: true };
});
