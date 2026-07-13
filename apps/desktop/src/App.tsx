import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  memo,
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { AnimatePresence, MotionConfig, Reorder, motion } from "framer-motion";
import { spring, tween, panelVariants, modalVariants } from "@/lib/motion";
import { HashRouter, NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Disc3,
  Download,
  ExternalLink,
  Headphones,
  Heart,
  HeartOff,
  Home,
  Info,
  Library,
  Link2,
  ListMusic,
  ListPlus,
  ListX,
  LoaderCircle,
  LogIn,
  LogOut,
  Maximize2,
  Minimize2,
  Monitor,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCcw,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  SkipBack,
  SkipForward,
  Shuffle,
  ShieldCheck,
  Trash2,
  Unlink2,
  UserRound,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import type { OAuthProvider, ProjectTrack, Provider, UnifiedTrack } from "@amp/core";
import {
  finishDesktopStartupWindow,
  openExternal,
  openDevTools,
  setDiscordPresence,
  setDiscordPresenceEnabled as pushDiscordPresenceEnabled,
  setDesktopCompactMode,
  subscribeMediaKeys,
  type RuntimeInfo
} from "@/lib/desktopBridge";
import {
  loadListeningStats,
  clearListeningStats,
  BEAT_INTENSITY_MAX,
  type AccentSource,
  type ListeningStats
} from "@/lib/localStore";
import { audioReactor } from "@/lib/audioReactor";
import { ArtworkImage } from "@/components/ArtworkImage";
import { VirtualList } from "@/components/VirtualList";
import { DesktopTitleBar } from "@/components/DesktopTitleBar";
import { cn, displayCreators, displayTitle, formatClock, formatDuration, providerLabel } from "@/lib/utils";
import type { HomeMix } from "@/lib/mixes/composition";
import {
  featuresFor,
  TEMPO_BUCKET_LABELS,
  TEMPO_BUCKET_ORDER,
  type TempoBucket
} from "@/lib/trackFeatures";
import { useAppStore } from "@/state/useAppStore";

const navItems = [
  { to: "/", label: "Home", icon: Home },
  { to: "/search", label: "Search", icon: Search },
  { to: "/library", label: "Library", icon: Library },
  { to: "/playlists", label: "Playlists", icon: ListMusic },
  { to: "/stats", label: "Stats", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings }
];

const volumeProviders: Provider[] = ["spotify", "soundcloud"];

const providerConsentCopy: Record<
  OAuthProvider,
  {
    title: string;
    summary: string;
    access: string[];
    caution: string;
    confirmLabel: string;
  }
> = {
  spotify: {
    title: "Review Spotify access",
    summary:
      "Spotify sign-in opens in your default browser and returns to AMP. The app only asks for the scopes needed for in-app playback and library import.",
    access: [
      "Read your Spotify profile basics so the app can label your connected account.",
      "Read your saved library and playback state for search, queue handoff, and resume.",
      "Control in-app Spotify playback from inside AMP.",
      "No playlist-edit permission is requested, and your mixed playlists stay inside AMP."
    ],
    caution:
      "Spotify shows its official consent screen in your browser, then returns the result to the desktop app.",
    confirmLabel: "Open Spotify sign-in"
  },
  soundcloud: {
    title: "Review SoundCloud access",
    summary:
      "SoundCloud sign-in opens in your default browser and returns to AMP after approval. This stays limited to account linking, playlist and likes import, and playback-ready API access.",
    access: [
      "Read your SoundCloud account basics so the connection can be named correctly.",
      "Search playable API-enabled tracks and fetch stream URLs for in-app playback.",
      "Refresh the connection when tokens expire so you do not have to reconnect every launch."
    ],
    caution:
      "SoundCloud shows its own authorization page in your browser so it can reuse an existing signed-in session.",
    confirmLabel: "Open SoundCloud sign-in"
  }
};

function getProviderConfigStatus(runtime: RuntimeInfo | undefined, provider: OAuthProvider) {
  if (!runtime || runtime.platform === "browser") {
    return {
      ready: false,
      value: "desktop bridge unavailable",
      message:
        "Launch the packaged Electron app to use provider OAuth instead of the browser preview."
    };
  }

  const providerStatus = runtime.oauth[provider];
  return {
    ready: providerStatus.configured,
    value: providerStatus.hasStoredSession
      ? `${providerStatus.storageMode} session available`
      : providerStatus.configured
        ? `${providerStatus.storageMode === "memory-only" ? "session is memory-only" : "no stored session yet"}`
        : provider === "spotify"
          ? "SPOTIFY_CLIENT_ID missing"
          : "SOUNDCLOUD_CLIENT_ID or SOUNDCLOUD_CLIENT_SECRET missing",
    message: providerStatus.message
  };
}

function getStorageBadgeText(runtime: RuntimeInfo | undefined, provider: OAuthProvider) {
  if (!runtime) {
    return "checking storage";
  }

  const mode = runtime.oauth[provider].storageMode;
  if (mode === "local-secure") {
    return "secure local storage";
  }
  if (mode === "memory-only") {
    return "memory-only session";
  }
  if (runtime.oauth[provider].hasStoredSession) {
    return "session saved for reconnect";
  }
  return "no stored session";
}

function getCollectionKindLabel(kind: "saved-tracks" | "likes" | "playlist"): string {
  if (kind === "saved-tracks") {
    return "Saved tracks";
  }

  if (kind === "likes") {
    return "Likes";
  }

  return "Playlist";
}

function getTrackUiKey(track: Pick<UnifiedTrack, "provider" | "providerTrackId" | "id">): string {
  return `${track.provider}:${track.providerTrackId || track.id}`;
}


/** Weaves two track lists together at a given ratio, capped at `limit`. */
function interleaveTracks(
  primary: UnifiedTrack[],
  secondary: UnifiedTrack[],
  primaryRun: number,
  secondaryRun: number,
  limit: number
): UnifiedTrack[] {
  const out: UnifiedTrack[] = [];
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

/**
 * Builds blended Spotify×SoundCloud "mixes" from the imported library. Returns an empty list
 * unless BOTH providers have tracks — so mixes only appear once both are connected, never faked.
 */
function buildHomeMixes(projectTracks: ProjectTrack[]): HomeMix[] {
  const spotify = projectTracks.filter((item) => item.provider === "spotify").map((item) => item.track);
  const soundcloud = projectTracks
    .filter((item) => item.provider === "soundcloud")
    .map((item) => item.track);

  if (spotify.length === 0 || soundcloud.length === 0) {
    return [];
  }

  const LIMIT = 60;
  return [
    {
      id: "mix-even",
      kind: "blend" as const,
      title: "Even Blend",
      subtitle: "Spotify and SoundCloud, one for one",
      tracks: interleaveTracks(spotify, soundcloud, 1, 1, LIMIT)
    },
    {
      id: "mix-soundcloud",
      kind: "blend" as const,
      title: "SoundCloud Lean",
      subtitle: "Mostly SoundCloud with Spotify woven in",
      tracks: interleaveTracks(soundcloud, spotify, 2, 1, LIMIT)
    },
    {
      id: "mix-spotify",
      kind: "blend" as const,
      title: "Spotify Lean",
      subtitle: "Mostly Spotify with SoundCloud picks",
      tracks: interleaveTracks(spotify, soundcloud, 2, 1, LIMIT)
    }
  ].filter((mix) => mix.tracks.length >= 4);
}

/** Fills a range input up to `percent` with the accent colour (progress look). */
function sliderFill(percent: number): CSSProperties {
  const p = Math.max(0, Math.min(100, percent));
  return {
    background: `linear-gradient(to right, var(--acid) ${p}%, rgba(255,255,255,0.14) ${p}%)`
  };
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const DEFAULT_ACCENT = "#e8e4da";

/**
 * Tints the GUI accent (`--acid`) toward the current song's artwork colour, so the otherwise
 * monotone UI takes on the song's colour. Reverts to the monotone default when nothing plays.
 */
// Mirrors the now-playing track to Discord Rich Presence. Renders nothing; re-pushes only when the
// track, play/pause state, or the enable flag changes (position is read imperatively so it doesn't
// fire every tick). Presence is opt-in: when disabled, main holds no Discord connection at all.
function DiscordPresenceSync() {
  const currentTrack = useAppStore((state) => state.playback.queue[state.playback.currentIndex]);
  const status = useAppStore((state) => state.playback.status);
  const enabled = useAppStore((state) => state.discordPresenceEnabled);
  const trackKey = currentTrack
    ? `${currentTrack.provider}:${currentTrack.providerTrackId || currentTrack.id}`
    : "";

  // Boot push: main no longer auto-connects, so tell it the persisted flag once. Idempotent —
  // this component mounts in two mutually exclusive trees (full shell and compact mini-player).
  useEffect(() => {
    void pushDiscordPresenceEnabled(useAppStore.getState().discordPresenceEnabled);
  }, []);

  useEffect(() => {
    if (!enabled || !currentTrack || (status !== "playing" && status !== "paused")) {
      void setDiscordPresence(null);
      return;
    }
    const { positionMs } = useAppStore.getState().playback;
    void setDiscordPresence({
      title: currentTrack.title,
      artists: currentTrack.creators.join(", "),
      album: currentTrack.album,
      provider: currentTrack.provider,
      status,
      startedAtMs: Date.now() - positionMs,
      artworkUrl: currentTrack.artworkUrl,
      externalUrl: currentTrack.externalUrl
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- position read imperatively on purpose
  }, [trackKey, status, enabled]);

  return null;
}

/**
 * Global transport hotkeys — Space play/pause, Ctrl/Cmd+→ next, Ctrl/Cmd+← previous — plus
 * hardware media keys forwarded from the main process. Renders nothing.
 */
function PlaybackHotkeys() {
  const togglePlayback = useAppStore((state) => state.togglePlayback);
  const next = useAppStore((state) => state.next);
  const previous = useAppStore((state) => state.previous);

  useEffect(() => {
    const isInteractiveTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      if (!element) {
        return false;
      }
      // Buttons and role="button" cards keep their native Space activation; text fields keep
      // typing. closest() covers focus landing on a child of an interactive wrapper.
      return Boolean(
        element.isContentEditable ||
          element.closest?.('input, textarea, select, button, [role="button"], [contenteditable="true"]')
      );
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isInteractiveTarget(event.target)) {
        return;
      }
      if (
        event.code === "Space" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        void togglePlayback();
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        void next();
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        void previous();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlayback, next, previous]);

  useEffect(
    () =>
      subscribeMediaKeys((action) => {
        if (action === "play-pause") {
          void togglePlayback();
        } else if (action === "next") {
          void next();
        } else {
          void previous();
        }
      }),
    [togglePlayback, next, previous]
  );

  return null;
}

function SongColor() {
  const artworkUrl = useAppStore(
    (state) => state.playback.queue[state.playback.currentIndex]?.artworkUrl
  );
  const accentSource = useAppStore((state) => state.accentSource);
  const runtime = useAppStore((state) => state.runtime);
  const beatIntensity = useAppStore((state) => state.beatIntensity);
  const status = useAppStore((state) => state.playback.status);
  // The song's artwork colour is the fixed hue; audio mode only pulses its saturation/brightness.
  const baseColorRef = useRef<{ r: number; g: number; b: number }>({ r: 232, g: 228, b: 218 });

  // Mirror the user's beat-pulse strength onto :root so the GPU beat layer can scale itself.
  useEffect(() => {
    document.documentElement.style.setProperty("--beat-intensity", String(beatIntensity));
  }, [beatIntensity]);

  // Audio-reactive accent + beat-pulsed gradient. The reactor reads AMP's output via Windows
  // system-audio loopback for EVERY source (Spotify + SoundCloud alike) — it deliberately no longer
  // taps the SoundCloud media element, because routing playback through Web Audio silenced/locked
  // certain SoundCloud streams. The reactor writes CSS vars per animation frame — no React renders.
  useEffect(() => {
    if (accentSource !== "audio" || runtime?.platform !== "win32" || status !== "playing") {
      audioReactor.stop();
      return;
    }
    audioReactor.start();
    return () => audioReactor.stop();
  }, [accentSource, runtime?.platform, status]);

  // Leaving audio mode releases the system-audio capture entirely (and re-arms a future retry).
  useEffect(() => {
    if (accentSource !== "audio") {
      audioReactor.releaseLoopback();
    }
  }, [accentSource]);

  // A saved audio-reactive preference still needs one fresh user gesture after restart before
  // Chromium will grant loopback. Prime on the next click or tap anywhere in AMP.
  useEffect(() => {
    if (accentSource !== "audio" || runtime?.platform !== "win32") {
      return;
    }
    const prime = () => audioReactor.primeLoopback();
    window.addEventListener("pointerdown", prime, { capture: true, once: true });
    return () => window.removeEventListener("pointerdown", prime, { capture: true });
  }, [accentSource, runtime?.platform]);

  // Artwork colour is the baseline (and the full answer in "artwork" mode, or for Spotify).
  // "static" mode opts out entirely: the UI stays on the fixed neutral accent regardless of art.
  useEffect(() => {
    const root = document.documentElement;
    if (accentSource === "static" || !artworkUrl) {
      baseColorRef.current = { r: 232, g: 228, b: 218 };
      root.style.setProperty("--acid", DEFAULT_ACCENT);
      root.style.setProperty("--song-rgb", "232, 228, 218");
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        // Prefer reasonably saturated, non-black pixels for a vivid accent.
        for (let i = 0; i < data.length; i += 4) {
          const R = data[i];
          const G = data[i + 1];
          const B = data[i + 2];
          const max = Math.max(R, G, B);
          const min = Math.min(R, G, B);
          const sat = max === 0 ? 0 : (max - min) / max;
          if (sat > 0.28 && max > 45) {
            r += R;
            g += G;
            b += B;
            count++;
          }
        }
        if (count < 4) {
          r = g = b = count = 0;
          for (let i = 0; i < data.length; i += 4) {
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
          }
        }
        r = Math.round(r / count);
        g = Math.round(g / count);
        b = Math.round(b / count);

        // Lift dark colours so accent text/buttons stay legible.
        const m = Math.max(r, g, b);
        if (m > 0 && m < 170) {
          const k = 170 / m;
          r = Math.min(255, Math.round(r * k));
          g = Math.min(255, Math.round(g * k));
          b = Math.min(255, Math.round(b * k));
        }
        baseColorRef.current = { r, g, b };
        root.style.setProperty("--acid", `rgb(${r}, ${g}, ${b})`);
        root.style.setProperty("--song-rgb", `${r}, ${g}, ${b}`);
      } catch {
        root.style.setProperty("--acid", DEFAULT_ACCENT);
      }
    };
    img.onerror = () => {
      if (!cancelled) root.style.setProperty("--acid", DEFAULT_ACCENT);
    };
    img.src = artworkUrl;

    return () => {
      cancelled = true;
    };
  }, [artworkUrl, accentSource]);

  return null;
}

export function App() {
  const initialize = useAppStore((state) => state.initialize);
  const initialized = useAppStore((state) => state.initialized);
  const playlists = useAppStore((state) => state.playlists);
  const selectedPlaylistId = useAppStore((state) => state.selectedPlaylistId);
  const selectPlaylist = useAppStore((state) => state.selectPlaylist);
  const runtime = useAppStore((state) => state.runtime);
  const queueLength = useAppStore((state) => state.playback.queue.length);
  const onboardingComplete = useAppStore((state) => state.onboardingComplete);
  const createPlaylist = useAppStore((state) => state.createPlaylist);
  const addTrackToPlaylist = useAppStore((state) => state.addTrackToPlaylist);
  const [queueOpen, setQueueOpen] = useState(true);
  const [compact, setCompact] = useState(false);
  // "Add to playlist…" target picked from the global right-click menu (any page, incl. the queue).
  const [menuPlaylistTrack, setMenuPlaylistTrack] = useState<UnifiedTrack | undefined>();
  const enterCompact = () => {
    void setDesktopCompactMode(true);
    setCompact(true);
  };
  const exitCompact = () => {
    void setDesktopCompactMode(false);
    setCompact(false);
  };
  const showCustomChrome =
    runtime?.platform === "win32" ||
    runtime?.platform === "linux" ||
    (!runtime && typeof navigator !== "undefined" && /Windows|Linux/i.test(navigator.userAgent));
  const showQueue = queueOpen && queueLength > 0;

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (initialized) {
      void finishDesktopStartupWindow();
    }
  }, [initialized]);

  useEffect(() => {
    if (!selectedPlaylistId && playlists.length > 0) {
      selectPlaylist(playlists[0].id);
    }
  }, [playlists, selectedPlaylistId, selectPlaylist]);

  if (!initialized) {
    return <StartupSplash showCustomChrome={showCustomChrome} />;
  }

  if (!onboardingComplete) {
    return <Onboarding showCustomChrome={showCustomChrome} />;
  }

  if (compact) {
    return (
      <MotionConfig reducedMotion="user">
        <SongColor />
        <DiscordPresenceSync />
        <PlaybackHotkeys />
        <MiniPlayer onExpand={exitCompact} />
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
    <HashRouter>
      <div className="flex h-screen flex-col overflow-hidden text-[var(--ink)]">
        {/* Two viewport-fixed background layers behind everything (body paints --shell). The side
            panels are translucent (see .glass-panel) so both show through them — one continuous
            top-left song sky across sidebar → content → Now Playing rail.
            Layer 1: the static base wash (transitions colour per track, never per frame).
            Layer 2: the beat glow — the audio reactor writes --beat/--energy (0 when idle/paused/
            artwork mode) and ONLY this layer's opacity + transform read them. Both are GPU-
            composited, so the pulse costs no layout or paint and never restyles the rest of the UI
            (rewriting app-wide accent vars per frame was what made the app lag). */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10 transition-[background] duration-700"
          style={{
            background:
              "radial-gradient(150% 105% at 0% -12%, rgba(var(--song-rgb), 0.26), rgba(var(--song-rgb), 0.1) 46%, transparent 78%)"
          }}
        />
        <div
          id="amp-beat-layer"
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10"
          style={{
            background:
              "radial-gradient(150% 105% at 0% -12%, rgba(var(--song-rgb), 0.55), rgba(var(--song-rgb), 0.16) 46%, transparent 72%)",
            // --beat-intensity (user-set, default 1) scales the whole pulse: 0 = flat, 2 = double.
            opacity:
              "calc((var(--beat, 0) * 0.5 + var(--energy, 0) * 0.2) * var(--beat-intensity, 1))",
            transform: "scale(calc(1 + var(--beat, 0) * 0.04 * var(--beat-intensity, 1)))",
            transformOrigin: "0% 0%",
            willChange: "opacity, transform"
          }}
        />
        <DesktopTitleBar visible={showCustomChrome} />
        <SongColor />
        <DiscordPresenceSync />
        <PlaybackHotkeys />
        <div
          className={cn(
            "grid min-h-0 flex-1",
            showQueue ? "grid-cols-[240px_1fr_320px]" : "grid-cols-[240px_1fr]"
          )}
        >
          <motion.aside
            variants={panelVariants.left}
            initial="initial"
            animate="animate"
            transition={spring.panel}
            className="vibrancy glass-panel overflow-hidden border-r border-[var(--edge)] px-5 py-5"
          >
            <Sidebar />
          </motion.aside>
          <motion.main
            initial={panelVariants.rise.initial}
            animate={panelVariants.rise.animate}
            transition={{ ...spring.panel, delay: 0.04 }}
            className="flex min-h-0 flex-col"
          >
            <NoticeBanner />
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
              {/* No AnimatePresence/mode="wait" here: waiting for the outgoing page's exit to finish
                  before mounting the next one added ~200ms of dead air to every tab switch. Each
                  PageFrame fades itself in on mount (keyed by title), so the new page appears at once
                  and the old one is dropped in the same commit — snappy, and never two pages stacked. */}
              <Routes>
                <Route path="/" element={<PageFrame title="Home"><HomePage /></PageFrame>} />
                <Route path="/mix" element={<PageFrame title="Mix"><MixDetailPage /></PageFrame>} />
                <Route path="/artist" element={<PageFrame title="Artist"><ArtistPage /></PageFrame>} />
                <Route path="/album" element={<PageFrame title="Album"><AlbumPage /></PageFrame>} />
                <Route path="/search" element={<PageFrame title="Search"><SearchPage /></PageFrame>} />
                <Route path="/library" element={<PageFrame title="Library" fill><LibraryPage /></PageFrame>} />
                <Route path="/playlists" element={<PageFrame title="Playlists"><PlaylistsPage /></PageFrame>} />
                <Route path="/stats" element={<PageFrame title="Listening stats"><StatsPage /></PageFrame>} />
                <Route path="/settings" element={<PageFrame title="Settings"><SettingsPage /></PageFrame>} />
              </Routes>
            </div>
          </motion.main>
          {showQueue ? (
            <motion.aside
              variants={panelVariants.right}
              initial="initial"
              animate="animate"
              transition={{ ...spring.panel, delay: 0.04 }}
              className="vibrancy glass-panel min-h-0 overflow-hidden border-l border-[var(--edge)]"
            >
              <NowPlayingPanel />
            </motion.aside>
          ) : null}
        </div>
        <PlayerBar
          showQueueToggle={queueLength > 0}
          queueOpen={queueOpen}
          onToggleQueue={() => setQueueOpen((open) => !open)}
          onEnterCompact={enterCompact}
        />
        <TrackContextMenu onAddToPlaylist={setMenuPlaylistTrack} />
        <AddToPlaylistDialog
          track={menuPlaylistTrack}
          playlists={playlists}
          onClose={() => setMenuPlaylistTrack(undefined)}
          onCreatePlaylist={createPlaylist}
          onAddToPlaylists={async (playlistIds, target) => {
            for (const playlistId of playlistIds) {
              await addTrackToPlaylist(playlistId, target);
            }
          }}
        />
      </div>
    </HashRouter>
    </MotionConfig>
  );
}

function TrackContextMenu({ onAddToPlaylist }: { onAddToPlaylist(track: UnifiedTrack): void }) {
  const trackMenu = useAppStore((state) => state.trackMenu);
  const closeTrackMenu = useAppStore((state) => state.closeTrackMenu);
  const startStation = useAppStore((state) => state.startStation);
  const addToQueueNext = useAppStore((state) => state.addToQueueNext);
  const playTrack = useAppStore((state) => state.playTrack);
  const openArtist = useAppStore((state) => state.openArtist);
  const openAlbumForTrack = useAppStore((state) => state.openAlbumForTrack);
  const removeFromQueue = useAppStore((state) => state.removeFromQueue);
  const downloadTrack = useAppStore((state) => state.downloadTrack);
  const navigate = useNavigate();

  useEffect(() => {
    if (!trackMenu) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeTrackMenu();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [trackMenu, closeTrackMenu]);

  if (!trackMenu) {
    return null;
  }

  const { track, x, y, source, queueIndex } = trackMenu;
  const run = (action: () => void) => {
    action();
    closeTrackMenu();
  };

  // One menu, everywhere: every surface gets the same actions, with capability-gated extras
  // (albums only exist on Spotify; "remove" only makes sense inside the queue panel).
  const items = [
    { icon: <Play className="h-4 w-4" />, label: "Play now", action: () => void playTrack(track, [track]) },
    { icon: <Plus className="h-4 w-4" />, label: "Play next", action: () => void addToQueueNext(track) },
    { icon: <Radio className="h-4 w-4" />, label: "Start radio", action: () => void startStation(track) },
    { icon: <ListPlus className="h-4 w-4" />, label: "Add to playlist…", action: () => onAddToPlaylist(track) },
    {
      icon: <UserRound className="h-4 w-4" />,
      label: "Go to artist",
      action: () => {
        void openArtist(track);
        navigate("/artist");
      }
    },
    ...(track.provider === "spotify" && (track.albumId || track.album)
      ? [
          {
            icon: <Disc3 className="h-4 w-4" />,
            label: "Go to album",
            action: () => {
              void openAlbumForTrack(track);
              navigate("/album");
            }
          }
        ]
      : []),
    ...(track.provider === "soundcloud"
      ? [
          {
            icon: <Download className="h-4 w-4" />,
            label: "Download MP3",
            action: () => void downloadTrack(track)
          }
        ]
      : []),
    ...(source === "queue" && queueIndex !== undefined
      ? [
          {
            icon: <ListX className="h-4 w-4" />,
            label: "Remove from queue",
            action: () => removeFromQueue(queueIndex)
          }
        ]
      : [])
  ];

  // Keep the menu on-screen whatever its height; grow it out of the corner nearest the cursor
  // (macOS spring-open feel).
  const menuHeight = 56 + items.length * 37;
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - menuHeight);
  const transformOrigin = `${y > window.innerHeight - menuHeight ? "bottom" : "top"} ${
    x > window.innerWidth - 220 ? "right" : "left"
  }`;

  return (
    <div
      className="fixed inset-0 z-[60]"
      onClick={closeTrackMenu}
      onContextMenu={(event) => {
        event.preventDefault();
        closeTrackMenu();
      }}
    >
      <motion.div
        style={{ left, top, transformOrigin }}
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={spring.pop}
        onClick={(event) => event.stopPropagation()}
        className="vibrancy glass-popover absolute min-w-[200px] overflow-hidden py-1"
      >
        <div className="border-b border-[var(--edge)] px-3 py-2">
          <p className="truncate text-xs font-semibold text-[var(--paper)]">{displayTitle(track.title)}</p>
          <p className="truncate text-[11px] text-[var(--muted)]">{displayCreators(track.creators)}</p>
        </div>
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => run(item.action)}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--paper)] transition hover:bg-[var(--paper)]/8"
          >
            <span className="text-[var(--muted)]">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </motion.div>
    </div>
  );
}

function StartupSplash({ showCustomChrome }: { showCustomChrome: boolean }) {
  const bootStage = useAppStore((state) => state.bootStage);
  const bootProgress = useAppStore((state) => state.bootProgress);
  const initializationError = useAppStore((state) => state.initializationError);
  const initializing = useAppStore((state) => state.initializing);
  const initialize = useAppStore((state) => state.initialize);
  const pct = Math.round(Math.min(1, Math.max(0, bootProgress)) * 100);

  return (
    <div
      className="flex h-screen min-h-0 flex-col overflow-hidden text-[var(--ink)]"
      style={{
        background:
          "radial-gradient(120% 90% at 50% -10%, rgba(var(--song-rgb), 0.28), transparent 68%), var(--shell)"
      }}
    >
      <DesktopTitleBar visible={showCustomChrome} />
      <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-8 py-6">
        <div
          className="w-full max-w-sm rounded-[var(--radius-xl)] border border-[var(--edge)] bg-[var(--panel-strong)] p-7 text-center shadow-[0_28px_90px_rgba(0,0,0,0.32)]"
        >
          <h1 className="font-display text-5xl font-bold tracking-[-0.03em] text-[var(--paper)]">AMP</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Advanced Music Player</p>
          <p className="mt-3 min-h-5 text-sm text-[var(--muted)]">{bootStage || "Loading your library and sessions"}</p>

          {/* Real progress: the fill reflects actual init stages; the sheen sweeps continuously so it
              always reads as "working" even while a slow stage (network library sync) is in flight. */}
          <div className="relative mt-5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--edge)]">
            <div
              className="h-full rounded-full bg-[var(--acid)] transition-[width] duration-500 ease-out"
              style={{ width: `${Math.max(4, pct)}%` }}
            />
            <motion.div
              aria-hidden
              className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/30 to-transparent"
              initial={{ x: "-130%" }}
              animate={{ x: "430%" }}
              transition={{ duration: 1.15, repeat: Infinity, ease: "linear" }}
            />
          </div>
          <p className="mt-2 text-[11px] tabular-nums text-[var(--muted)]">{pct}%</p>
          {initializationError ? (
            <div className="mt-5 rounded-[var(--radius-md)] border border-red-400/30 bg-red-400/8 p-3 text-left">
              <p className="break-words text-sm text-red-100">{initializationError}</p>
              <button
                type="button"
                disabled={initializing}
                onClick={() => void initialize()}
                className="mt-3 rounded-[var(--radius-sm)] bg-[var(--paper)] px-3 py-1.5 text-sm font-semibold text-[var(--shell)] disabled:opacity-50"
              >
                {initializing ? "Retrying…" : "Try again"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SpotifyOnboardCard({ onConnect }: { onConnect(): void }) {
  const connection = useAppStore((state) => state.connections.spotify);
  const runtime = useAppStore((state) => state.runtime);
  const disconnectProvider = useAppStore((state) => state.disconnectProvider);
  const cancelConnectProvider = useAppStore((state) => state.cancelConnectProvider);
  const config = getProviderConfigStatus(runtime, "spotify");
  const connected = connection.status === "connected";
  const connecting = connection.status === "connecting";

  return (
    <SectionCard>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="kicker">Spotify</p>
          <h3 className="mt-3 font-display text-2xl text-[var(--paper)]">Connect Spotify</h3>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">
            Import your Liked Songs and playlists, and play full tracks inside AMP with Spotify
            Premium.
          </p>
        </div>
        <ConnectionPill provider="spotify" status={connection.status} />
      </div>

      {connected ? (
        <div className="mt-5 rounded-[var(--radius-lg)] border border-[var(--connect)]/35 bg-[var(--connect)]/10 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 font-display text-xl text-[var(--paper)]">
                <CheckCircle2 className="h-5 w-5 text-[var(--connect)]" />
                {connection.displayName ?? "Spotify connected"}
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                Your Spotify library is ready — it imports automatically.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void disconnectProvider("spotify")}
              className="shrink-0 rounded-full border border-[var(--edge)] px-4 py-2 text-xs font-semibold text-[var(--muted)] transition hover:border-[var(--warn)]/60 hover:text-[var(--warn)]"
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-display text-xl text-[var(--paper)]">Not connected</p>
              <p className="mt-2 max-w-md text-sm leading-6 text-[var(--muted)]">
                {config.ready
                  ? "Sign in with your Spotify account. The window opens in your browser and returns to AMP."
                  : config.message}
              </p>
            </div>
            <button
              type="button"
              disabled={!config.ready && !connecting}
              onClick={() => {
                if (connecting) {
                  void cancelConnectProvider("spotify");
                } else if (config.ready) {
                  onConnect();
                }
              }}
              title={connecting ? "Cancel sign-in" : undefined}
              className={cn(
                "shrink-0 rounded-full px-5 py-3 text-sm font-semibold transition",
                connecting
                  ? "border border-[var(--edge)] text-[var(--muted)] hover:border-[var(--warn)]/60 hover:text-[var(--warn)]"
                  : config.ready
                    ? "bg-[var(--acid)] text-[var(--shell)] hover:brightness-110"
                    : "cursor-not-allowed border border-[var(--edge)] text-[var(--muted)] opacity-70"
              )}
            >
              <span className="inline-flex items-center gap-2">
                {connecting ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                {connecting ? "Cancel" : config.ready ? "Connect Spotify" : "Sign-in unavailable"}
              </span>
            </button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/**
 * First-run setup. Shown once on a brand-new install (and again on demand via Settings → Start
 * over) to guide the user through connecting Spotify and SoundCloud. Both are optional — the app
 * works without sign-in — so it can always be skipped. Reuses the same connect flows as Settings
 * (ProviderConsentDialog for Spotify, the full SoundCloudConnectCard for SoundCloud).
 */
function Onboarding({ showCustomChrome }: { showCustomChrome: boolean }) {
  const connections = useAppStore((state) => state.connections);
  const connectProvider = useAppStore((state) => state.connectProvider);
  const completeOnboarding = useAppStore((state) => state.completeOnboarding);
  const [consentProvider, setConsentProvider] = useState<OAuthProvider | null>(null);

  const anyConnected =
    connections.spotify.status === "connected" || connections.soundcloud.status === "connected";

  return (
    <div
      className="flex h-screen flex-col overflow-hidden text-[var(--ink)]"
      style={{
        background:
          "radial-gradient(130% 90% at 50% -10%, rgba(var(--song-rgb), 0.26), transparent 68%), var(--shell)"
      }}
    >
      <DesktopTitleBar visible={showCustomChrome} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div className="text-center">
            <p className="text-sm text-[var(--muted)]">Welcome to</p>
            <h1 className="mt-1 font-display text-4xl font-bold tracking-[-0.03em] text-[var(--paper)]">AMP</h1>
            <p className="mt-2 text-sm text-[var(--muted)]">Advanced Music Player</p>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-[var(--muted)]">
              One library for Spotify and SoundCloud. Connect your accounts to import your likes and
              playlists and play everything in one place — or skip and start exploring right away.
            </p>
          </div>

          <SpotifyOnboardCard onConnect={() => setConsentProvider("spotify")} />
          <SoundCloudConnectCard onRequestOAuth={() => setConsentProvider("soundcloud")} />

          <div className="flex flex-col items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => completeOnboarding()}
              className="rounded-full bg-[var(--acid)] px-9 py-3.5 text-sm font-semibold text-[var(--shell)] transition hover:brightness-105"
            >
              {anyConnected ? "Start listening" : "Skip for now — explore AMP"}
            </button>
            <p className="text-xs text-[var(--muted)]">
              You can connect later or restart this setup anytime from Settings.
            </p>
          </div>
        </div>
      </div>

      <ProviderConsentDialog
        provider={consentProvider}
        onClose={() => setConsentProvider(null)}
        onConfirm={(provider) => {
          setConsentProvider(null);
          void connectProvider(provider);
        }}
      />
    </div>
  );
}

function Sidebar() {
  return (
    <div className="flex h-full flex-col justify-between">
      <div className="space-y-6">
        <nav className="space-y-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-[var(--radius)] px-3.5 py-2.5 font-display text-[15px] font-medium tracking-[-0.01em] transition",
                  isActive
                    ? "bg-gradient-to-r from-[rgba(var(--song-rgb),0.2)] via-[rgba(var(--song-rgb),0.07)] to-transparent text-[var(--paper)] shadow-[0_0_22px_-8px_rgba(var(--song-rgb),0.55)]"
                    : "text-[var(--muted)] opacity-65 hover:bg-white/[0.04] hover:opacity-100 hover:text-[var(--paper)]"
                )
              }
            >
              <item.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>

    </div>
  );
}

function PlayerBar({
  showQueueToggle,
  queueOpen,
  onToggleQueue,
  onEnterCompact
}: {
  showQueueToggle: boolean;
  queueOpen: boolean;
  onToggleQueue(): void;
  onEnterCompact(): void;
}) {
  const playback = useAppStore((state) => state.playback);
  const togglePlayback = useAppStore((state) => state.togglePlayback);
  const next = useAppStore((state) => state.next);
  const previous = useAppStore((state) => state.previous);
  const setVolume = useAppStore((state) => state.setVolume);
  const setProviderVolume = useAppStore((state) => state.setProviderVolume);
  const seek = useAppStore((state) => state.seek);
  const shuffle = useAppStore((state) => state.shuffle);
  const toggleShuffle = useAppStore((state) => state.toggleShuffle);
  const connections = useAppStore((state) => state.connections);
  const libraries = useAppStore((state) => state.libraries);
  const spotifyLikedTrackIds = useAppStore((state) => state.spotifyLikedTrackIds);
  const setSoundCloudTrackLiked = useAppStore((state) => state.setSoundCloudTrackLiked);
  const setSpotifyTrackLiked = useAppStore((state) => state.setSpotifyTrackLiked);
  const openArtist = useAppStore((state) => state.openArtist);
  const navigate = useNavigate();
  const currentTrack = playback.queue[playback.currentIndex];
  const durationMs = Math.max(playback.durationMs, 1);

  const canSyncSoundCloudLikes =
    connections.soundcloud.status === "connected" &&
    (connections.soundcloud.metadata?.source === "web-session" ||
      Boolean(connections.soundcloud.accessToken));
  const canSyncSpotifyLikes = connections.spotify.status === "connected";
  const soundCloudLikedTrackIds = useMemo(
    () => new Set((libraries.soundcloud?.items ?? []).map(getTrackUiKey)),
    [libraries.soundcloud?.items]
  );
  const likeProvider =
    currentTrack && canSyncSoundCloudLikes && currentTrack.provider === "soundcloud"
      ? "soundcloud"
      : currentTrack && canSyncSpotifyLikes && currentTrack.provider === "spotify"
        ? "spotify"
        : null;
  const currentLiked =
    currentTrack && likeProvider === "soundcloud"
      ? soundCloudLikedTrackIds.has(getTrackUiKey(currentTrack))
      : currentTrack && likeProvider === "spotify"
        ? spotifyLikedTrackIds.has(getTrackUiKey(currentTrack))
        : false;
  const toggleCurrentLike = () => {
    if (!currentTrack) {
      return;
    }
    if (likeProvider === "soundcloud") {
      void setSoundCloudTrackLiked(currentTrack, !currentLiked);
    } else if (likeProvider === "spotify") {
      void setSpotifyTrackLiked(currentTrack, !currentLiked);
    }
  };
  const [seekDraft, setSeekDraft] = useState(playback.positionMs);
  const [isSeeking, setIsSeeking] = useState(false);
  const [volumeDraft, setVolumeDraft] = useState(playback.volume);
  const [isVolumeSliding, setIsVolumeSliding] = useState(false);
  const [providerVolumeDrafts, setProviderVolumeDrafts] = useState(playback.providerVolumes);
  const providerVolumeDraftsRef = useRef(playback.providerVolumes);
  const [providerVolumeSliding, setProviderVolumeSliding] = useState<Provider | null>(null);
  const [advancedVolumeOpen, setAdvancedVolumeOpen] = useState(false);
  const [providerVolumesLinked, setProviderVolumesLinked] = useState(false);
  // Smooth timer: when playing, increment a local counter every 100ms so the
  // position display doesn't jump on each 2.5s Spotify poll. Resync to the
  // polled value so we don't drift.
  const [smoothPositionMs, setSmoothPositionMs] = useState(playback.positionMs);
  const smoothPositionRef = useRef(playback.positionMs);
  smoothPositionRef.current = smoothPositionMs;
  // After a seek commit, polls from BEFORE the seek still arrive for a beat — accepting them made
  // the scrubber visibly snap back to the old position until the next fresh poll.
  const pendingSeekRef = useRef<{ target: number; at: number } | null>(null);

  useEffect(() => {
    if (isSeeking) {
      return;
    }
    const pending = pendingSeekRef.current;
    if (pending) {
      const age = Date.now() - pending.at;
      // Grace window: for ~one poll cycle after the seek, only accept polls that landed near the
      // target — anything else is a pre-seek straggler (this also covers seeks smaller than the
      // proximity threshold). Past the window, accept whatever the engine reports.
      if (age < 2600 && Math.abs(playback.positionMs - pending.target) > 1500) {
        return;
      }
      pendingSeekRef.current = null;
    }
    setSeekDraft(playback.positionMs);
    setSmoothPositionMs(playback.positionMs);
  }, [isSeeking, playback.positionMs]);

  useEffect(() => {
    if (playback.status !== "playing") {
      return;
    }
    const tick = 100;
    const interval = window.setInterval(() => {
      const next = Math.min(smoothPositionRef.current + tick, durationMs);
      setSmoothPositionMs(next);
    }, tick);
    return () => window.clearInterval(interval);
  }, [playback.status, durationMs]);

  const displayedPosition = isSeeking ? seekDraft : smoothPositionMs;

  useEffect(() => {
    if (!isVolumeSliding) {
      setVolumeDraft(playback.volume);
    }
  }, [isVolumeSliding, playback.volume]);

  useEffect(() => {
    if (!providerVolumeSliding) {
      providerVolumeDraftsRef.current = playback.providerVolumes;
      setProviderVolumeDrafts(playback.providerVolumes);
    }
  }, [playback.providerVolumes, providerVolumeSliding]);

  const commitSeek = (value = seekDraft) => {
    if (!currentTrack) {
      return;
    }
    const nextPositionMs = Math.max(0, Math.min(durationMs, value));
    setIsSeeking(false);
    setSeekDraft(nextPositionMs);
    setSmoothPositionMs(nextPositionMs);
    pendingSeekRef.current = { target: nextPositionMs, at: Date.now() };
    void seek(nextPositionMs);
  };

  const commitVolume = (value = volumeDraft) => {
    const nextVolume = clampUnit(value);
    setIsVolumeSliding(false);
    setVolumeDraft(nextVolume);
    void setVolume(nextVolume);
  };

  // Mute toggle on the speaker icon: remembers the last audible level and restores it.
  const lastAudibleVolumeRef = useRef(playback.volume > 0 ? playback.volume : 0.8);
  if (volumeDraft > 0) {
    lastAudibleVolumeRef.current = volumeDraft;
  }
  const toggleMute = () => {
    const next = volumeDraft > 0 ? 0 : clampUnit(lastAudibleVolumeRef.current || 0.8);
    setVolumeDraft(next);
    void setVolume(next);
  };

  const getNextProviderVolumeDrafts = (
    provider: Provider,
    value: number,
    drafts = providerVolumeDraftsRef.current
  ) => {
    const nextVolume = clampUnit(value);
    if (!providerVolumesLinked) {
      return {
        ...drafts,
        [provider]: nextVolume
      };
    }

    const currentVolume = drafts[provider];
    if (currentVolume <= 0) {
      return {
        ...drafts,
        [provider]: nextVolume
      };
    }

    // Linked mode scales only the trims the popover actually exposes (Spotify + SoundCloud);
    // YouTube/local carry their defaults through untouched so the map stays complete.
    const scale = nextVolume / currentVolume;
    return {
      ...drafts,
      spotify: clampUnit(drafts.spotify * scale),
      soundcloud: clampUnit(drafts.soundcloud * scale)
    };
  };

  const applyProviderVolumeDrafts = (drafts: typeof providerVolumeDrafts) => {
    for (const provider of volumeProviders) {
      void setProviderVolume(provider, drafts[provider]);
    }
  };

  const updateProviderVolumeDraft = (provider: Provider, value: number) => {
    setProviderVolumeSliding(provider);
    const nextDrafts = getNextProviderVolumeDrafts(provider, value);
    providerVolumeDraftsRef.current = nextDrafts;
    setProviderVolumeDrafts(nextDrafts);
    applyProviderVolumeDrafts(nextDrafts);
  };

  const commitProviderVolume = (provider: Provider, value = providerVolumeDraftsRef.current[provider]) => {
    const nextDrafts = getNextProviderVolumeDrafts(provider, value);
    providerVolumeDraftsRef.current = nextDrafts;
    setProviderVolumeDrafts(nextDrafts);
    setProviderVolumeSliding(null);
    applyProviderVolumeDrafts(nextDrafts);
  };

  // The single, complete player, pinned to the bottom: track info · transport + scrubber · volume.
  return (
    <motion.header
      initial={panelVariants.rise.initial}
      animate={panelVariants.rise.animate}
      transition={{ ...spring.panel, delay: 0.1 }}
      className="vibrancy glass-bar relative z-20 shrink-0 border-t border-[var(--edge-strong)] px-4 py-2.5"
      style={{ boxShadow: "0 -18px 44px -28px rgba(0,0,0,0.85)" }}
    >
      <div className="flex items-center gap-4">
        <div className="flex w-64 min-w-0 shrink-0 items-center gap-2.5">
          {currentTrack ? <ProviderTag provider={currentTrack.provider} /> : null}
          <div className="min-w-0">
            <p className="truncate font-display text-sm text-[var(--paper)]">
              {currentTrack ? displayTitle(currentTrack.title) : "Nothing playing"}
            </p>
            {currentTrack ? (
              <button
                type="button"
                title="Go to artist"
                onClick={() => {
                  void openArtist(currentTrack);
                  navigate("/artist");
                }}
                className="block max-w-full truncate text-left text-xs text-[var(--muted)] transition hover:text-[var(--acid)] hover:underline"
              >
                {displayCreators(currentTrack.creators)}
              </button>
            ) : (
              <p className="truncate text-xs text-[var(--muted)]">Pick a track to start</p>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => toggleShuffle()}
              title={shuffle ? "Shuffle: on" : "Shuffle: off"}
              aria-pressed={shuffle}
              className={cn(
                "grid h-8 w-8 place-items-center rounded-full border transition",
                shuffle
                  ? "border-[var(--acid)]/60 bg-[rgba(var(--song-rgb),0.12)] text-[var(--acid)]"
                  : "border-transparent text-[var(--muted)] hover:bg-white/5 hover:text-[var(--paper)]"
              )}
            >
              <Shuffle className="h-3.5 w-3.5" />
            </button>
            <TransportButton onClick={() => void previous()} disabled={!playback.canGoPrevious} label="Previous">
              <SkipBack className="h-3.5 w-3.5" />
            </TransportButton>
            <TransportButton
              onClick={() => void togglePlayback()}
              emphasis
              label={playback.status === "playing" ? "Pause" : "Play"}
            >
              {playback.status === "playing" ? (
                <Pause className="h-4 w-4 fill-current" />
              ) : (
                // Solid triangle nudged a hair right so it reads optically centred in the circle.
                <Play className="h-4 w-4 translate-x-[1px] fill-current" />
              )}
            </TransportButton>
            <TransportButton onClick={() => void next()} disabled={!playback.canGoNext} label="Next">
              <SkipForward className="h-3.5 w-3.5" />
            </TransportButton>
            <button
              type="button"
              onClick={toggleCurrentLike}
              disabled={!likeProvider}
              title={
                !likeProvider
                  ? "Connect the provider to like this track"
                  : currentLiked
                    ? "Remove from likes"
                    : "Add to likes"
              }
              aria-pressed={currentLiked}
              className={cn(
                "grid h-8 w-8 place-items-center rounded-full border transition disabled:opacity-30",
                currentLiked
                  ? "border-[var(--acid)]/60 bg-[rgba(var(--song-rgb),0.12)] text-[var(--acid)]"
                  : "border-transparent text-[var(--muted)] hover:bg-white/5 hover:text-[var(--paper)]"
              )}
            >
              <Heart
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  currentLiked && "scale-110 fill-[var(--acid)]"
                )}
              />
            </button>
          </div>
          <div className="flex w-full max-w-xl items-center gap-2">
            <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-[var(--muted)]">
              {formatDuration(displayedPosition)}
            </span>
            <input
              type="range"
              min={0}
              max={durationMs}
              step={1000}
              value={displayedPosition}
              disabled={!currentTrack}
              aria-label="Seek"
              aria-valuetext={`${formatDuration(displayedPosition)} of ${formatDuration(playback.durationMs)}`}
              onPointerDown={() => setIsSeeking(true)}
              onChange={(event) => {
                setIsSeeking(true);
                setSeekDraft(Number(event.target.value));
              }}
              onPointerUp={(event) => commitSeek(Number(event.currentTarget.value))}
              onKeyUp={(event) => commitSeek(Number(event.currentTarget.value))}
              onBlur={(event) => {
                if (isSeeking) {
                  commitSeek(Number(event.currentTarget.value));
                }
              }}
              className="min-w-0 flex-1"
              style={sliderFill((displayedPosition / durationMs) * 100)}
            />
            <span className="w-9 shrink-0 text-[10px] tabular-nums text-[var(--muted)]">
              {formatDuration(playback.durationMs)}
            </span>
          </div>
        </div>

        <div className="relative flex w-64 shrink-0 items-center justify-end gap-2">
          <AnimatePresence>
            {advancedVolumeOpen ? (
              <motion.div
                initial={panelVariants.rise.initial}
                animate={panelVariants.rise.animate}
                exit={panelVariants.rise.exit}
                transition={spring.pop}
                style={{ transformOrigin: "bottom right" }}
                className="vibrancy glass-popover absolute bottom-10 right-0 z-30 w-[360px] max-w-[calc(100vw-2rem)] p-3"
              >
                <div className="mb-2 flex items-center gap-2">
                  <p className="kicker">Advanced volume</p>
                  <button
                    type="button"
                    onClick={() => setProviderVolumesLinked((linked) => !linked)}
                    title={providerVolumesLinked ? "Unlink provider volume trims" : "Link provider volume trims"}
                    aria-pressed={providerVolumesLinked}
                    className={cn(
                      "ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-full border transition",
                      providerVolumesLinked
                        ? "border-[var(--acid)]/60 text-[var(--acid)]"
                        : "border-[var(--edge)] text-[var(--muted)] hover:text-[var(--paper)]"
                    )}
                  >
                    {providerVolumesLinked ? <Link2 className="h-3.5 w-3.5" /> : <Unlink2 className="h-3.5 w-3.5" />}
                  </button>
                  <span className="w-20 shrink-0 text-right text-[10px] tabular-nums text-[var(--muted)]">
                    Master {Math.round(volumeDraft * 100)}%
                  </span>
                </div>
                <div className="space-y-3">
                  {volumeProviders.map((provider) => {
                    const draft = providerVolumeDrafts[provider];
                    const effective = Math.round(volumeDraft * draft * 100);
                    return (
                      <div key={provider} className="grid grid-cols-[88px_minmax(0,1fr)_96px] items-center gap-2">
                        <span className="text-xs text-[var(--paper)]">{providerLabel(provider)}</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={draft}
                          aria-label={`${providerLabel(provider)} volume trim`}
                          aria-valuetext={`${Math.round(draft * 100)}%`}
                          onPointerDown={() => setProviderVolumeSliding(provider)}
                          onChange={(event) => updateProviderVolumeDraft(provider, Number(event.target.value))}
                          onPointerUp={(event) =>
                            commitProviderVolume(provider, Number(event.currentTarget.value))
                          }
                          onKeyUp={(event) =>
                            commitProviderVolume(provider, Number(event.currentTarget.value))
                          }
                          onBlur={(event) => {
                            if (providerVolumeSliding === provider) {
                              commitProviderVolume(provider, Number(event.currentTarget.value));
                            }
                          }}
                          style={sliderFill(draft * 100)}
                        />
                        <span className="w-24 justify-self-end whitespace-nowrap text-right text-[10px] tabular-nums text-[var(--muted)]">
                          {Math.round(draft * 100)}% / {effective}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <button
            type="button"
            onClick={toggleMute}
            title={volumeDraft === 0 ? "Unmute" : "Mute"}
            aria-label={volumeDraft === 0 ? "Unmute" : "Mute"}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--muted)] transition hover:bg-white/5 hover:text-[var(--paper)]"
          >
            {volumeDraft === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volumeDraft}
            aria-label="Volume"
            aria-valuetext={`${Math.round(volumeDraft * 100)}%`}
            onPointerDown={() => setIsVolumeSliding(true)}
            onChange={(event) => {
              const nextVolume = clampUnit(Number(event.target.value));
              setIsVolumeSliding(true);
              setVolumeDraft(nextVolume);
              void setVolume(nextVolume);
            }}
            onPointerUp={(event) => commitVolume(Number(event.currentTarget.value))}
            onKeyUp={(event) => commitVolume(Number(event.currentTarget.value))}
            onBlur={(event) => {
              if (isVolumeSliding) {
                commitVolume(Number(event.currentTarget.value));
              }
            }}
            className="w-24"
            style={sliderFill(volumeDraft * 100)}
          />
          <button
            type="button"
            onClick={() => setAdvancedVolumeOpen((open) => !open)}
            title={advancedVolumeOpen ? "Hide advanced volume" : "Advanced volume"}
            aria-pressed={advancedVolumeOpen}
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-full border transition",
              advancedVolumeOpen
                ? "border-[var(--acid)]/60 text-[var(--acid)]"
                : "border-[var(--edge)] text-[var(--muted)] hover:text-[var(--paper)]"
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
          {showQueueToggle ? (
            <button
              type="button"
              onClick={onToggleQueue}
              title={queueOpen ? "Hide queue" : "Show queue"}
              className={cn(
                "grid h-8 w-8 shrink-0 place-items-center rounded-full border transition",
                queueOpen
                  ? "border-[var(--acid)]/60 text-[var(--acid)]"
                  : "border-[var(--edge)] text-[var(--muted)] hover:text-[var(--paper)]"
              )}
            >
              <ListMusic className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onEnterCompact}
            title="Mini player"
            aria-label="Mini player"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-[var(--edge)] text-[var(--muted)] transition hover:text-[var(--paper)]"
          >
            <Minimize2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </motion.header>
  );
}

// Compact "mini-player": the window shrinks to this always-on-top now-playing card. Audio keeps
// playing (it lives in the engine, not this view), so this is purely a smaller face for the same store.
function MiniPlayer({ onExpand }: { onExpand(): void }) {
  const playback = useAppStore((state) => state.playback);
  const togglePlayback = useAppStore((state) => state.togglePlayback);
  const next = useAppStore((state) => state.next);
  const previous = useAppStore((state) => state.previous);
  const currentTrack = playback.queue[playback.currentIndex];
  const durationMs = Math.max(playback.durationMs, 1);
  const progress = currentTrack ? Math.min(100, (playback.positionMs / durationMs) * 100) : 0;
  const isPlaying = playback.status === "playing";

  return (
    <div className="desktop-drag-region relative flex h-screen w-screen items-center gap-3 overflow-hidden bg-[var(--panel-strong)] px-3 text-[var(--ink)]">

      {currentTrack ? (
        <ArtworkImage
          track={currentTrack}
          alt=""
          className="h-[84px] w-[84px] shrink-0 rounded-[var(--radius)] object-cover shadow-[var(--shadow-pop)]"
        />
      ) : (
        <div className="grid h-[84px] w-[84px] shrink-0 place-items-center rounded-[var(--radius)] bg-white/5 text-[var(--muted)]">
          <Headphones className="h-6 w-6" />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate font-display text-sm text-[var(--paper)]">
          {currentTrack ? displayTitle(currentTrack.title) : "Nothing playing"}
        </p>
        <p className="truncate text-xs text-[var(--muted)]">
          {currentTrack ? displayCreators(currentTrack.creators) : "Pick a track to start"}
        </p>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/12">
          <div
            className="h-full rounded-full bg-[var(--acid)] transition-[width] duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="desktop-no-drag mt-2 flex items-center gap-1.5">
          <MiniButton onClick={() => void previous()} disabled={!playback.canGoPrevious} label="Previous">
            <SkipBack className="h-3.5 w-3.5" />
          </MiniButton>
          <MiniButton onClick={() => void togglePlayback()} emphasis label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? (
              <Pause className="h-4 w-4 fill-current" />
            ) : (
              <Play className="h-4 w-4 translate-x-[1px] fill-current" />
            )}
          </MiniButton>
          <MiniButton onClick={() => void next()} disabled={!playback.canGoNext} label="Next">
            <SkipForward className="h-3.5 w-3.5" />
          </MiniButton>
        </div>
      </div>

      <button
        type="button"
        onClick={onExpand}
        title="Expand"
        aria-label="Expand to full window"
        className="desktop-no-drag absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-[var(--muted)] transition hover:bg-white/10 hover:text-[var(--paper)]"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function MiniButton({
  children,
  onClick,
  disabled,
  emphasis,
  label
}: {
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  emphasis?: boolean;
  label: string;
}) {
  return (
    <motion.button
      type="button"
      data-motion
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      whileHover={disabled ? undefined : { scale: emphasis ? 1.07 : 1.05 }}
      whileTap={disabled ? undefined : { scale: 0.92 }}
      transition={spring.press}
      className={cn(
        "grid place-items-center rounded-full",
        emphasis
          ? "h-8 w-8 bg-[var(--acid)] text-[var(--shell)] shadow-[var(--shadow-glow)]"
          : "h-7 w-7 text-[var(--paper)] hover:bg-white/10",
        disabled && "cursor-not-allowed opacity-40"
      )}
    >
      {children}
    </motion.button>
  );
}

function NowPlayingPanel() {
  const queue = useAppStore((state) => state.playback.queue);
  const currentIndex = useAppStore((state) => state.playback.currentIndex);
  const playTrack = useAppStore((state) => state.playTrack);
  const reorderQueue = useAppStore((state) => state.reorderQueue);
  const clearQueue = useAppStore((state) => state.clearQueue);
  const openTrackMenu = useAppStore((state) => state.openTrackMenu);
  const queueSource = useAppStore((state) => state.queueSource);
  const lastStation = useAppStore((state) => state.lastStation);
  const dailyMixes = useAppStore((state) => state.dailyMixes);
  const openMix = useAppStore((state) => state.openMix);
  const openArtist = useAppStore((state) => state.openArtist);
  const navigate = useNavigate();
  const currentTrack = queue[currentIndex];
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const endDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  // "Playing from" jumps back to wherever this queue was started: a station/mix reopens its
  // tracklist; playlist/library/search land on their pages.
  const openQueueSource = () => {
    if (!queueSource) {
      return;
    }
    if (queueSource.mixId) {
      const mix = [lastStation, ...dailyMixes].find((item) => item?.id === queueSource.mixId);
      if (mix) {
        openMix(mix);
        navigate("/mix");
        return;
      }
    }
    const routes: Record<string, string> = {
      playlist: "/playlists",
      library: "/library",
      search: "/search",
      album: "/album",
      artist: "/artist"
    };
    const route = routes[queueSource.kind];
    if (route) {
      navigate(route);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <p className="kicker shrink-0">
        Now Playing
      </p>
      {queueSource ? (
        <button
          type="button"
          onClick={openQueueSource}
          title="Open the queue's source"
          className="mt-1 flex max-w-full shrink-0 items-center gap-1 text-left text-[11px] text-[var(--muted)] transition hover:text-[var(--acid)]"
        >
          <ListMusic className="h-3 w-3 shrink-0" />
          <span className="truncate">Playing from {queueSource.label}</span>
        </button>
      ) : null}
      {currentTrack ? (
        <div className="mt-3 shrink-0">
          <ArtworkImage
            track={currentTrack}
            alt={`${currentTrack.title} artwork`}
            className="aspect-square w-full rounded-[var(--radius)] object-cover"
          />
          <div className="mt-2.5">
            <ProviderTag provider={currentTrack.provider} />
          </div>
          <p className="mt-2 truncate font-display text-base text-[var(--paper)]">{displayTitle(currentTrack.title)}</p>
          <button
            type="button"
            title="Go to artist"
            onClick={() => {
              void openArtist(currentTrack);
              navigate("/artist");
            }}
            className="block max-w-full truncate text-left text-xs text-[var(--muted)] transition hover:text-[var(--acid)] hover:underline"
          >
            {displayCreators(currentTrack.creators)}
          </button>
        </div>
      ) : (
        <div className="mt-3 shrink-0 rounded-[var(--radius)] border border-dashed border-[var(--edge)] bg-[var(--panel)] px-3 py-10 text-center text-xs text-[var(--muted)]">
          Nothing playing yet
        </div>
      )}

      <div className="mt-4 flex shrink-0 items-baseline justify-between gap-2">
        <p className="kicker">
          Queue
          {queue.length > 0 ? (
            <span className="tnum ml-1.5 text-[var(--faint)]">{queue.length}</span>
          ) : null}
        </p>
        {queue.length > 1 ? (
          <button
            type="button"
            onClick={clearQueue}
            title="Clear the queue (current track keeps playing)"
            className="text-[11px] text-[var(--muted)] transition hover:text-[var(--warn)]"
          >
            Clear
          </button>
        ) : null}
      </div>
      <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {queue.length === 0 ? (
          <p className="px-1 text-xs text-[var(--muted)]">Nothing queued.</p>
        ) : (
          queue.map((track, index) => (
            <button
              key={`${track.id}-${index}`}
              type="button"
              draggable
              onDragStart={(event) => {
                setDragIndex(index);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index));
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (overIndex !== index) {
                  setOverIndex(index);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragIndex !== null && dragIndex !== index) {
                  reorderQueue(dragIndex, index);
                }
                endDrag();
              }}
              onDragEnd={endDrag}
              // Jumping within the SAME queue must keep its "Playing from" source label intact.
              onClick={() => void playTrack(track, queue, queueSource)}
              onContextMenu={(event) => {
                event.preventDefault();
                openTrackMenu(track, event.clientX, event.clientY, { source: "queue", queueIndex: index });
              }}
              className={cn(
                "flex w-full cursor-grab items-center gap-2 rounded-[var(--radius-sm)] border border-l-2 p-1.5 text-left transition active:cursor-grabbing",
                index === currentIndex
                  ? "border-[var(--acid)]/50 bg-[var(--paper)]/8"
                  : "border-transparent hover:bg-white/5",
                dragIndex === index && "opacity-40",
                overIndex === index && dragIndex !== null && dragIndex !== index && "ring-1 ring-[var(--acid)]/60"
              )}
              // A soft, desaturated left edge quietly hints at the source (Spotify vs SoundCloud).
              style={{ borderLeftColor: `color-mix(in srgb, var(--${track.provider}-tint) 42%, transparent)` }}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--paper)]/8 text-[10px] text-[var(--muted)]">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-[var(--paper)]">{displayTitle(track.title)}</p>
                <p className="truncate text-[10px] text-[var(--muted)]">{displayCreators(track.creators)}</p>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function TransportButton({
  children,
  emphasis,
  disabled,
  onClick,
  label
}: {
  children: ReactNode;
  emphasis?: boolean;
  disabled?: boolean;
  onClick(): void;
  label: string;
}) {
  return (
    <motion.button
      type="button"
      data-motion
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      whileHover={disabled ? undefined : { scale: emphasis ? 1.07 : 1.05 }}
      whileTap={disabled ? undefined : { scale: 0.92 }}
      transition={spring.press}
      className={cn(
        "grid place-items-center rounded-full border",
        emphasis
          ? "h-10 w-10 border-transparent bg-[var(--acid)] text-[var(--shell)] shadow-[var(--shadow-glow)] hover:brightness-105"
          : "h-9 w-9 border-[var(--edge)] bg-[var(--panel)] text-[var(--paper)] hover:border-[var(--acid)]/60 hover:bg-[var(--panel-soft)]",
        disabled && "cursor-not-allowed opacity-40"
      )}
    >
      {children}
    </motion.button>
  );
}

function NoticeBanner() {
  const notice = useAppStore((state) => state.notice);
  const clearNotice = useAppStore((state) => state.clearNotice);

  // Auto-dismiss so the user never has to chase the button. The timer resets whenever the message
  // changes (a fresh notice gets its own full window).
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => clearNotice(), 4500);
    return () => window.clearTimeout(timer);
  }, [notice, clearNotice]);

  return (
    <AnimatePresence>
      {notice ? (
        <motion.div
          initial={{ opacity: 0, y: -14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.99 }}
          transition={spring.toast}
          // Tint the toast with the current song colour so it sits in the background instead of
          // clashing with it (the app's whole backdrop is keyed off the same --song-rgb).
          role="status"
          aria-live="polite"
          className="mx-6 mt-4 rounded-[var(--radius-lg)] border px-4 py-3 text-sm text-[var(--paper)] backdrop-blur"
          style={{
            borderColor: "rgba(var(--song-rgb), 0.32)",
            background:
              "linear-gradient(180deg, rgba(var(--song-rgb), 0.16), rgba(var(--song-rgb), 0.07))"
          }}
        >
          <div className="flex items-center justify-between gap-4">
            <span className="min-w-0 flex-1 line-clamp-2">{notice}</span>
            <button
              type="button"
              onClick={clearNotice}
              aria-label="Dismiss"
              className="kicker shrink-0 transition hover:text-[var(--paper)]"
            >
              dismiss
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function PageFrame({ title, children, fill }: { title: string; children: ReactNode; fill?: boolean }) {
  return (
    <motion.section
      key={title}
      // Opacity-only fade on mount — no `scale`, no `exit`. Animating `scale` meant transforming the
      // entire (often large) page subtree on the very frame it first mounts and paints, which dropped
      // frames mid-transition; opacity alone is a pure compositor cross-fade. Dropping `exit` lets the
      // previous page unmount in the same commit (no wait, no two-pages-stacked layout jump).
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={tween.quick}
      // `fill` pages own their scrolling (e.g. Library's virtualized list): the frame pins itself
      // to the route container's exact height so the outer page scrollbar never engages.
      className={fill ? "flex h-full min-h-0 flex-col gap-4" : "space-y-4"}
    >
      <h2 className="shrink-0 font-display text-xl text-[var(--paper)]">{title}</h2>
      {children}
    </motion.section>
  );
}

function SectionCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      // Borderless solid panel — surface contrast alone separates it from the page, which keeps the
      // gray count down and the look calm (the border-on-everything pass read as "rough").
      className={cn("rounded-[var(--radius-lg)] bg-[var(--panel-strong)] p-4", className)}
    >
      {children}
    </section>
  );
}

/** One canonical section heading: display-font title, optional count + right-aligned action. */
function SectionHeader({
  title,
  count,
  action
}: {
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-[var(--paper)]">
        {title}
        {typeof count === "number" && (
          <span className="tnum ml-2 text-[13px] font-medium text-[var(--faint)]">{count}</span>
        )}
      </h2>
      {action}
    </div>
  );
}

type BtnKind = "primary" | "secondary" | "ghost";

/** Button hierarchy: pill is the signature of the ONE primary action per context; everything else
 *  is quiet. Replaces the hand-rolled rounded-full recipes. */
function Btn({
  kind = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        kind === "primary" &&
          "rounded-full bg-[var(--acid)] px-5 py-2 text-[var(--shell)] hover:opacity-90",
        kind === "secondary" &&
          "rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-2 text-[var(--paper)] hover:border-[var(--edge-strong)]",
        kind === "ghost" &&
          "rounded-[var(--radius)] px-3 py-1.5 text-[var(--muted)] hover:bg-white/5 hover:text-[var(--paper)]",
        className
      )}
      {...props}
    />
  );
}

/** ESC closes the active overlay — shared by every modal/dialog. */
function useEscapeClose(active: boolean, onClose: () => void) {
  // The callback lives in a ref so the listener attaches once per open, not once per render
  // (callers pass inline lambdas whose identity changes every render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

/** Confirm modal for destructive actions (delete playlist, clear history, start over). */
function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  useEscapeClose(open, onCancel);
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onCancel}
          className="fixed inset-0 z-50 grid place-items-center bg-black/55 px-6 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            transition={{ duration: 0.16 }}
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-[var(--radius-xl)] border border-[var(--edge)] bg-[var(--panel-strong)] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.38)]"
          >
            <h3 className="font-display text-2xl text-[var(--paper)]">{title}</h3>
            <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{body}</p>
            <div className="mt-6 flex justify-end gap-3">
              <Btn kind="ghost" onClick={onCancel}>
                Cancel
              </Btn>
              <Btn kind="primary" onClick={onConfirm}>
                {confirmLabel}
              </Btn>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Quiet empty states: ghost artwork skeletons inside tile grids, a single sentence elsewhere.
 *  Replaces the dashed-border centered boxes. */
function EmptyState({
  variant = "inline",
  children
}: {
  variant?: "grid" | "inline";
  children: ReactNode;
}) {
  if (variant === "grid") {
    return (
      <div>
        {/* Matches the real tile grids (minmax 150px, gap-2.5) so content doesn't reflow when it lands. */}
        <div aria-hidden="true" className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="aspect-square rounded-[var(--radius-lg)] bg-white/[0.03]" />
          ))}
        </div>
        <p className="mt-3 text-sm text-[var(--muted)]">{children}</p>
      </div>
    );
  }
  return <p className="py-2 text-sm text-[var(--muted)]">{children}</p>;
}

function ConnectionPill({
  provider,
  status
}: {
  provider: Provider;
  status: "connected" | "disconnected" | "connecting" | "error";
}) {
  // All four states read honestly — "connecting" used to show a spinner next to "Disconnected".
  const styles =
    status === "connected"
      ? "bg-[var(--connect)]/15 text-[var(--connect)]"
      : status === "error"
        ? "bg-[var(--warn)]/15 text-[var(--warn)]"
        : "bg-[var(--muted)]/15 text-[var(--muted)]";
  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting…"
        : status === "error"
          ? "Connection error"
          : "Disconnected";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold",
        styles
      )}
    >
      {status === "connecting" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
      {label}
    </span>
  );
}

/** Song-tinted switch. data-motion opts out of the global button press-scale. */
function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-motion="off"
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full border transition-colors duration-150",
        checked
          ? "border-transparent bg-[var(--acid)]"
          : "border-[var(--edge-strong)] bg-[var(--panel-soft)]"
      )}
    >
      <motion.span
        aria-hidden
        initial={false}
        animate={{ x: checked ? 18 : 2 }}
        transition={spring.press}
        className={cn(
          "absolute left-0 top-[2px] h-[18px] w-[18px] rounded-full shadow-sm transition-colors duration-150",
          checked ? "bg-[var(--shell)]" : "bg-[var(--muted)]"
        )}
      />
    </button>
  );
}

// Neutral provider label for track cards. Unlike ConnectionPill, this does NOT
// claim a connection status — a search result is just a track, not proof you are
// signed in to that service.
function ProviderTag({ provider }: { provider: Provider }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em]"
      style={{
        backgroundColor: `color-mix(in srgb, var(--${provider}) 15%, transparent)`,
        color: `var(--${provider})`
      }}
    >
      {providerLabel(provider)}
    </span>
  );
}

function TrackGrid({
  tracks,
  onPlay,
  onAdd,
  addDisabled,
  canSyncSoundCloudLikes,
  soundCloudLikedTrackIds,
  onSoundCloudLikeToggle,
  canSyncSpotifyLikes,
  spotifyLikedTrackIds,
  onSpotifyLikeToggle
}: {
  tracks: UnifiedTrack[];
  onPlay(track: UnifiedTrack): void;
  onAdd(track: UnifiedTrack): void;
  addDisabled?: boolean;
  canSyncSoundCloudLikes?: boolean;
  soundCloudLikedTrackIds?: Set<string>;
  onSoundCloudLikeToggle?: (track: UnifiedTrack, liked: boolean) => void;
  canSyncSpotifyLikes?: boolean;
  spotifyLikedTrackIds?: Set<string>;
  onSpotifyLikeToggle?: (track: UnifiedTrack, liked: boolean) => void;
}) {
  const openTrackMenu = useAppStore((state) => state.openTrackMenu);
  return (
    <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(155px,1fr))]">
      {tracks.map((track) => {
        const likeProvider =
          canSyncSoundCloudLikes && track.provider === "soundcloud"
            ? "soundcloud"
            : canSyncSpotifyLikes && track.provider === "spotify"
              ? "spotify"
              : null;
        const isLiked =
          likeProvider === "soundcloud"
            ? soundCloudLikedTrackIds?.has(getTrackUiKey(track)) ?? false
            : likeProvider === "spotify"
              ? spotifyLikedTrackIds?.has(getTrackUiKey(track)) ?? false
              : false;
        const toggleLike = () => {
          if (likeProvider === "soundcloud") {
            onSoundCloudLikeToggle?.(track, !isLiked);
          } else if (likeProvider === "spotify") {
            onSpotifyLikeToggle?.(track, !isLiked);
          }
        };

        return (
          <div
            key={track.id}
            onContextMenu={(event) => {
              event.preventDefault();
              openTrackMenu(track, event.clientX, event.clientY);
            }}
            className="rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] p-2.5 transition hover:-translate-y-0.5 hover:border-[var(--acid)]/40"
          >
            <ArtworkImage
              track={track}
              alt={`${displayTitle(track.title)} artwork`}
              className="aspect-square w-full rounded-[var(--radius-sm)] object-cover"
            />
            <div className="mt-2">
              <div className="flex items-center justify-between gap-2">
                <ProviderTag provider={track.provider} />
                <span className="text-xs text-[var(--faint)]">{formatDuration(track.durationMs)}</span>
              </div>
              <p className="mt-2 line-clamp-2 font-display text-sm text-[var(--paper)]">{displayTitle(track.title)}</p>
              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{displayCreators(track.creators)}</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  title="Play"
                  onClick={() => onPlay(track)}
                  className="grid h-7 w-7 place-items-center rounded-full bg-[var(--acid)] text-[var(--shell)]"
                >
                  <Play className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Add to playlist"
                  onClick={() => onAdd(track)}
                  disabled={addDisabled}
                  className="grid h-7 w-7 place-items-center rounded-full border border-[var(--edge)] text-[var(--muted)] transition hover:border-[var(--acid)]/50 hover:text-[var(--paper)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                {likeProvider ? (
                  <button
                    type="button"
                    title={
                      isLiked
                        ? `Unlike on ${providerLabel(likeProvider)}`
                        : `Like on ${providerLabel(likeProvider)}`
                    }
                    onClick={toggleLike}
                    className={cn(
                      "grid h-7 w-7 place-items-center rounded-full border border-[var(--edge)] text-[var(--muted)] transition",
                      likeProvider === "spotify"
                        ? "hover:border-[var(--spotify)]/60 hover:text-[var(--spotify)]"
                        : "hover:border-[var(--soundcloud)]/60 hover:text-[var(--soundcloud)]",
                      isLiked &&
                        (likeProvider === "spotify"
                          ? "border-[var(--spotify)]/50 text-[var(--spotify)]"
                          : "border-[var(--soundcloud)]/50 text-[var(--soundcloud)]")
                    )}
                  >
                    {isLiked ? <HeartOff className="h-3.5 w-3.5" /> : <Heart className="h-3.5 w-3.5" />}
                  </button>
                ) : null}
                {track.externalUrl ? (
                  <button
                    type="button"
                    title="Open source"
                    onClick={() => void openExternal(track.externalUrl!)}
                    className="grid h-7 w-7 place-items-center rounded-full border border-[var(--edge)] text-[var(--muted)]"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TrackListRowBase({
  track,
  onPlay,
  onAdd,
  addDisabled,
  selecting,
  selected,
  onToggleSelect,
  canSyncSoundCloudLikes,
  soundCloudLikedTrackIds,
  onSoundCloudLikeToggle,
  canSyncSpotifyLikes,
  spotifyLikedTrackIds,
  onSpotifyLikeToggle,
  isActive
}: {
  track: UnifiedTrack;
  onPlay(): void;
  onAdd?: () => void;
  addDisabled?: boolean;
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  canSyncSoundCloudLikes?: boolean;
  soundCloudLikedTrackIds?: Set<string>;
  onSoundCloudLikeToggle?: (track: UnifiedTrack, liked: boolean) => void;
  canSyncSpotifyLikes?: boolean;
  spotifyLikedTrackIds?: Set<string>;
  onSpotifyLikeToggle?: (track: UnifiedTrack, liked: boolean) => void;
  isActive?: boolean;
}) {
  const likeProvider =
    canSyncSoundCloudLikes && track.provider === "soundcloud"
      ? "soundcloud"
      : canSyncSpotifyLikes && track.provider === "spotify"
        ? "spotify"
        : null;
  const isLiked =
    likeProvider === "soundcloud"
      ? soundCloudLikedTrackIds?.has(getTrackUiKey(track)) ?? false
      : likeProvider === "spotify"
        ? spotifyLikedTrackIds?.has(getTrackUiKey(track)) ?? false
        : false;
  const toggleLike = () => {
    if (likeProvider === "soundcloud") {
      onSoundCloudLikeToggle?.(track, !isLiked);
    } else if (likeProvider === "spotify") {
      onSpotifyLikeToggle?.(track, !isLiked);
    }
  };

  const openTrackMenu = useAppStore((state) => state.openTrackMenu);

  // Provider tint — the mixed Library list leans each row toward its provider colour (Spotify
  // green, SoundCloud orange, YouTube red, Local blue) so you can tell them apart at a glance.
  // Selected/active rows keep the neutral --acid accent.
  const tintVar = `--${track.provider}-tint`;
  const isNeutralRow = Boolean(selected) || Boolean(isActive);

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        openTrackMenu(track, event.clientX, event.clientY);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-[var(--radius)] border p-2 transition",
        selected
          ? "border-[var(--acid)] bg-[var(--acid)]/15"
          : isActive
            ? "border-[var(--acid)] bg-[var(--acid)]/10"
            : "bg-[var(--panel)]",
        !track.playable && "opacity-45"
      )}
      style={
        isNeutralRow ? undefined : { borderColor: `color-mix(in srgb, var(${tintVar}) 30%, transparent)` }
      }
    >
      {selecting ? (
        <button
          type="button"
          onClick={onToggleSelect}
          aria-label={selected ? "Deselect track" : "Select track"}
          className={cn(
            "grid h-6 w-6 shrink-0 place-items-center rounded-full border transition",
            selected
              ? "border-[var(--acid)] bg-[var(--acid)] text-[var(--shell)]"
              : "border-[var(--edge)] text-transparent"
          )}
        >
          <CheckCircle2 className="h-4 w-4" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={selecting ? onToggleSelect : onPlay}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <ArtworkImage
          track={track}
          alt={`${displayTitle(track.title)} artwork`}
          className="h-10 w-10 rounded-[var(--radius-sm)] object-cover"
        />
        <div className="min-w-0 flex-1">
          <p
            className="truncate font-display text-sm"
            style={{
              color: isActive ? "var(--acid)" : `color-mix(in srgb, var(${tintVar}) 50%, var(--paper))`
            }}
          >
            {displayTitle(track.title)}
          </p>
          <p className="truncate text-xs text-[var(--muted)]">{displayCreators(track.creators)}</p>
        </div>
        {track.requiresGoPlus && track.provider === "soundcloud" ? (
          <span className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--soundcloud-tint)]/40 bg-[var(--soundcloud-tint)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--soundcloud-tint)]">
            Go+
          </span>
        ) : null}
        <span className="shrink-0 text-xs text-[var(--faint)]">{formatDuration(track.durationMs)}</span>
      </button>
      {onAdd ? (
        <button
          type="button"
          title="Add to playlist"
          onClick={onAdd}
          disabled={addDisabled}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)] border border-[var(--edge)] text-[var(--muted)] transition hover:border-[var(--acid)]/50 hover:text-[var(--paper)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
        </button>
      ) : null}
      {likeProvider ? (
        <button
          type="button"
          title={isLiked ? "Remove from likes" : "Add to likes"}
          onClick={toggleLike}
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)] border border-[var(--edge)] text-[var(--muted)] transition hover:border-[var(--acid)]/60 hover:text-[var(--acid)]",
            isLiked && "border-[var(--acid)]/50 text-[var(--acid)]"
          )}
        >
          {isLiked ? <HeartOff className="h-4 w-4" /> : <Heart className="h-4 w-4" />}
        </button>
      ) : null}
    </div>
  );
}

const TrackListRow = memo(TrackListRowBase);

function AddToPlaylistDialog({
  track,
  tracks,
  playlists,
  onClose,
  onAddToPlaylists,
  onAddTracks,
  onCreatePlaylist
}: {
  track?: UnifiedTrack;
  tracks?: UnifiedTrack[];
  playlists: Array<{ id: string; title: string; entries: unknown[] }>;
  onClose(): void;
  onAddToPlaylists?(playlistIds: string[], track: UnifiedTrack): Promise<void>;
  onAddTracks?(playlistId: string, tracks: UnifiedTrack[]): Promise<void>;
  onCreatePlaylist(title: string): Promise<string>;
}) {
  const multiTracks = tracks ?? [];
  const isMulti = multiTracks.length > 0;
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setAddedIds([]);
    setBusyId(null);
    setDraftTitle("");
    setCreating(false);
  }, [track?.id, multiTracks.length]);

  useEscapeClose(Boolean(track) || isMulti, onClose);

  if (!track && !isMulti) {
    return null;
  }

  const commitToPlaylist = async (playlistId: string) => {
    if (isMulti) {
      await onAddTracks?.(playlistId, multiTracks);
    } else if (track) {
      await onAddToPlaylists?.([playlistId], track);
    }
  };

  const addToPlaylist = async (playlistId: string) => {
    if (busyId || addedIds.includes(playlistId)) {
      return;
    }
    setBusyId(playlistId);
    try {
      await commitToPlaylist(playlistId);
      setAddedIds((current) => [...current, playlistId]);
    } catch {
      // The store surfaces the persistence error; keep this playlist eligible for a retry.
    } finally {
      setBusyId(null);
    }
  };

  const createAndAdd = async () => {
    const title = draftTitle.trim();
    if (!title || creating) {
      return;
    }
    setCreating(true);
    try {
      const id = await onCreatePlaylist(title);
      await commitToPlaylist(id);
      setAddedIds((current) => [...current, id]);
      setDraftTitle("");
    } catch {
      // The store surfaces the persistence error; leave the dialog open for a retry.
    } finally {
      setCreating(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={tween.quick}
        onClick={onClose}
        className="fixed inset-0 z-[49] grid place-items-center bg-[var(--mat-scrim)] px-6 backdrop-blur-md"
      >
        <motion.div
          initial={modalVariants.initial}
          animate={modalVariants.animate}
          exit={modalVariants.exit}
          transition={spring.pop}
          role="dialog"
          aria-modal="true"
          onClick={(event) => event.stopPropagation()}
          className="vibrancy glass-overlay z-[50] max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-[var(--radius-xl)] p-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="kicker">Add to playlist</p>
              <h3 className="mt-2 truncate font-display text-2xl text-[var(--paper)]">
                {isMulti ? `${multiTracks.length} tracks` : displayTitle(track!.title)}
              </h3>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Tap a playlist to add {isMulti ? "them" : "it"} instantly.
              </p>
            </div>
            <Btn kind="ghost" className="shrink-0" onClick={onClose}>
              Done
            </Btn>
          </div>

          <div className="mt-5 space-y-2">
            {playlists.length > 0 ? (
              playlists.map((playlist) => {
                const added = addedIds.includes(playlist.id);
                const busy = busyId === playlist.id;
                return (
                  <button
                    key={playlist.id}
                    type="button"
                    disabled={busy || added}
                    onClick={() => void addToPlaylist(playlist.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-[var(--radius)] border p-3 text-left transition",
                      added
                        ? "border-[var(--connect)]/55 bg-[var(--connect)]/10"
                        : "border-[var(--edge)] bg-[var(--panel)] hover:border-[var(--acid)]/45"
                    )}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-sm)] border border-[var(--edge)] text-[var(--muted)]">
                      {added ? <CheckCircle2 className="h-4 w-4 text-[var(--connect)]" /> : <Plus className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-sm text-[var(--paper)]">
                        {playlist.title}
                      </span>
                      <span className="text-xs text-[var(--muted)]">
                        {added ? "Added" : busy ? "Adding..." : `${playlist.entries.length} tracks`}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="rounded-[var(--radius)] border border-dashed border-[var(--edge)] bg-[var(--panel)] px-4 py-5 text-sm text-[var(--muted)]">
                No playlists yet.
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draftTitle.trim()) {
                  void createAndAdd();
                }
              }}
              placeholder="New playlist name"
              className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-3 text-sm text-[var(--paper)] outline-none placeholder:text-[var(--muted)]"
            />
            <button
              type="button"
              disabled={creating || !draftTitle.trim()}
              onClick={() => void createAndAdd()}
              className="rounded-[var(--radius)] bg-[var(--acid)] px-5 py-3 text-sm font-semibold text-[var(--shell)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {creating ? "Creating..." : "Create & add"}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function MixCard({ mix, onOpen, onPlay }: { mix: HomeMix; onOpen(): void; onPlay(): void }) {
  // The 2×2 collage needs 4 covers — smaller mixes fall back to one full-bleed cover
  // instead of rendering empty grid cells.
  const tiles = mix.tracks.length >= 4 ? mix.tracks.slice(0, 4) : mix.tracks.slice(0, 1);
  return (
    <motion.div
      role="button"
      tabIndex={0}
      data-motion
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      whileHover={{ y: -3, scale: 1.012 }}
      whileTap={{ scale: 0.985 }}
      transition={spring.press}
      className="group cursor-pointer rounded-[var(--radius-lg)] p-2 text-left transition-colors hover:bg-white/[0.04]"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-[var(--radius)]">
        <div className={cn("grid h-full w-full gap-px", tiles.length === 4 && "grid-cols-2 grid-rows-2")}>
          {tiles.map((track, index) => (
            <ArtworkImage
              key={`${track.id}-${index}`}
              track={track}
              alt=""
              className="h-full w-full object-cover"
            />
          ))}
        </div>
        <div className="absolute inset-0 grid place-items-center transition group-hover:bg-black/30">
          <button
            type="button"
            title="Play mix"
            onClick={(event) => {
              event.stopPropagation();
              onPlay();
            }}
            className="grid h-10 w-10 place-items-center rounded-full bg-[var(--acid)] text-[var(--shell)] opacity-0 shadow-lg transition hover:scale-105 group-hover:opacity-100"
          >
            <Play className="h-4 w-4" />
          </button>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 font-display text-sm text-[var(--paper)]">{mix.title}</p>
      <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{mix.subtitle}</p>
      <p className="mt-1 text-[11px] text-[var(--faint)]">
        {mix.tracks.length} tracks
      </p>
    </motion.div>
  );
}

function HomePage() {
  const recentTracks = useAppStore((state) => state.recentTracks);
  const playTrack = useAppStore((state) => state.playTrack);
  const playlists = useAppStore((state) => state.playlists);
  const projectTracks = useAppStore((state) => state.projectTracks);
  const dailyMixes = useAppStore((state) => state.dailyMixes);
  const mixesStatus = useAppStore((state) => state.mixesStatus);
  const generateDailyMixes = useAppStore((state) => state.generateDailyMixes);
  const startStation = useAppStore((state) => state.startStation);
  const openMix = useAppStore((state) => state.openMix);
  const openTrackMenu = useAppStore((state) => state.openTrackMenu);
  const lastStation = useAppStore((state) => state.lastStation);
  const navigate = useNavigate();
  const openMixDetail = (mix: HomeMix) => {
    openMix(mix);
    navigate("/mix");
  };
  const playMix = (mix: HomeMix) =>
    void playTrack(mix.tracks[0], mix.tracks, {
      kind: mix.kind === "station" ? "station" : "mix",
      label: mix.title,
      mixId: mix.id
    });

  const mixes = useMemo(() => buildHomeMixes(projectTracks), [projectTracks]);
  const hasSpotify = projectTracks.some((item) => item.provider === "spotify");
  const hasSoundCloud = projectTracks.some((item) => item.provider === "soundcloud");
  const showConnectHint = mixes.length === 0 && hasSpotify !== hasSoundCloud;

  // Build Daily Mixes once the library is present. generateDailyMixes() self-guards: it only
  // rebuilds when the calendar day rolls over, so this is cheap to call on mount/library changes.
  useEffect(() => {
    if (projectTracks.length >= 4) {
      void generateDailyMixes();
    }
  }, [projectTracks, generateDailyMixes]);

  return (
    <div className="space-y-4">
      {dailyMixes.length > 0 || mixesStatus === "loading" || (mixesStatus === "ready" && projectTracks.length >= 4) ? (
        <SectionCard>
          <SectionHeader
            title="Daily Mixes"
            action={
              <Btn
                kind="ghost"
                disabled={mixesStatus === "loading"}
                onClick={() => void generateDailyMixes(true)}
              >
                <RefreshCcw className={`h-3.5 w-3.5 ${mixesStatus === "loading" ? "animate-spin" : ""}`} />
                Refresh
              </Btn>
            }
          />
          <p className="text-sm text-[var(--muted)]">
            Anchored on artists you love, refreshed daily with new Spotify × SoundCloud picks.
          </p>
          <div className="mt-3 grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
            {dailyMixes.length === 0 && mixesStatus === "loading" ? (
              <div className="col-span-full">
                <EmptyState variant="grid">Building your Daily Mixes…</EmptyState>
              </div>
            ) : dailyMixes.length === 0 ? (
              <div className="col-span-full">
                <EmptyState>
                  No Daily Mixes yet — they need a few repeat artists in your library. Keep liking
                  tracks and hit Refresh.
                </EmptyState>
              </div>
            ) : (
              dailyMixes.map((mix) => (
                <MixCard
                  key={mix.id}
                  mix={mix}
                  onOpen={() => openMixDetail(mix)}
                  onPlay={() => playMix(mix)}
                />
              ))
            )}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard>
        <SectionHeader title="Stations" />
        <p className="text-sm text-[var(--muted)]">
          Pick a song — AMP builds an endless station blending Spotify & SoundCloud.
        </p>
        {lastStation ? (() => {
          const playLastStation = () =>
            void playTrack(lastStation.tracks[0], lastStation.tracks, {
              kind: "station",
              label: lastStation.title,
              mixId: lastStation.id
            });
          return (
          <button
            type="button"
            onClick={() => openMixDetail(lastStation)}
            className="mt-3 flex w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--acid)]/40 bg-[rgba(var(--song-rgb),0.07)] p-2.5 text-left transition hover:border-[var(--acid)]/70"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--acid)]/15 text-[var(--acid)]">
              <Radio className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-display text-sm text-[var(--paper)]">{lastStation.title}</span>
              <span className="block truncate text-xs text-[var(--muted)]">
                {lastStation.tracks.length} tracks — open the tracklist
              </span>
            </span>
            <span
              role="button"
              tabIndex={0}
              aria-label="Play station"
              title="Play station"
              onClick={(event) => {
                event.stopPropagation();
                playLastStation();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  playLastStation();
                }
              }}
              className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full text-[var(--muted)] transition hover:bg-white/10 hover:text-[var(--paper)]"
            >
              <Play className="h-4 w-4" />
            </span>
          </button>
          );
        })() : null}
        <div className="mt-3 grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(135px,1fr))]">
          {recentTracks.length === 0 ? (
            <div className="col-span-full">
              <EmptyState variant="grid">Play a track first, then start a station from it here.</EmptyState>
            </div>
          ) : (
            recentTracks.slice(0, 6).map((track) => (
              <button
                key={`station-${track.id}`}
                type="button"
                onClick={() => void startStation(track)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openTrackMenu(track, event.clientX, event.clientY);
                }}
                className="group rounded-[var(--radius-lg)] p-2 text-left transition hover:bg-white/[0.04]"
              >
                <div className="relative aspect-square w-full overflow-hidden rounded-[var(--radius)]">
                  <ArtworkImage
                    track={track}
                    alt=""
                    className="h-full w-full object-cover transition group-hover:scale-[1.04]"
                  />
                  <div className="absolute inset-0 grid place-items-center transition group-hover:bg-black/40">
                    <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--acid)] text-[var(--shell)] opacity-0 transition group-hover:opacity-100">
                      <Radio className="h-4 w-4" />
                    </span>
                  </div>
                </div>
                <p className="mt-2 line-clamp-2 font-display text-sm text-[var(--paper)]">{displayTitle(track.title)} Radio</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{displayCreators(track.creators)}</p>
              </button>
            ))
          )}
        </div>
      </SectionCard>

      {mixes.length > 0 ? (
        <SectionCard>
          <SectionHeader title="Your blends" />
          <p className="text-sm text-[var(--muted)]">
            Blended from your Spotify and SoundCloud libraries.
          </p>
          <div className="mt-3 grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
            {mixes.map((mix) => (
              <MixCard
                key={mix.id}
                mix={mix}
                onOpen={() => openMixDetail(mix)}
                onPlay={() => playMix(mix)}
              />
            ))}
          </div>
        </SectionCard>
      ) : null}

      {showConnectHint ? (
        <SectionCard>
          <div className="flex items-start gap-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--muted)]" />
            <p className="text-sm leading-6 text-[var(--muted)]">
              {hasSpotify ? "SoundCloud" : "Spotify"} isn't loaded yet. Connect both in Settings to
              get blended Spotify × SoundCloud mixes here.
            </p>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard>
        <SectionHeader title="Recently played" />
        <div className="mt-3 grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(135px,1fr))]">
          {recentTracks.length === 0 ? (
            <div className="col-span-full">
              <EmptyState variant="grid">Nothing played yet. Search for a track and press play.</EmptyState>
            </div>
          ) : (
            recentTracks.slice(0, 12).map((track) => (
              <button
                key={track.id}
                type="button"
                onClick={() => void playTrack(track, [track])}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openTrackMenu(track, event.clientX, event.clientY);
                }}
                className="group rounded-[var(--radius-lg)] p-2 text-left transition hover:bg-white/[0.04]"
              >
                <div className="aspect-square w-full overflow-hidden rounded-[var(--radius)]">
                  <ArtworkImage
                    track={track}
                    alt={`${displayTitle(track.title)} artwork`}
                    className="h-full w-full object-cover transition group-hover:scale-[1.04]"
                  />
                </div>
                <p className="mt-2 line-clamp-2 font-display text-sm text-[var(--paper)]">{displayTitle(track.title)}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{displayCreators(track.creators)}</p>
              </button>
            ))
          )}
        </div>
      </SectionCard>

      <SectionCard>
        <SectionHeader title="Playlists" />
        <div className="mt-3 space-y-2">
          {playlists.length === 0 ? (
            <EmptyState variant="grid">No playlists yet. Create one under Playlists.</EmptyState>
          ) : (
            playlists.slice(0, 4).map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                onClick={() => void useAppStore.getState().playPlaylist(playlist.id)}
                className="w-full rounded-[var(--radius-lg)] p-3 text-left transition hover:bg-white/[0.04]"
              >
                <p className="font-display text-sm text-[var(--paper)]">{playlist.title}</p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">{playlist.entries.length} tracks</p>
              </button>
            ))
          )}
        </div>
      </SectionCard>
    </div>
  );
}

function formatMixTotal(tracks: UnifiedTrack[]): string {
  const totalMs = tracks.reduce((sum, track) => sum + (track.durationMs || 0), 0);
  const totalMin = Math.round(totalMs / 60000);
  if (totalMin < 60) {
    return `${totalMin} min`;
  }
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

const MIX_KIND_LABEL: Record<string, string> = {
  daily: "Daily Mix",
  blend: "Blend",
  station: "Station"
};

function MixDetailPage() {
  const activeMix = useAppStore((state) => state.activeMix);
  const playTrack = useAppStore((state) => state.playTrack);
  const currentTrack = useAppStore((state) => state.playback.queue[state.playback.currentIndex]);
  const connections = useAppStore((state) => state.connections);
  const libraries = useAppStore((state) => state.libraries);
  const spotifyLikedTrackIds = useAppStore((state) => state.spotifyLikedTrackIds);
  const setSoundCloudTrackLiked = useAppStore((state) => state.setSoundCloudTrackLiked);
  const setSpotifyTrackLiked = useAppStore((state) => state.setSpotifyTrackLiked);
  const playlists = useAppStore((state) => state.playlists);
  const createPlaylist = useAppStore((state) => state.createPlaylist);
  const addTrackToPlaylist = useAppStore((state) => state.addTrackToPlaylist);
  const addTracksToPlaylist = useAppStore((state) => state.addTracksToPlaylist);
  const navigate = useNavigate();
  const [trackToAdd, setTrackToAdd] = useState<UnifiedTrack | undefined>();
  const [saveAllOpen, setSaveAllOpen] = useState(false);

  const canSyncSoundCloudLikes =
    connections.soundcloud.status === "connected" &&
    (connections.soundcloud.metadata?.source === "web-session" ||
      Boolean(connections.soundcloud.accessToken));
  const canSyncSpotifyLikes = connections.spotify.status === "connected";
  const soundCloudLikedTrackIds = useMemo(
    () => new Set((libraries.soundcloud?.items ?? []).map(getTrackUiKey)),
    [libraries.soundcloud?.items]
  );

  if (!activeMix) {
    return <Navigate to="/" replace />;
  }

  const currentKey = currentTrack ? getTrackUiKey(currentTrack) : undefined;
  const tiles = activeMix.tracks.slice(0, 4);
  const mixSource: { kind: "station" | "mix"; label: string; mixId: string } = {
    kind: activeMix.kind === "station" ? "station" : "mix",
    label: activeMix.title,
    mixId: activeMix.id
  };

  return (
    <div className="space-y-5">
      <Btn kind="ghost" className="-ml-3" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" /> Back
      </Btn>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
        <div className="h-44 w-44 shrink-0 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--edge)] shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
          <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px">
            {tiles.map((track, index) => (
              <ArtworkImage key={`${track.id}-${index}`} track={track} alt="" className="h-full w-full object-cover" />
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <p className="kicker">{MIX_KIND_LABEL[activeMix.kind] ?? "Mix"}</p>
          <h2 className="mt-2 font-display text-4xl text-[var(--paper)]">{activeMix.title}</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">{activeMix.subtitle}</p>
          <p className="mt-2 text-xs text-[var(--muted)]">
            {activeMix.tracks.length} songs • {formatMixTotal(activeMix.tracks)}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Btn
              kind="primary"
              onClick={() => void playTrack(activeMix.tracks[0], activeMix.tracks, mixSource)}
            >
              <Play className="h-4 w-4" /> Play
            </Btn>
            <Btn kind="secondary" onClick={() => setSaveAllOpen(true)}>
              <ListPlus className="h-4 w-4" /> Save as playlist
            </Btn>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        {activeMix.tracks.map((track) => (
          <TrackListRow
            key={getTrackUiKey(track)}
            track={track}
            onPlay={() => void playTrack(track, activeMix.tracks, mixSource)}
            onAdd={() => setTrackToAdd(track)}
            isActive={getTrackUiKey(track) === currentKey}
            canSyncSoundCloudLikes={canSyncSoundCloudLikes}
            soundCloudLikedTrackIds={soundCloudLikedTrackIds}
            onSoundCloudLikeToggle={(target, liked) => void setSoundCloudTrackLiked(target, liked)}
            canSyncSpotifyLikes={canSyncSpotifyLikes}
            spotifyLikedTrackIds={spotifyLikedTrackIds}
            onSpotifyLikeToggle={(target, liked) => void setSpotifyTrackLiked(target, liked)}
          />
        ))}
      </div>

      <AddToPlaylistDialog
        track={trackToAdd}
        playlists={playlists}
        onClose={() => setTrackToAdd(undefined)}
        onCreatePlaylist={createPlaylist}
        onAddToPlaylists={async (playlistIds, target) => {
          for (const playlistId of playlistIds) {
            await addTrackToPlaylist(playlistId, target);
          }
        }}
      />
      <AddToPlaylistDialog
        tracks={saveAllOpen ? activeMix.tracks : undefined}
        playlists={playlists}
        onClose={() => setSaveAllOpen(false)}
        onCreatePlaylist={createPlaylist}
        onAddTracks={async (playlistId, tracks) => {
          await addTracksToPlaylist(playlistId, tracks);
        }}
      />
    </div>
  );
}

function formatFollowers(count?: number): string | undefined {
  if (count === undefined) {
    return undefined;
  }
  const compact = new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(count);
  return `${compact} followers`;
}

/** Shared loading/error shell for the artist and album detail routes. */
function DetailPageStatus({ loading, error, onBack }: { loading?: boolean; error?: string; onBack(): void }) {
  return (
    <div className="space-y-5">
      <Btn kind="ghost" className="-ml-3" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> Back
      </Btn>
      <div className="grid place-items-center rounded-[var(--radius-lg)] border border-dashed border-[var(--edge)] bg-[var(--panel)] px-6 py-20 text-sm text-[var(--muted)]">
        {loading ? (
          <span className="flex items-center gap-2">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading…
          </span>
        ) : (
          <span>{error ?? "Something went wrong."}</span>
        )}
      </div>
    </div>
  );
}

function ArtistPage() {
  const activeArtist = useAppStore((state) => state.activeArtist);
  const playTrack = useAppStore((state) => state.playTrack);
  const startStation = useAppStore((state) => state.startStation);
  const currentTrack = useAppStore((state) => state.playback.queue[state.playback.currentIndex]);
  const connections = useAppStore((state) => state.connections);
  const libraries = useAppStore((state) => state.libraries);
  const spotifyLikedTrackIds = useAppStore((state) => state.spotifyLikedTrackIds);
  const setSoundCloudTrackLiked = useAppStore((state) => state.setSoundCloudTrackLiked);
  const setSpotifyTrackLiked = useAppStore((state) => state.setSpotifyTrackLiked);
  const openAlbumById = useAppStore((state) => state.openAlbumById);
  const playlists = useAppStore((state) => state.playlists);
  const createPlaylist = useAppStore((state) => state.createPlaylist);
  const addTrackToPlaylist = useAppStore((state) => state.addTrackToPlaylist);
  const navigate = useNavigate();
  const [trackToAdd, setTrackToAdd] = useState<UnifiedTrack | undefined>();

  const canSyncSoundCloudLikes =
    connections.soundcloud.status === "connected" &&
    (connections.soundcloud.metadata?.source === "web-session" ||
      Boolean(connections.soundcloud.accessToken));
  const canSyncSpotifyLikes = connections.spotify.status === "connected";
  const soundCloudLikedTrackIds = useMemo(
    () => new Set((libraries.soundcloud?.items ?? []).map(getTrackUiKey)),
    [libraries.soundcloud?.items]
  );

  if (!activeArtist) {
    return <Navigate to="/" replace />;
  }
  if (activeArtist.status !== "ready") {
    return (
      <DetailPageStatus
        loading={activeArtist.status === "loading"}
        error={activeArtist.error}
        onBack={() => navigate(-1)}
      />
    );
  }

  const { topTracks, albums } = activeArtist;
  const currentKey = currentTrack ? getTrackUiKey(currentTrack) : undefined;
  const artistSource = { kind: "artist" as const, label: activeArtist.name };
  const meta = [
    activeArtist.genres?.length ? activeArtist.genres.slice(0, 3).join(" · ") : undefined,
    formatFollowers(activeArtist.followers)
  ]
    .filter(Boolean)
    .join(" — ");

  return (
    <div className="space-y-5">
      <Btn kind="ghost" className="-ml-3" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" /> Back
      </Btn>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
        <div className="grid h-44 w-44 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--edge)] bg-[var(--panel)] shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
          {activeArtist.imageUrl ? (
            <img src={activeArtist.imageUrl} alt={`${activeArtist.name} portrait`} className="h-full w-full object-cover" />
          ) : (
            <UserRound className="h-16 w-16 text-[var(--muted)]" />
          )}
        </div>
        <div className="min-w-0">
          <p className="kicker">Artist · {providerLabel(activeArtist.provider)}</p>
          <h2 className="mt-2 font-display text-4xl text-[var(--paper)]">{activeArtist.name}</h2>
          {meta ? <p className="mt-2 text-sm text-[var(--muted)]">{meta}</p> : null}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {topTracks.length > 0 ? (
              <>
                <Btn
                  kind="primary"
                  onClick={() => void playTrack(topTracks[0], topTracks, artistSource)}
                >
                  <Play className="h-4 w-4" /> Play
                </Btn>
                <Btn kind="secondary" onClick={() => void startStation(topTracks[0])}>
                  <Radio className="h-4 w-4" /> Start radio
                </Btn>
              </>
            ) : null}
            {activeArtist.externalUrl ? (
              <Btn
                kind="ghost"
                onClick={() => void openExternal(activeArtist.externalUrl!)}
                title={`Open on ${providerLabel(activeArtist.provider)}`}
              >
                <ExternalLink className="h-4 w-4" />
              </Btn>
            ) : null}
          </div>
        </div>
      </div>

      {topTracks.length > 0 ? (
        <SectionCard>
          <SectionHeader title={activeArtist.provider === "spotify" ? "Popular" : "Tracks"} />
          <div className="space-y-1.5">
            {topTracks.map((track) => (
              <TrackListRow
                key={getTrackUiKey(track)}
                track={track}
                onPlay={() => void playTrack(track, topTracks, artistSource)}
                onAdd={() => setTrackToAdd(track)}
                isActive={getTrackUiKey(track) === currentKey}
                canSyncSoundCloudLikes={canSyncSoundCloudLikes}
                soundCloudLikedTrackIds={soundCloudLikedTrackIds}
                onSoundCloudLikeToggle={(target, liked) => void setSoundCloudTrackLiked(target, liked)}
                canSyncSpotifyLikes={canSyncSpotifyLikes}
                spotifyLikedTrackIds={spotifyLikedTrackIds}
                onSpotifyLikeToggle={(target, liked) => void setSpotifyTrackLiked(target, liked)}
              />
            ))}
          </div>
        </SectionCard>
      ) : null}

      {albums.length > 0 ? (
        <SectionCard>
          <SectionHeader title="Albums & singles" />
          <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(135px,1fr))]">
            {albums.map((album) => (
              <button
                key={album.id}
                type="button"
                onClick={() => {
                  void openAlbumById(album.id);
                  navigate("/album");
                }}
                className="rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] p-2.5 text-left transition hover:-translate-y-0.5 hover:border-[var(--acid)]/50"
              >
                {album.imageUrl ? (
                  <img src={album.imageUrl} alt="" className="aspect-square w-full rounded-[var(--radius-sm)] object-cover" />
                ) : (
                  <div className="grid aspect-square w-full place-items-center rounded-[var(--radius-sm)] bg-[var(--paper)]/8">
                    <Disc3 className="h-8 w-8 text-[var(--muted)]" />
                  </div>
                )}
                <p className="mt-2 line-clamp-2 font-display text-sm text-[var(--paper)]">{album.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">
                  {[album.releaseYear, album.albumType === "single" ? "Single" : "Album"]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </button>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {activeArtist.playlists?.length ? (
        <SectionCard>
          <SectionHeader title="Playlists & albums" />
          <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(135px,1fr))]">
            {activeArtist.playlists.map((collection) => (
              <button
                key={collection.id}
                type="button"
                title="Open on SoundCloud"
                onClick={() => collection.externalUrl && void openExternal(collection.externalUrl)}
                className="rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] p-2.5 text-left transition hover:-translate-y-0.5 hover:border-[var(--acid)]/50"
              >
                {collection.artworkUrl ? (
                  <img src={collection.artworkUrl} alt="" className="aspect-square w-full rounded-[var(--radius-sm)] object-cover" />
                ) : (
                  <div className="grid aspect-square w-full place-items-center rounded-[var(--radius-sm)] bg-[var(--paper)]/8">
                    <ListMusic className="h-8 w-8 text-[var(--muted)]" />
                  </div>
                )}
                <p className="mt-2 line-clamp-2 font-display text-sm text-[var(--paper)]">{collection.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{collection.trackCount} tracks</p>
              </button>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <AddToPlaylistDialog
        track={trackToAdd}
        playlists={playlists}
        onClose={() => setTrackToAdd(undefined)}
        onCreatePlaylist={createPlaylist}
        onAddToPlaylists={async (playlistIds, target) => {
          for (const playlistId of playlistIds) {
            await addTrackToPlaylist(playlistId, target);
          }
        }}
      />
    </div>
  );
}

function AlbumPage() {
  const activeAlbum = useAppStore((state) => state.activeAlbum);
  const playTrack = useAppStore((state) => state.playTrack);
  const currentTrack = useAppStore((state) => state.playback.queue[state.playback.currentIndex]);
  const connections = useAppStore((state) => state.connections);
  const libraries = useAppStore((state) => state.libraries);
  const spotifyLikedTrackIds = useAppStore((state) => state.spotifyLikedTrackIds);
  const setSoundCloudTrackLiked = useAppStore((state) => state.setSoundCloudTrackLiked);
  const setSpotifyTrackLiked = useAppStore((state) => state.setSpotifyTrackLiked);
  const playlists = useAppStore((state) => state.playlists);
  const createPlaylist = useAppStore((state) => state.createPlaylist);
  const addTrackToPlaylist = useAppStore((state) => state.addTrackToPlaylist);
  const addTracksToPlaylist = useAppStore((state) => state.addTracksToPlaylist);
  const navigate = useNavigate();
  const [trackToAdd, setTrackToAdd] = useState<UnifiedTrack | undefined>();
  const [saveAllOpen, setSaveAllOpen] = useState(false);

  const canSyncSoundCloudLikes =
    connections.soundcloud.status === "connected" &&
    (connections.soundcloud.metadata?.source === "web-session" ||
      Boolean(connections.soundcloud.accessToken));
  const canSyncSpotifyLikes = connections.spotify.status === "connected";
  const soundCloudLikedTrackIds = useMemo(
    () => new Set((libraries.soundcloud?.items ?? []).map(getTrackUiKey)),
    [libraries.soundcloud?.items]
  );

  if (!activeAlbum) {
    return <Navigate to="/" replace />;
  }
  if (activeAlbum.status !== "ready") {
    return (
      <DetailPageStatus
        loading={activeAlbum.status === "loading"}
        error={activeAlbum.error}
        onBack={() => navigate(-1)}
      />
    );
  }

  const currentKey = currentTrack ? getTrackUiKey(currentTrack) : undefined;
  const albumSource = { kind: "album" as const, label: activeAlbum.name };

  return (
    <div className="space-y-5">
      <Btn kind="ghost" className="-ml-3" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" /> Back
      </Btn>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
        <div className="grid h-44 w-44 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] shadow-[0_20px_60px_rgba(0,0,0,0.35)]">
          {activeAlbum.imageUrl ? (
            <img src={activeAlbum.imageUrl} alt={`${activeAlbum.name} cover`} className="h-full w-full object-cover" />
          ) : (
            <Disc3 className="h-16 w-16 text-[var(--muted)]" />
          )}
        </div>
        <div className="min-w-0">
          <p className="kicker">
            Album{activeAlbum.releaseYear ? ` · ${activeAlbum.releaseYear}` : ""}
          </p>
          <h2 className="mt-2 font-display text-4xl text-[var(--paper)]">{activeAlbum.name}</h2>
          {activeAlbum.artistNames.length ? (
            <p className="mt-2 text-sm text-[var(--muted)]">{activeAlbum.artistNames.join(", ")}</p>
          ) : null}
          <p className="mt-2 text-xs text-[var(--muted)]">
            {activeAlbum.tracks.length} songs • {formatMixTotal(activeAlbum.tracks)}
          </p>
          <div className="mt-4 flex items-center gap-3">
            {activeAlbum.tracks.length > 0 ? (
              <Btn
                kind="primary"
                onClick={() => void playTrack(activeAlbum.tracks[0], activeAlbum.tracks, albumSource)}
              >
                <Play className="h-4 w-4" /> Play
              </Btn>
            ) : null}
            <Btn kind="secondary" onClick={() => setSaveAllOpen(true)}>
              <ListPlus className="h-4 w-4" /> Save as playlist
            </Btn>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        {activeAlbum.tracks.map((track, index) => (
          <div key={getTrackUiKey(track)} className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-right text-xs tabular-nums text-[var(--muted)]">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <TrackListRow
                track={track}
                onPlay={() => void playTrack(track, activeAlbum.tracks, albumSource)}
                onAdd={() => setTrackToAdd(track)}
                isActive={getTrackUiKey(track) === currentKey}
                canSyncSoundCloudLikes={canSyncSoundCloudLikes}
                soundCloudLikedTrackIds={soundCloudLikedTrackIds}
                onSoundCloudLikeToggle={(target, liked) => void setSoundCloudTrackLiked(target, liked)}
                canSyncSpotifyLikes={canSyncSpotifyLikes}
                spotifyLikedTrackIds={spotifyLikedTrackIds}
                onSpotifyLikeToggle={(target, liked) => void setSpotifyTrackLiked(target, liked)}
              />
            </div>
          </div>
        ))}
      </div>

      <AddToPlaylistDialog
        track={trackToAdd}
        playlists={playlists}
        onClose={() => setTrackToAdd(undefined)}
        onCreatePlaylist={createPlaylist}
        onAddToPlaylists={async (playlistIds, target) => {
          for (const playlistId of playlistIds) {
            await addTrackToPlaylist(playlistId, target);
          }
        }}
      />
      <AddToPlaylistDialog
        tracks={saveAllOpen ? activeAlbum.tracks : undefined}
        playlists={playlists}
        onClose={() => setSaveAllOpen(false)}
        onCreatePlaylist={createPlaylist}
        onAddTracks={async (playlistId, tracks) => {
          await addTracksToPlaylist(playlistId, tracks);
        }}
      />
    </div>
  );
}

function SearchPage() {
  const searchAction = useAppStore((state) => state.search);
  const searchResults = useAppStore((state) => state.searchResults);
  const connections = useAppStore((state) => state.connections);
  const libraries = useAppStore((state) => state.libraries);
  const playlists = useAppStore((state) => state.playlists);
  const addTrackToPlaylist = useAppStore((state) => state.addTrackToPlaylist);
  const createPlaylist = useAppStore((state) => state.createPlaylist);
  const setSoundCloudTrackLiked = useAppStore((state) => state.setSoundCloudTrackLiked);
  const setSpotifyTrackLiked = useAppStore((state) => state.setSpotifyTrackLiked);
  const spotifyLikedTrackIds = useAppStore((state) => state.spotifyLikedTrackIds);
  const playTrack = useAppStore((state) => state.playTrack);
  const storeProvider = useAppStore((state) => state.searchProvider);
  const searchStatus = useAppStore((state) => state.searchStatus);
  const setSearchProvider = useAppStore((state) => state.setSearchProvider);
  const [query, setQuery] = useState(useAppStore.getState().searchQuery);
  const [trackToAdd, setTrackToAdd] = useState<UnifiedTrack | undefined>();
  const deferredQuery = useDeferredValue(query);
  const canSyncSoundCloudLikes =
    connections.soundcloud.status === "connected" &&
    (connections.soundcloud.metadata?.source === "web-session" || Boolean(connections.soundcloud.accessToken));
  const canSyncSpotifyLikes = connections.spotify.status === "connected";
  const soundCloudLikedTrackIds = useMemo(
    () => new Set((libraries.soundcloud?.items ?? []).map(getTrackUiKey)),
    [libraries.soundcloud?.items]
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void searchAction(deferredQuery, storeProvider);
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [deferredQuery, searchAction, storeProvider]);

  return (
    <>
      <div className="space-y-6">
      <SectionCard>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full max-w-3xl">
            <div className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-2.5 transition-colors focus-within:border-[var(--edge-strong)]">
              <Search className="h-4 w-4 text-[var(--muted)]" />
              <input
                value={query}
                onChange={(event) =>
                  startTransition(() => {
                    setQuery(event.target.value);
                  })
                }
                aria-label="Search Spotify, SoundCloud and YouTube"
                placeholder="Search Spotify, SoundCloud and YouTube"
                // shadow-none cancels the global input focus ring — the wrapper border is the focus cue here.
                className="w-full bg-transparent text-sm text-[var(--paper)] outline-none focus:shadow-none focus-visible:shadow-none placeholder:text-[var(--muted)]"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Search provider">
            {(["all", "spotify", "soundcloud", "youtube"] as const).map((provider) => (
              <button
                key={provider}
                type="button"
                aria-pressed={storeProvider === provider}
                // Only flip the provider — the debounced effect below re-runs the query once.
                // Calling searchAction here too used to double-fire every chip click.
                onClick={() => setSearchProvider(provider)}
                className={cn(
                  "rounded-full px-4 py-2 text-sm font-medium transition",
                  storeProvider === provider
                    ? "bg-[var(--acid)] text-[var(--shell)]"
                    : "border border-[var(--edge)] bg-[var(--panel)] text-[var(--muted)]"
                )}
              >
                {provider === "all" ? "All" : providerLabel(provider)}
              </button>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard>
        {searchResults.length === 0 ? (
          searchStatus === "loading" ? (
            <div className="flex items-center gap-2 py-8 text-sm text-[var(--muted)]">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Searching…
            </div>
          ) : searchStatus === "error" ? (
            <div className="flex items-start gap-2 py-6 text-sm text-[var(--muted)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn)]" />
              Search didn't go through — check your connection and try again.
            </div>
          ) : searchStatus === "ready" && query.trim() ? (
            <EmptyState>No results for “{query.trim()}”. Try another spelling or switch providers.</EmptyState>
          ) : (
            <EmptyState variant="grid">Type above to search Spotify and SoundCloud.</EmptyState>
          )
        ) : (
          <TrackGrid
            tracks={searchResults}
            onPlay={(track) => void playTrack(track, searchResults, { kind: "search", label: "Search results" })}
            onAdd={(track) => setTrackToAdd(track)}
            canSyncSoundCloudLikes={canSyncSoundCloudLikes}
            soundCloudLikedTrackIds={soundCloudLikedTrackIds}
            onSoundCloudLikeToggle={(track, liked) => void setSoundCloudTrackLiked(track, liked)}
            canSyncSpotifyLikes={canSyncSpotifyLikes}
            spotifyLikedTrackIds={spotifyLikedTrackIds}
            onSpotifyLikeToggle={(track, liked) => void setSpotifyTrackLiked(track, liked)}
          />
        )}
      </SectionCard>
      </div>
      <AddToPlaylistDialog
        track={trackToAdd}
        playlists={playlists}
        onClose={() => setTrackToAdd(undefined)}
        onCreatePlaylist={createPlaylist}
        onAddToPlaylists={async (playlistIds, track) => {
          for (const playlistId of playlistIds) {
            await addTrackToPlaylist(playlistId, track);
          }
        }}
      />
    </>
  );
}

/** Combine the two providers' liked tracks into one alternating mix (Spotify, SoundCloud, …). */
function interleaveLibrary(a: UnifiedTrack[], b: UnifiedTrack[]): UnifiedTrack[] {
  const out: UnifiedTrack[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

function LibraryPage() {
  const libraries = useAppStore((state) => state.libraries);
  const librarySync = useAppStore((state) => state.librarySync);
  const connections = useAppStore((state) => state.connections);
  const playlists = useAppStore((state) => state.playlists);
  const hydrateLibraries = useAppStore((state) => state.hydrateLibraries);
  const addTrackToPlaylist = useAppStore((state) => state.addTrackToPlaylist);
  const addTracksToPlaylist = useAppStore((state) => state.addTracksToPlaylist);
  const createPlaylist = useAppStore((state) => state.createPlaylist);
  const setSoundCloudTrackLiked = useAppStore((state) => state.setSoundCloudTrackLiked);
  const setSpotifyTrackLiked = useAppStore((state) => state.setSpotifyTrackLiked);
  const playTrack = useAppStore((state) => state.playTrack);
  const activeTrackId = useAppStore((state) => state.playback.queue[state.playback.currentIndex]?.id);
  const spotifyLikedTrackIds = useAppStore((state) => state.spotifyLikedTrackIds);
  const shuffle = useAppStore((state) => state.shuffle);
  const toggleShuffle = useAppStore((state) => state.toggleShuffle);
  const trackFeatures = useAppStore((state) => state.trackFeatures);
  const featuresStatus = useAppStore((state) => state.featuresStatus);
  const enrichLibraryFeatures = useAppStore((state) => state.enrichLibraryFeatures);
  const localTracks = useAppStore((state) => state.localTracks);
  const loadLocalMusic = useAppStore((state) => state.loadLocalMusic);
  const canSyncSpotifyLikes = connections.spotify.status === "connected";
  const [filter, setFilter] = useState("");
  const [trackToAdd, setTrackToAdd] = useState<UnifiedTrack | undefined>();
  const [selecting, setSelecting] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [multiAddOpen, setMultiAddOpen] = useState(false);
  const [providerFilter, setProviderFilter] = useState<"all" | Provider>("all");
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const query = filter.trim().toLowerCase();
  const canSyncSoundCloudLikes =
    connections.soundcloud.status === "connected" &&
    (connections.soundcloud.metadata?.source === "web-session" || Boolean(connections.soundcloud.accessToken));
  const soundCloudLikedTrackIds = useMemo(
    () => new Set((libraries.soundcloud?.items ?? []).map(getTrackUiKey)),
    [libraries.soundcloud?.items]
  );
  const allItems = useMemo(
    () => [
      ...interleaveLibrary(libraries.spotify?.items ?? [], libraries.soundcloud?.items ?? []),
      ...localTracks
    ],
    [libraries.spotify?.items, libraries.soundcloud?.items, localTracks]
  );
  const scopedItems = useMemo(
    () =>
      providerFilter === "all"
        ? allItems
        : allItems.filter((track) => track.provider === providerFilter),
    [allItems, providerFilter]
  );
  const items = useMemo(
    () =>
      query
        ? scopedItems.filter(
            (track) =>
              track.title.toLowerCase().includes(query) ||
              track.creators.join(" ").toLowerCase().includes(query)
          )
        : scopedItems,
    [scopedItems, query]
  );
  // Spotify-style filter chips, built dynamically from the library's enriched data: the tempo/energy
  // moods and the most-represented genres that actually have tracks (plus an Unknown bucket for
  // not-yet-enriched / unmatched tracks). Based on the provider scope so chips track the active tab.
  const chips = useMemo(() => {
    const moodCounts = new Map<TempoBucket, number>();
    const genreCounts = new Map<string, number>();
    let unknown = 0;
    for (const track of scopedItems) {
      const features = featuresFor(track, trackFeatures);
      if (!features || (!features.tempoBucket && features.genres.length === 0)) {
        unknown += 1;
        continue;
      }
      if (features.tempoBucket) {
        moodCounts.set(features.tempoBucket, (moodCounts.get(features.tempoBucket) ?? 0) + 1);
      }
      for (const genre of features.genres) {
        genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
      }
    }
    const moodChips = TEMPO_BUCKET_ORDER.filter((bucket) => (moodCounts.get(bucket) ?? 0) > 0).map(
      (bucket) => ({ id: `mood:${bucket}`, label: TEMPO_BUCKET_LABELS[bucket] })
    );
    const genreChips = [...genreCounts.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([genre]) => ({ id: `genre:${genre}`, label: genre }));
    return { moodChips, genreChips, unknown };
  }, [scopedItems, trackFeatures]);

  const displayedItems = useMemo(() => {
    if (!selectedChip) {
      return items;
    }
    return items.filter((track) => {
      const features = featuresFor(track, trackFeatures);
      if (selectedChip === "unknown") {
        return !features || (!features.tempoBucket && features.genres.length === 0);
      }
      if (selectedChip.startsWith("mood:")) {
        return features?.tempoBucket === selectedChip.slice(5);
      }
      if (selectedChip.startsWith("genre:")) {
        return features?.genres.includes(selectedChip.slice(6)) ?? false;
      }
      return true;
    });
  }, [items, selectedChip, trackFeatures]);
  const selectedTracks = useMemo(
    () => allItems.filter((item) => selectedKeys.has(item.id)),
    [allItems, selectedKeys]
  );
  const toggleSelectKey = (key: string) =>
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  const exitSelection = () => {
    setSelecting(false);
    setSelectedKeys(new Set());
  };

  useEffect(() => {
    void hydrateLibraries();
  }, [hydrateLibraries]);

  // Scan configured local-music folders once when the Library opens (store no-ops if none).
  useEffect(() => {
    void loadLocalMusic();
  }, [loadLocalMusic]);

  // Background-enrich the library with Deezer tempo/loudness + provider genres once it's loaded,
  // so the mood/genre chips fill in (and the radio scorer gains real vibe data). Throttled and
  // idempotent in the store, so re-running on library growth only fetches the new tracks.
  useEffect(() => {
    if (allItems.length > 0) {
      void enrichLibraryFeatures();
    }
  }, [enrichLibraryFeatures, allItems.length]);

  return (
    <>
      {/* min-h-0 flex-1 inside the fill PageFrame: exact available height, so the VirtualList is
          the ONLY scroller — no second page-level scrollbar fighting it. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <SectionHeader title="Your library" />
            <p className="text-sm text-[var(--muted)]">
              <span style={{ color: "color-mix(in srgb, var(--spotify-tint) 60%, var(--paper))" }}>Spotify</span>
              {" + "}
              <span style={{ color: "color-mix(in srgb, var(--soundcloud-tint) 60%, var(--paper))" }}>
                SoundCloud
              </span>
              {localTracks.length > 0 ? (
                <>
                  {" + "}
                  <span style={{ color: "color-mix(in srgb, var(--local-tint) 60%, var(--paper))" }}>Local</span>
                </>
              ) : null}
              {", one collection"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {displayedItems.length > 0 ? (
              <Btn
                kind="primary"
                onClick={() => {
                  if (!shuffle) {
                    toggleShuffle();
                  }
                  void playTrack(
                    displayedItems[Math.floor(Math.random() * displayedItems.length)] ?? displayedItems[0],
                    displayedItems,
                    {
                      kind: "library",
                      label: "Liked Songs"
                    }
                  );
                }}
              >
                <Shuffle className="h-4 w-4" />
                Shuffle play
              </Btn>
            ) : null}
            <Btn
              kind="secondary"
              onClick={() => (selecting ? exitSelection() : setSelecting(true))}
              style={
                selecting
                  ? { borderColor: "color-mix(in srgb, var(--acid) 60%, transparent)" }
                  : undefined
              }
            >
              {selecting ? "Done" : "Select"}
            </Btn>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {(
            [
              { id: "all", label: "All", tint: null },
              { id: "spotify", label: "Spotify", tint: "--spotify-tint" },
              { id: "soundcloud", label: "SoundCloud", tint: "--soundcloud-tint" },
              ...(localTracks.length > 0
                ? ([{ id: "local", label: "Local", tint: "--local-tint" }] as const)
                : [])
            ] as const
          ).map((tab) => {
            const active = providerFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setProviderFilter(tab.id);
                  setSelectedChip(null);
                  // Selection is keyed to what's visible — keeping it across a scope switch would
                  // let "Add to playlist" silently include tracks the new tab hides.
                  exitSelection();
                }}
                className={cn(
                  "rounded-full border px-4 py-1.5 text-sm font-medium transition",
                  active && !tab.tint
                    ? "border-[var(--acid)] bg-[var(--acid)] text-[var(--shell)]"
                    : active
                      ? "border-transparent text-[var(--shell)]"
                      : "border-[var(--edge)] text-[var(--muted)] hover:text-[var(--paper)]"
                )}
                style={
                  active && tab.tint
                    ? { backgroundColor: `var(${tab.tint})`, borderColor: `var(${tab.tint})` }
                    : !active && tab.tint
                      ? { color: `color-mix(in srgb, var(${tab.tint}) 60%, var(--paper))` }
                      : undefined
                }
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {chips.moodChips.length > 0 || chips.genreChips.length > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {[...chips.moodChips, ...chips.genreChips].map((chip) => {
              const active = selectedChip === chip.id;
              return (
                <button
                  key={chip.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedChip(active ? null : chip.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition",
                    active
                      ? "border-[var(--acid)] bg-[var(--acid)] text-[var(--shell)]"
                      : "border-[var(--edge)] text-[var(--muted)] hover:text-[var(--paper)]"
                  )}
                >
                  {chip.label}
                </button>
              );
            })}
            {chips.unknown > 0 ? (
              <button
                type="button"
                onClick={() => setSelectedChip(selectedChip === "unknown" ? null : "unknown")}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition",
                  selectedChip === "unknown"
                    ? "border-[var(--acid)] bg-[var(--acid)] text-[var(--shell)]"
                    : "border-[var(--edge)] text-[var(--muted)] hover:text-[var(--paper)]"
                )}
              >
                Unknown
              </button>
            ) : null}
            {featuresStatus === "enriching" ? (
              <span className="text-xs text-[var(--muted)]">Analyzing…</span>
            ) : null}
          </div>
        ) : featuresStatus === "enriching" ? (
          <p className="shrink-0 text-xs text-[var(--muted)]">Analyzing your library for moods &amp; genres…</p>
        ) : null}

        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Search your library"
          placeholder="Search your library…"
          className="shrink-0 rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-2.5 text-sm text-[var(--paper)] outline-none placeholder:text-[var(--muted)]"
        />

        {allItems.length ? (
          <p className="shrink-0 text-xs text-[var(--muted)]">
            {query || selectedChip
              ? `${displayedItems.length.toLocaleString()} of ${scopedItems.length.toLocaleString()} tracks`
              : `${scopedItems.length.toLocaleString()} tracks`}
          </p>
        ) : null}

        {displayedItems.length ? (
          <VirtualList
            className="min-h-0 flex-1 overflow-y-auto pr-1"
            items={displayedItems}
            rowHeight={64}
            getKey={(track) => track.id}
            renderRow={(track) => (
              <TrackListRow
                track={track}
                onPlay={() => void playTrack(track, displayedItems, { kind: "library", label: "Liked Songs" })}
                onAdd={() => setTrackToAdd(track)}
                selecting={selecting}
                selected={selectedKeys.has(track.id)}
                onToggleSelect={() => toggleSelectKey(track.id)}
                canSyncSoundCloudLikes={canSyncSoundCloudLikes}
                soundCloudLikedTrackIds={soundCloudLikedTrackIds}
                onSoundCloudLikeToggle={(item, liked) => void setSoundCloudTrackLiked(item, liked)}
                canSyncSpotifyLikes={canSyncSpotifyLikes}
                spotifyLikedTrackIds={spotifyLikedTrackIds}
                onSpotifyLikeToggle={(item, liked) => void setSpotifyTrackLiked(item, liked)}
                isActive={track.id === activeTrackId}
              />
            )}
          />
        ) : librarySync.spotify.syncing || librarySync.soundcloud.syncing ? (
          // Skeleton rows sized like real TrackListRows, so the list doesn't jump when tracks land.
          <div aria-hidden className="min-h-0 flex-1 space-y-1.5 overflow-hidden pr-1">
            {Array.from({ length: 8 }, (_, index) => (
              <div
                key={index}
                className="h-[56px] animate-pulse rounded-[var(--radius)] bg-white/[0.03]"
                style={{ animationDelay: `${index * 90}ms` }}
              />
            ))}
          </div>
        ) : (
          <EmptyState>
            {query && scopedItems.length > 0
              ? "No matches in your library."
              : selectedChip && scopedItems.length > 0
                ? "No tracks match this filter yet."
              : providerFilter !== "all" && allItems.length > 0
                ? `No ${providerFilter === "spotify" ? "Spotify" : "SoundCloud"} tracks in your library yet.`
                : connections.spotify.status === "connected" || connections.soundcloud.status === "connected"
                    ? "Your liked songs will appear here once they finish importing."
                    : "Connect Spotify or SoundCloud in Settings to load your liked songs. SoundCloud also plays without sign-in — just use Search."}
          </EmptyState>
        )}
      </div>
      {selecting && selectedTracks.length > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-28 z-40 flex justify-center px-6">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-[var(--edge)] bg-[var(--panel-strong)] px-5 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.4)]">
            <span className="text-sm font-semibold text-[var(--paper)]">
              {selectedTracks.length} selected
            </span>
            <Btn kind="primary" onClick={() => setMultiAddOpen(true)}>
              Add to playlist
            </Btn>
            <Btn kind="ghost" onClick={exitSelection}>
              Clear
            </Btn>
          </div>
        </div>
      ) : null}
      <AddToPlaylistDialog
        track={trackToAdd}
        playlists={playlists}
        onClose={() => setTrackToAdd(undefined)}
        onCreatePlaylist={createPlaylist}
        onAddToPlaylists={async (playlistIds, track) => {
          for (const playlistId of playlistIds) {
            await addTrackToPlaylist(playlistId, track);
          }
        }}
      />
      <AddToPlaylistDialog
        tracks={multiAddOpen ? selectedTracks : undefined}
        playlists={playlists}
        onClose={() => {
          setMultiAddOpen(false);
          exitSelection();
        }}
        onCreatePlaylist={createPlaylist}
        onAddTracks={async (playlistId, tracksToAdd) => {
          await addTracksToPlaylist(playlistId, tracksToAdd);
        }}
      />
    </>
  );
}

type PlaylistTab = "mine" | "spotify" | "soundcloud";

const PLAYLIST_TABS: Array<{ id: PlaylistTab; label: string }> = [
  { id: "mine", label: "Mine" },
  { id: "spotify", label: "Spotify" },
  { id: "soundcloud", label: "SoundCloud" }
];

function ProviderPlaylistImport({
  provider,
  onImported
}: {
  provider: "spotify" | "soundcloud";
  onImported(): void;
}) {
  const collections = useAppStore((state) => state.providerCollections[provider]);
  const connection = useAppStore((state) => state.connections[provider]);
  const importCollectionAsPlaylist = useAppStore((state) => state.importCollectionAsPlaylist);
  const [busyId, setBusyId] = useState<string | null>(null);
  const label = provider === "spotify" ? "Spotify" : "SoundCloud";

  const playlists = (collections ?? []).filter(
    (item) => item.kind === "playlist" || item.kind === "saved-tracks"
  );

  if (connection.status !== "connected") {
    return (
      <SectionCard>
        <SectionHeader title={`${label} playlists`} />
        <p className="text-sm text-[var(--muted)]">
          Connect {label} in Settings to browse and import your playlists.
        </p>
      </SectionCard>
    );
  }

  const runImport = async (collectionId: string, title: string) => {
    if (busyId) {
      return;
    }
    setBusyId(collectionId);
    try {
      // Only jump to the "Mine" tab when the import actually created a playlist — a failed
      // import used to navigate away as if it had worked.
      const imported = await importCollectionAsPlaylist(provider, collectionId, title);
      if (imported) {
        onImported();
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SectionCard>
      <SectionHeader title={`${label} playlists`} />
      <p className="text-sm text-[var(--muted)]">
        Copy a {label} playlist into a local AMP playlist you can reorder and mix.
      </p>

      {playlists.length === 0 ? (
        <div className="mt-5">
          <EmptyState>No {label} playlists loaded yet. Sync the provider in Settings, then come back.</EmptyState>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {playlists.map((collection) => {
            const busy = busyId === collection.id;
            return (
              <div
                key={collection.id}
                className="flex items-center gap-4 rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-display text-lg text-[var(--paper)]">{collection.title}</p>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {(collection.trackCount ?? 0).toLocaleString()} tracks · {label}
                  </p>
                </div>
                <Btn
                  kind="secondary"
                  disabled={busy}
                  onClick={() => void runImport(collection.id, collection.title)}
                  className="shrink-0"
                >
                  {busy ? "Importing…" : "Import"}
                </Btn>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function PlaylistsPage() {
  const playlists = useAppStore((state) => state.playlists);
  const selectedPlaylistId = useAppStore((state) => state.selectedPlaylistId) ?? playlists[0]?.id;
  const selectPlaylist = useAppStore((state) => state.selectPlaylist);
  const createPlaylist = useAppStore((state) => state.createPlaylist);
  const renamePlaylist = useAppStore((state) => state.renamePlaylist);
  const deletePlaylist = useAppStore((state) => state.deletePlaylist);
  const removeTrackFromPlaylist = useAppStore((state) => state.removeTrackFromPlaylist);
  const connections = useAppStore((state) => state.connections);
  const libraries = useAppStore((state) => state.libraries);
  const setSoundCloudTrackLiked = useAppStore((state) => state.setSoundCloudTrackLiked);
  const setSpotifyTrackLiked = useAppStore((state) => state.setSpotifyTrackLiked);
  const spotifyLikedTrackIds = useAppStore((state) => state.spotifyLikedTrackIds);
  const reorderPlaylist = useAppStore((state) => state.reorderPlaylist);
  const playTrack = useAppStore((state) => state.playTrack);
  const playPlaylist = useAppStore((state) => state.playPlaylist);
  const [draftTitle, setDraftTitle] = useState("");
  const [tab, setTab] = useState<PlaylistTab>("mine");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const canSyncSoundCloudLikes =
    connections.soundcloud.status === "connected" &&
    (connections.soundcloud.metadata?.source === "web-session" || Boolean(connections.soundcloud.accessToken));
  const canSyncSpotifyLikes = connections.spotify.status === "connected";
  const soundCloudLikedTrackIds = useMemo(
    () => new Set((libraries.soundcloud?.items ?? []).map(getTrackUiKey)),
    [libraries.soundcloud?.items]
  );

  const activePlaylist = playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? playlists[0];
  const [renameValue, setRenameValue] = useState(activePlaylist?.title ?? "");

  useEffect(() => {
    setRenameValue(activePlaylist?.title ?? "");
  }, [activePlaylist?.id, activePlaylist?.title]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {PLAYLIST_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              "rounded-full border px-5 py-2 text-sm font-semibold transition",
              tab === entry.id
                ? "border-[var(--acid)]/55 bg-[var(--paper)]/8 text-[var(--paper)]"
                : "border-[var(--edge)] bg-[var(--panel)] text-[var(--muted)] hover:text-[var(--paper)]"
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {tab === "mine" ? (
      <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
      <SectionCard>
        <SectionHeader title="Your playlists" />

        <form
          className="mt-5 flex gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draftTitle.trim()) {
              return;
            }
            void createPlaylist(draftTitle.trim());
            setDraftTitle("");
          }}
        >
          <input
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            placeholder="New playlist title"
            className="w-full rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-3 text-sm text-[var(--paper)] outline-none"
          />
          <Btn kind="primary" type="submit">
            <Plus className="h-4 w-4" />
          </Btn>
        </form>

        <div className="mt-5 space-y-3">
          {playlists.map((playlist) => (
            <button
              key={playlist.id}
              type="button"
              onClick={() => selectPlaylist(playlist.id)}
              className={cn(
                "w-full rounded-[var(--radius-lg)] p-4 text-left transition",
                selectedPlaylistId === playlist.id
                  ? "bg-[var(--paper)]/8"
                  : "hover:bg-white/[0.04]"
              )}
            >
              <p className="font-display text-xl text-[var(--paper)]">{playlist.title}</p>
              <p className="mt-2 text-sm text-[var(--muted)]">{playlist.entries.length} tracks</p>
            </button>
          ))}
        </div>
      </SectionCard>

      {activePlaylist ? (
        <SectionCard>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="kicker">Playlist editor</p>
              <input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                aria-label="Playlist title"
                onBlur={() => {
                  if (renameValue.trim() && renameValue !== activePlaylist.title) {
                    void renamePlaylist(activePlaylist.id, renameValue.trim());
                  } else if (!renameValue.trim()) {
                    // A blank title isn't saved — snap the field back so it doesn't sit empty
                    // and out of sync with the real name.
                    setRenameValue(activePlaylist.title);
                  }
                }}
                className="mt-3 w-full bg-transparent font-display text-4xl text-[var(--paper)] outline-none"
              />
            </div>
            <div className="flex gap-3">
              <Btn
                kind="primary"
                disabled={activePlaylist.entries.length === 0}
                onClick={() => void playPlaylist(activePlaylist.id)}
              >
                Play queue
              </Btn>
              <Btn kind="ghost" onClick={() => setConfirmDeleteId(activePlaylist.id)}>
                Delete
              </Btn>
            </div>
          </div>

          <div className="mt-6">
            <Reorder.Group
              axis="y"
              values={activePlaylist.entries}
              onReorder={(nextEntries) =>
                void reorderPlaylist(activePlaylist.id, nextEntries.map((entry) => entry.id))
              }
              className="space-y-3"
            >
              {activePlaylist.entries.map((entry) => (
                <Reorder.Item key={entry.id} value={entry} className="list-none">
                  <div className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] p-4">
                    <button
                      type="button"
                      onClick={() =>
                        void playTrack(entry.track, activePlaylist.entries.map((item) => item.track), {
                          kind: "playlist",
                          label: activePlaylist.title
                        })
                      }
                      className="flex min-w-0 flex-1 items-center gap-4 text-left"
                    >
                      <ArtworkImage
                        track={entry.track}
                        alt={`${entry.track.title} artwork`}
                        className="h-16 w-16 rounded-[var(--radius)] object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-display text-xl text-[var(--paper)]">
                          {displayTitle(entry.track.title)}
                        </p>
                        <p className="truncate text-sm text-[var(--muted)]">
                          {displayCreators(entry.track.creators)}
                        </p>
                      </div>
                      <ProviderTag provider={entry.track.provider} />
                    </button>
                    {(() => {
                      const likeProvider =
                        canSyncSoundCloudLikes && entry.track.provider === "soundcloud"
                          ? "soundcloud"
                          : canSyncSpotifyLikes && entry.track.provider === "spotify"
                            ? "spotify"
                            : null;
                      if (!likeProvider) {
                        return null;
                      }
                      const isLiked =
                        likeProvider === "soundcloud"
                          ? soundCloudLikedTrackIds.has(getTrackUiKey(entry.track))
                          : spotifyLikedTrackIds.has(getTrackUiKey(entry.track));
                      return (
                        <button
                          type="button"
                          title={
                            isLiked
                              ? `Unlike on ${providerLabel(likeProvider)}`
                              : `Like on ${providerLabel(likeProvider)}`
                          }
                          onClick={() => {
                            if (likeProvider === "soundcloud") {
                              void setSoundCloudTrackLiked(entry.track, !isLiked);
                            } else {
                              void setSpotifyTrackLiked(entry.track, !isLiked);
                            }
                          }}
                          className={cn(
                            "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius)] border border-[var(--edge)] text-[var(--muted)] transition",
                            likeProvider === "spotify"
                              ? "hover:border-[var(--spotify)]/60 hover:text-[var(--spotify)]"
                              : "hover:border-[var(--soundcloud)]/60 hover:text-[var(--soundcloud)]",
                            isLiked &&
                              (likeProvider === "spotify"
                                ? "border-[var(--spotify)]/50 text-[var(--spotify)]"
                                : "border-[var(--soundcloud)]/50 text-[var(--soundcloud)]")
                          )}
                        >
                          {isLiked ? <HeartOff className="h-4 w-4" /> : <Heart className="h-4 w-4" />}
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      title="Remove from playlist"
                      onClick={() => void removeTrackFromPlaylist(activePlaylist.id, entry.id)}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius)] border border-[var(--edge)] text-[var(--muted)] transition hover:border-[var(--warn)]/60 hover:text-[var(--warn)]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </Reorder.Item>
              ))}
            </Reorder.Group>
          </div>
        </SectionCard>
      ) : null}
      </div>
      ) : (
        <ProviderPlaylistImport provider={tab} onImported={() => setTab("mine")} />
      )}
      <ConfirmDialog
        open={Boolean(confirmDeleteId)}
        title="Delete playlist?"
        body={`"${playlists.find((playlist) => playlist.id === confirmDeleteId)?.title ?? "This playlist"}" will be removed from AMP. The tracks stay in your library.`}
        confirmLabel="Delete playlist"
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) {
            void deletePlaylist(confirmDeleteId);
          }
          setConfirmDeleteId(null);
        }}
      />
    </div>
  );
}

type SoundCloudConnectView =
  | "methods"
  | "local-explain"
  | "profiles"
  | "connecting"
  | "waiting-signin"
  | "browser-running";

function SoundCloudConnectCard({ onRequestOAuth }: { onRequestOAuth(): void }) {
  const connection = useAppStore((state) => state.connections.soundcloud);
  const runtime = useAppStore((state) => state.runtime);
  const librarySync = useAppStore((state) => state.librarySync.soundcloud);
  const profiles = useAppStore((state) => state.soundCloudLocalProfiles);
  const localStatus = useAppStore((state) => state.soundCloudLocalStatus);
  const localError = useAppStore((state) => state.soundCloudLocalError);
  const loadProfiles = useAppStore((state) => state.loadSoundCloudLocalProfiles);
  const connectViaBrowser = useAppStore((state) => state.connectSoundCloudViaBrowser);
  const connectLocalProfile = useAppStore((state) => state.connectSoundCloudLocalProfile);
  const openLocalSignin = useAppStore((state) => state.openSoundCloudLocalSignin);
  const closeLocalBrowser = useAppStore((state) => state.closeSoundCloudLocalBrowser);
  const disconnectProvider = useAppStore((state) => state.disconnectProvider);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SoundCloudConnectView>("methods");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const closeConnect = () => {
    setOpen(false);
    setView("methods");
  };
  useEscapeClose(open, closeConnect);

  const isConnected = connection.status === "connected";
  const isLoading = connection.status === "connecting" || localStatus === "connecting" || localStatus === "syncing";
  const source = connection.metadata?.source;
  const profileId = connection.metadata?.profileId;
  const likesCount = Number(connection.metadata?.likesCount ?? librarySync.importedCount ?? 0);
  const playlistsCount = Number(connection.metadata?.playlistsCount ?? 0);
  const lastSyncedAt = connection.metadata?.lastSyncedAt ?? connection.connectedAt;
  const connectionLabel =
    source === "local-connect"
      ? connection.metadata?.connectionMode === "system-browser" ||
        connection.metadata?.connectionMode === "in-app-signin"
        ? "Signed in to SoundCloud"
        : "SoundCloud Local Connect"
      : source === "web-session"
        ? "Legacy browser session"
        : "Official API credentials";

  useEffect(() => {
    if (!selectedProfileId && profiles.length > 0) {
      setSelectedProfileId(profiles.find((profile) => profile.status === "available")?.id ?? profiles[0].id);
    }
  }, [profiles, selectedProfileId]);

  useEffect(() => {
    if (!open || view !== "browser-running" || !selectedProfileId) {
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      const current = useAppStore.getState();
      if (current.soundCloudLocalStatus === "connecting" || current.soundCloudLocalStatus === "syncing") {
        return;
      }
      void (async () => {
        await connectLocalProfile(selectedProfileId);
        if (cancelled) {
          return;
        }
        const next = useAppStore.getState();
        if (next.connections.soundcloud.status === "connected") {
          setOpen(false);
          setView("methods");
          return;
        }
        // Keep waiting ONLY while the browser is still open. Any other outcome — no session found
        // (e.g. that browser isn't signed into SoundCloud), App-Bound Encryption, denied
        // Keychain/Full-Disk — won't be fixed by closing again, so surface it on the profiles view
        // and stop polling instead of relaunching the browser read forever.
        if (next.soundCloudLocalError?.code !== "browser-running") {
          setView("profiles");
        }
      })();
    }, 1800);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, view, selectedProfileId, connectLocalProfile]);

  // Guided sign-in: after we open the real browser to the SoundCloud login, poll the existing
  // cookie-read connect until the freshly-created session token appears (works while the browser
  // stays open on macOS). On Windows the cookie DB is locked, so a browser-running result routes to
  // the "close browser to finish" view.
  useEffect(() => {
    if (!open || view !== "waiting-signin" || !selectedProfileId) {
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      const current = useAppStore.getState();
      if (current.soundCloudLocalStatus === "connecting" || current.soundCloudLocalStatus === "syncing") {
        return;
      }
      void (async () => {
        await connectLocalProfile(selectedProfileId);
        if (cancelled) {
          return;
        }
        const next = useAppStore.getState();
        const errorCode = next.soundCloudLocalError?.code;
        if (next.connections.soundcloud.status === "connected") {
          setOpen(false);
          setView("methods");
        } else if (errorCode === "browser-running") {
          setView("browser-running");
        } else if (
          errorCode === "keychain-denied" ||
          errorCode === "full-disk-access" ||
          errorCode === "app-bound-encryption"
        ) {
          // Terminal — waiting won't fix these; show the actionable message and stop polling.
          setView("profiles");
        }
        // Any other result (e.g. no-session-found) means "still waiting" — keep polling.
      })();
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, view, selectedProfileId, connectLocalProfile]);

  const openConnect = (nextView: SoundCloudConnectView = "methods") => {
    setView(nextView);
    setOpen(true);
  };

  const openProfiles = async () => {
    setView("profiles");
    setOpen(true);
    await loadProfiles();
  };

  const handleRefresh = async () => {
    // System-browser sign-in re-reads its persistent profile silently (no window if still valid).
    if (source === "local-connect" && connection.metadata?.connectionMode === "system-browser") {
      await connectViaBrowser();
      return;
    }
    if (source === "local-connect" && profileId) {
      await connectLocalProfile(profileId);
      return;
    }

    await openProfiles();
  };

  const handleConnectSelectedProfile = async () => {
    if (!selectedProfileId) {
      return;
    }

    setView("connecting");
    await connectLocalProfile(selectedProfileId);
    const afterConnect = useAppStore.getState();
    if (afterConnect.connections.soundcloud.status === "connected") {
      setOpen(false);
      setView("methods");
    } else if (afterConnect.soundCloudLocalError?.code === "browser-running") {
      setView("browser-running");
    } else {
      setView("profiles");
    }
  };

  const handleSignInThenConnect = async () => {
    if (!selectedProfileId) {
      return;
    }
    const opened = await openLocalSignin(selectedProfileId);
    if (opened) {
      setView("waiting-signin");
    }
  };

  // Universal path: sign into SoundCloud in the user's REAL browser and read the token over CDP.
  // A real browser passes DataDome (which hard-blocks embedded Electron logins) and isn't subject
  // to App-Bound Encryption, so it works on Chrome/Edge/Brave alike.
  const handleBrowserSignIn = async () => {
    setView("connecting");
    await connectViaBrowser();
    const after = useAppStore.getState();
    if (after.connections.soundcloud.status === "connected") {
      setOpen(false);
      setView("methods");
    } else {
      // Cancelled or failed — back to the menu (any real error shows inline there).
      setView("methods");
    }
  };

  const availableProfiles = profiles.filter((profile) => profile.status === "available");
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);

  return (
    <>
      <SectionCard>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="kicker">SoundCloud</p>
            <h3 className="mt-3 font-display text-2xl text-[var(--paper)]">Connect SoundCloud</h3>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">
              Sign in through your browser to bring in your likes and playlists — works on Chrome, Edge,
              and Brave. Reusing an existing Brave or Firefox session is available too.
            </p>
          </div>
          <ConnectionPill provider="soundcloud" status={connection.status} />
        </div>

        {isConnected ? (
          <div className="mt-5 rounded-[var(--radius-lg)] border border-[var(--connect)]/35 bg-[var(--connect)]/10 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="flex items-center gap-2 font-display text-xl text-[var(--paper)]">
                  <CheckCircle2 className="h-5 w-5 text-[var(--connect)]" />
                  {connection.displayName ?? "SoundCloud connected"}
                </p>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{connectionLabel}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  disabled={isLoading}
                  className="rounded-full border border-[var(--edge)] px-4 py-2 text-xs font-semibold text-[var(--muted)] transition hover:border-[var(--acid)]/50 hover:text-[var(--paper)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="inline-flex items-center gap-2">
                    <RefreshCcw className="h-3.5 w-3.5" />
                    Refresh
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => openConnect("methods")}
                  className="rounded-full border border-[var(--edge)] px-4 py-2 text-xs font-semibold text-[var(--muted)] transition hover:border-[var(--acid)]/50 hover:text-[var(--paper)]"
                >
                  Manage
                </button>
                <button
                  type="button"
                  onClick={() => void disconnectProvider("soundcloud")}
                  className="rounded-full border border-[var(--edge)] px-4 py-2 text-xs font-semibold text-[var(--muted)] transition hover:border-[var(--warn)]/60 hover:text-[var(--warn)]"
                >
                  Disconnect
                </button>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <SoundCloudStat label="Likes" value={Number.isFinite(likesCount) ? likesCount.toLocaleString() : "0"} />
              <SoundCloudStat
                label="Playlists"
                value={Number.isFinite(playlistsCount) ? playlistsCount.toLocaleString() : "0"}
              />
              <SoundCloudStat label="Last synced" value={formatClock(lastSyncedAt)} />
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-display text-xl text-[var(--paper)]">Not connected</p>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                  Recommended: sign into SoundCloud inside AMP — works on every browser, including Chrome and Edge.
                </p>
              </div>
              <button
                type="button"
                onClick={() => openConnect("methods")}
                className="rounded-full bg-[var(--acid)] px-5 py-3 text-sm font-semibold text-[var(--shell)] transition hover:brightness-110"
              >
                <span className="inline-flex items-center gap-2">
                  <LogIn className="h-4 w-4" />
                  Connect SoundCloud
                </span>
              </button>
            </div>
          </div>
        )}

        {connection.status === "error" && connection.issue ? (
          <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-[var(--warn)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {connection.issue}
          </p>
        ) : null}
      </SectionCard>

      <AnimatePresence>
        {open ? (
          <motion.div
            className="fixed inset-0 z-50 grid place-items-center bg-black/90 p-4 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--edge)] bg-[var(--shell)] p-5 shadow-2xl"
              initial={{ y: 18, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 18, opacity: 0, scale: 0.98 }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="kicker">SoundCloud</p>
                  <h3 className="mt-2 font-display text-2xl text-[var(--paper)]">
                    {view === "local-explain"
                      ? "SoundCloud Local Connect"
                      : view === "profiles"
                        ? "Choose a browser profile"
                        : view === "connecting"
                          ? "Connecting SoundCloud"
                          : view === "waiting-signin"
                            ? "Sign in to SoundCloud"
                            : view === "browser-running"
                              ? "Finish connecting"
                              : "Connection methods"}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={closeConnect}
                  className="grid h-10 w-10 place-items-center rounded-full border border-[var(--edge)] text-[var(--muted)] transition hover:text-[var(--paper)]"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {view === "methods" ? (
                <div className="mt-6 grid gap-3">
                  {localError ? <SoundCloudInlineError message={localError.message} /> : null}
                  <SoundCloudMethodButton
                    icon={<LogIn className="h-5 w-5" />}
                    label="Sign in to SoundCloud"
                    badge="Recommended"
                    description="Opens your real browser (Chrome, Edge, or Brave) at SoundCloud's login — sign in normally, including with Google, and AMP picks up the session. Works on every browser; you only do it once."
                    onClick={() => void handleBrowserSignIn()}
                  />
                  <SoundCloudMethodButton
                    icon={<Monitor className="h-5 w-5" />}
                    label="Local Connect"
                    badge="Brave / Firefox"
                    description="Reuse the SoundCloud session already signed in through your browser. Works on Brave and Firefox; Chrome and Edge lock this on Windows, so use Sign in to SoundCloud there."
                    onClick={() => setView("local-explain")}
                  />
                </div>
              ) : null}

              {view === "local-explain" ? (
                <div className="mt-6 space-y-5">
                  <div className="rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5">
                    <p className="text-sm leading-6 text-[var(--muted)]">
                      AMP reads the SoundCloud sign-in from the selected local profile and keeps it on
                      this device. Your browser only needs to be closed for a moment while it connects.
                    </p>
                    <div className="mt-5 grid gap-3 sm:grid-cols-3">
                      {[
                        "No Artist Pro credentials required.",
                        "Uses your existing browser sign-in.",
                        "Session stays on this device."
                      ].map((item) => (
                        <div key={item} className="rounded-[var(--radius-lg)] border border-[var(--edge)] p-4 text-sm text-[var(--paper)]">
                          <ShieldCheck className="mb-3 h-5 w-5 text-[var(--acid)]" />
                          {item}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setView("methods")}
                      className="rounded-full border border-[var(--edge)] px-5 py-3 text-sm text-[var(--muted)]"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => void openProfiles()}
                      className="rounded-full bg-[var(--acid)] px-5 py-3 text-sm font-semibold text-[var(--shell)]"
                    >
                      Continue
                    </button>
                  </div>
                </div>
              ) : null}

              {view === "profiles" ? (
                <div className="mt-6 space-y-4">
                  {localError ? <SoundCloudInlineError message={localError.message} /> : null}
                  {profiles.length === 0 ? (
                    <div className="rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5 text-sm leading-6 text-[var(--muted)]">
                      No Chrome, Edge, Firefox, or Brave profiles were found yet. Open SoundCloud in your browser,
                      sign in, then refresh profiles.
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {profiles.map((profile) => {
                        const disabled = profile.status !== "available";
                        const selected = selectedProfileId === profile.id;
                        return (
                          <button
                            key={profile.id}
                            type="button"
                            disabled={disabled}
                            onClick={() => setSelectedProfileId(profile.id)}
                            className={cn(
                              "flex items-center justify-between gap-4 rounded-[var(--radius-lg)] border p-4 text-left transition",
                              selected
                                ? "border-[var(--acid)] bg-[var(--paper)]/5"
                                : "border-[var(--edge)] bg-[var(--panel)] hover:border-[var(--acid)]/45",
                              disabled && "cursor-not-allowed opacity-55"
                            )}
                          >
                            <span className="flex items-center gap-3">
                              <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--paper)]/5 text-[var(--acid)]">
                                <UserRound className="h-4 w-4" />
                              </span>
                              <span>
                                <span className="block font-display text-lg text-[var(--paper)]">
                                  {profile.browserName} - {profile.profileName}
                                </span>
                                <span className="text-xs text-[var(--faint)]">
                                  {profile.statusLabel}
                                </span>
                              </span>
                            </span>
                            <span
                              className={cn(
                                "h-3 w-3 rounded-full border",
                                selected ? "border-[var(--acid)] bg-[var(--acid)]" : "border-[var(--edge)]"
                              )}
                            />
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => void loadProfiles()}
                      className="rounded-full border border-[var(--edge)] px-5 py-3 text-sm text-[var(--muted)]"
                    >
                      <span className="inline-flex items-center gap-2">
                        <RefreshCcw className="h-4 w-4" />
                        Refresh profiles
                      </span>
                    </button>
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        disabled={!selectedProfile || selectedProfile.status !== "available" || isLoading}
                        onClick={() => void handleSignInThenConnect()}
                        className={cn(
                          "rounded-full border px-5 py-3 text-sm font-semibold transition",
                          selectedProfile && selectedProfile.status === "available" && !isLoading
                            ? "border-[var(--acid)] text-[var(--paper)] hover:bg-[var(--paper)]/5"
                            : "cursor-not-allowed border-[var(--edge)] text-[var(--muted)] opacity-70"
                        )}
                      >
                        <span className="inline-flex items-center gap-2">
                          <LogIn className="h-4 w-4" />
                          Sign in to SoundCloud
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={!selectedProfile || selectedProfile.status !== "available" || isLoading || availableProfiles.length === 0}
                        onClick={() => void handleConnectSelectedProfile()}
                        className={cn(
                          "rounded-full px-5 py-3 text-sm font-semibold transition",
                          selectedProfile && selectedProfile.status === "available" && !isLoading
                            ? "bg-[var(--acid)] text-[var(--shell)]"
                            : "cursor-not-allowed border border-[var(--edge)] text-[var(--muted)] opacity-70"
                        )}
                      >
                        Connect selected profile
                      </button>
                    </div>
                  </div>
                  <p className="text-xs leading-5 text-[var(--muted)]">
                    Not signed into SoundCloud in this profile yet? <span className="text-[var(--paper)]">Sign in to SoundCloud</span> opens
                    {" "}{selectedProfile?.browserName ?? "your browser"} to the login page — finish there and AMP syncs automatically.
                  </p>
                </div>
              ) : null}

              {view === "connecting" ? (
                <div className="mt-6 rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5">
                  <div className="flex items-center gap-3 text-sm text-[var(--paper)]">
                    <LoaderCircle className="h-4 w-4 animate-spin text-[var(--acid)]" />
                    Waiting for SoundCloud…
                  </div>
                  <p className="mt-3 text-xs leading-5 text-[var(--muted)]">
                    If a browser window opened, finish signing into SoundCloud there (Google, email, or
                    Apple all work) — AMP connects automatically the moment you're in. You can close that
                    window once it returns to your SoundCloud feed.
                  </p>
                </div>
              ) : null}


              {view === "waiting-signin" ? (
                <div className="mt-6 space-y-4">
                  <div className="rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5">
                    <p className="flex items-center gap-2 font-display text-lg text-[var(--paper)]">
                      <LoaderCircle className="h-4 w-4 animate-spin text-[var(--acid)]" />
                      Waiting for you to sign in
                    </p>
                    <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                      AMP opened {selectedProfile?.browserName ?? "your browser"} to the SoundCloud
                      login page. Sign in there as you normally would — AMP watches for the new
                      session and finishes automatically. You can keep {selectedProfile?.browserName ?? "the browser"}{" "}
                      open.
                    </p>
                    {localError?.message ? (
                      <p className="mt-3 text-xs leading-5 text-[var(--muted)]">{localError.message}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setView("profiles")}
                      className="rounded-full border border-[var(--edge)] px-5 py-3 text-sm text-[var(--muted)]"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSignInThenConnect()}
                      className="rounded-full border border-[var(--acid)] px-5 py-3 text-sm font-semibold text-[var(--paper)] transition hover:bg-[var(--paper)]/5"
                    >
                      Reopen login page
                    </button>
                  </div>
                </div>
              ) : null}

              {view === "browser-running" ? (
                <div className="mt-6 space-y-4">
                  <div className="rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5">
                    <p className="flex items-center gap-2 font-display text-lg text-[var(--paper)]">
                      <LoaderCircle className="h-4 w-4 animate-spin text-[var(--acid)]" />
                      Waiting for {selectedProfile?.browserName ?? "your browser"} to close
                    </p>
                    <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                      {selectedProfile?.browserName ?? "Your browser"} is still running, so its SoundCloud
                      session is locked. Fully quit it (including any background or system-tray instance) and
                      AMP finishes automatically — or let AMP close it for you.
                    </p>
                    {localError?.message ? (
                      <p className="mt-3 text-xs leading-5 text-[var(--muted)]">{localError.message}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setView("profiles")}
                      className="rounded-full border border-[var(--edge)] px-5 py-3 text-sm text-[var(--muted)]"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      disabled={isLoading || !selectedProfileId}
                      onClick={() =>
                        void (async () => {
                          await closeLocalBrowser(selectedProfileId);
                          if (useAppStore.getState().connections.soundcloud.status === "connected") {
                            setOpen(false);
                            setView("methods");
                          }
                        })()
                      }
                      className={cn(
                        "rounded-full px-5 py-3 text-sm font-semibold transition",
                        isLoading
                          ? "cursor-not-allowed border border-[var(--edge)] text-[var(--muted)] opacity-70"
                          : "bg-[var(--acid)] text-[var(--shell)] hover:brightness-110"
                      )}
                    >
                      Close {selectedProfile?.browserName ?? "browser"} for me
                    </button>
                  </div>
                </div>
              ) : null}

            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function SoundCloudStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-3">
      <p className="kicker">{label}</p>
      <p className="mt-1 truncate font-display text-lg text-[var(--paper)]">{value}</p>
    </div>
  );
}

function SoundCloudMethodButton({
  icon,
  label,
  badge,
  description,
  onClick
}: {
  icon: ReactNode;
  label: string;
  badge: string;
  description: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5 text-left transition hover:border-[var(--acid)]/50 hover:bg-[var(--paper)]/5"
    >
      <span className="flex items-start gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--paper)]/5 text-[var(--acid)]">
          {icon}
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-display text-xl text-[var(--paper)]">{label}</span>
            <span className="rounded-full border border-[var(--acid)]/35 px-2 py-1 text-[0.62rem] uppercase tracking-[0.14em] text-[var(--acid)]">
              {badge}
            </span>
          </span>
          <span className="mt-2 block text-sm leading-6 text-[var(--muted)]">{description}</span>
        </span>
      </span>
    </button>
  );
}

function SoundCloudInlineError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--warn)]/35 bg-[var(--warn)]/10 p-4 text-sm leading-6 text-[var(--warn)]">
      <AlertTriangle className="mt-1 h-4 w-4 shrink-0" />
      {message}
    </div>
  );
}

function AppearanceCard() {
  const accentSource = useAppStore((state) => state.accentSource);
  const setAccentSource = useAppStore((state) => state.setAccentSource);
  const runtime = useAppStore((state) => state.runtime);
  const beatIntensity = useAppStore((state) => state.beatIntensity);
  const setBeatIntensity = useAppStore((state) => state.setBeatIntensity);

  const options: { id: AccentSource; label: string; hint: string }[] = [
    { id: "artwork", label: "Album art", hint: "Accent taken from the cover image." },
    { id: "audio", label: "Song audio", hint: "Gradient and accent pulse on the beat." },
    { id: "static", label: "Static", hint: "Fixed neutral accent — no colour or pulse." }
  ];
  const visibleOptions = options.filter(
    (option) => option.id !== "audio" || runtime?.platform === "win32"
  );

  useEffect(() => {
    if (runtime && runtime.platform !== "win32" && accentSource === "audio") {
      setAccentSource("artwork");
    }
  }, [accentSource, runtime, setAccentSource]);

  return (
    <SectionCard>
      <SectionHeader title="Appearance" />
      <p className="text-sm leading-6 text-[var(--muted)]">
        The interface stays monotone and borrows one accent colour from whatever is playing.
      </p>
      <div
        className={cn(
          "mt-5 grid gap-3",
          visibleOptions.length === 3 ? "grid-cols-3" : "grid-cols-2"
        )}
      >
        {visibleOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={accentSource === option.id}
            onClick={() => {
              setAccentSource(option.id);
              if (option.id === "audio") {
                // Acquire the system-audio loopback inside this click so the request carries the
                // user gesture Chromium wants for getDisplayMedia.
                audioReactor.primeLoopback();
              }
            }}
            className={cn(
              "rounded-[var(--radius-lg)] border p-4 text-left transition",
              accentSource === option.id
                ? "border-[var(--acid)] bg-[var(--paper)]/5"
                : "border-[var(--edge)] bg-[var(--panel)] hover:border-[var(--acid)]/40"
            )}
          >
            <p className="font-display text-lg text-[var(--paper)]">{option.label}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--muted)]">{option.hint}</p>
          </button>
        ))}
      </div>

      {accentSource === "audio" ? (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--paper)]">Pulse intensity</p>
            <span className="tnum text-xs text-[var(--faint)]">
              {Math.round(beatIntensity * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={BEAT_INTENSITY_MAX}
            step={0.05}
            value={beatIntensity}
            onChange={(event) => setBeatIntensity(Number(event.target.value))}
            style={sliderFill((beatIntensity / BEAT_INTENSITY_MAX) * 100)}
            className="mt-2 w-full"
            aria-label="Beat pulse intensity"
          />
          <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
            How strongly the background pulses on the beat. 0% holds it steady.
          </p>
        </div>
      ) : null}

      <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-[var(--muted)]">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Beat detection listens to AMP's own output — SoundCloud directly, Spotify via Windows
        audio capture. Nothing is recorded or stored.
      </p>
    </SectionCard>
  );
}

function LocalMusicCard() {
  const folders = useAppStore((state) => state.localFolders);
  const localTracks = useAppStore((state) => state.localTracks);
  const scanStatus = useAppStore((state) => state.localScanStatus);
  const loadLocalMusic = useAppStore((state) => state.loadLocalMusic);
  const addLocalFolder = useAppStore((state) => state.addLocalFolder);
  const removeLocalFolder = useAppStore((state) => state.removeLocalFolder);
  const rescanLocalMusic = useAppStore((state) => state.rescanLocalMusic);
  const scanning = scanStatus === "scanning";

  // Load the folder list (and scan) the first time the card mounts, so Settings reflects reality
  // even if the user never opened the Library tab this session.
  useEffect(() => {
    void loadLocalMusic();
  }, [loadLocalMusic]);

  return (
    <SectionCard>
      <SectionHeader
        title="Local music"
        count={localTracks.length > 0 ? localTracks.length : undefined}
        action={
          <Btn kind="ghost" disabled={scanning || folders.length === 0} onClick={() => void rescanLocalMusic()}>
            <RefreshCcw className={cn("h-3.5 w-3.5", scanning && "animate-spin")} />
            {scanning ? "Scanning…" : "Rescan"}
          </Btn>
        }
      />
      <p className="text-sm leading-6 text-[var(--muted)]">
        Add folders of audio files (mp3, m4a, flac, wav, ogg…) and play them right alongside Spotify
        and SoundCloud. Files never leave your machine.
      </p>

      <div className="mt-4 space-y-2">
        {folders.length === 0 ? (
          <EmptyState>No folders yet. Add one to bring your local library into AMP.</EmptyState>
        ) : (
          folders.map((folder) => (
            <div
              key={folder}
              className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel)] p-3"
            >
              <Headphones className="h-4 w-4 shrink-0 text-[var(--muted)]" />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--paper)]" title={folder}>
                {folder}
              </span>
              <button
                type="button"
                title="Remove folder"
                aria-label={`Remove ${folder}`}
                onClick={() => void removeLocalFolder(folder)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] border border-[var(--edge)] text-[var(--muted)] transition hover:border-[var(--warn)]/60 hover:text-[var(--warn)]"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="mt-4">
        <Btn kind="secondary" disabled={scanning} onClick={() => void addLocalFolder()}>
          <Plus className="h-4 w-4" />
          Add folder
        </Btn>
      </div>
    </SectionCard>
  );
}

function DiscordCard() {
  const enabled = useAppStore((state) => state.discordPresenceEnabled);
  const setDiscordPresenceEnabled = useAppStore((state) => state.setDiscordPresenceEnabled);
  return (
    <SectionCard>
      <SectionHeader
        title="Discord"
        action={
          <Switch
            checked={enabled}
            onChange={setDiscordPresenceEnabled}
            label="Discord Rich Presence"
          />
        }
      />
      <p className="text-sm text-[var(--paper)]">
        Show what you're listening to as your Discord status.
      </p>
      <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
        Off means AMP never connects to Discord.
      </p>
    </SectionCard>
  );
}

function StatTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--edge)] bg-[var(--panel-strong)] p-3.5">
      <p className="kicker">{label}</p>
      <p className="mt-1 font-display text-2xl text-[var(--paper)]" style={accent ? { color: accent } : undefined}>
        {value}
      </p>
    </div>
  );
}

function StatsPage() {
  // Recompute when the playing track changes (a new play was just logged) or after a manual clear.
  const currentKey = useAppStore((state) => {
    const track = state.playback.queue[state.playback.currentIndex];
    return track ? `${track.provider}:${track.providerTrackId || track.id}` : "";
  });
  const [version, setVersion] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const stats: ListeningStats = useMemo(() => loadListeningStats(8), [currentKey, version]);

  if (stats.totalPlays === 0) {
    return (
      <SectionCard>
        <p className="text-sm leading-7 text-[var(--muted)]">
          No listening history yet. Play some tracks and your top artists and songs will show up
          here. Stored on this device only.
        </p>
      </SectionCard>
    );
  }

  const maxArtist = stats.topArtists[0]?.count ?? 1;
  const providerTotal = Math.max(1, stats.totalPlays);
  const providerPct = (provider: keyof ListeningStats["providerSplit"]) =>
    Math.round((stats.providerSplit[provider] / providerTotal) * 100);
  const maxDay = Math.max(1, ...stats.days.map((day) => day.count));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Tracks played" value={stats.totalPlays.toLocaleString()} />
        <StatTile label="Last 7 days" value={stats.weekPlays.toLocaleString()} />
        <StatTile label="Spotify" value={`${providerPct("spotify")}%`} accent="var(--spotify-tint)" />
        <StatTile label="SoundCloud" value={`${providerPct("soundcloud")}%`} accent="var(--soundcloud-tint)" />
        <StatTile label="YouTube" value={`${providerPct("youtube")}%`} />
        <StatTile label="Local" value={`${providerPct("local")}%`} />
      </div>

      <SectionCard>
        <SectionHeader title="Daily activity" />
        <div className="flex h-28 items-end gap-2">
          {stats.days.map((day) => (
            <div key={day.label} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <span className="tnum text-[10px] text-[var(--faint)]">{day.count > 0 ? day.count : ""}</span>
              <div
                title={`${day.count} play${day.count === 1 ? "" : "s"}`}
                className="w-full max-w-10 rounded-t-[4px] bg-[var(--acid)]/80 transition-[height]"
                style={{ height: `${Math.max(day.count > 0 ? 6 : 2, (day.count / maxDay) * 72)}px` }}
              />
              <span className="text-[10px] text-[var(--muted)]">{day.label}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard>
          <SectionHeader title="Top artists" />
          <div className="space-y-2.5">
            {stats.topArtists.length === 0 ? (
              <EmptyState>No artist data yet — plays without artist tags don't count here.</EmptyState>
            ) : null}
            {stats.topArtists.map((artist, index) => (
              <div key={artist.artist} className="flex items-center gap-3">
                <span className="w-4 shrink-0 text-right text-xs text-[var(--muted)]">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm text-[var(--paper)]">{artist.artist}</p>
                    <span className="shrink-0 text-[11px] text-[var(--muted)]">{artist.count}</span>
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-[var(--acid)]"
                      style={{ width: `${(artist.count / maxArtist) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard>
          <SectionHeader title="Top tracks" />
          <div className="space-y-2">
            {stats.topTracks.map((track, index) => (
              <div key={track.key} className="flex items-center gap-3">
                <span className="w-4 shrink-0 text-right text-xs text-[var(--muted)]">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[var(--paper)]">{displayTitle(track.title)}</p>
                  <p className="truncate text-[11px] text-[var(--muted)]">{track.artist}</p>
                </div>
                <span className="shrink-0 text-[11px] text-[var(--muted)]">{track.count}×</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <Btn kind="ghost" onClick={() => setConfirmClear(true)}>
        Clear history
      </Btn>
      <ConfirmDialog
        open={confirmClear}
        title="Clear listening history?"
        body="Your on-device play log — top artists, top tracks, and daily activity — will be wiped. This can't be undone."
        confirmLabel="Clear history"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          clearListeningStats();
          useAppStore.setState({ recentTracks: [] });
          setVersion((value) => value + 1);
          setConfirmClear(false);
        }}
      />
    </div>
  );
}

function SettingsPage() {
  const connections = useAppStore((state) => state.connections);
  const librarySync = useAppStore((state) => state.librarySync);
  const runtime = useAppStore((state) => state.runtime);
  const desktopConfig = useAppStore((state) => state.desktopConfig);
  const saveDesktopConfig = useAppStore((state) => state.saveDesktopConfig);
  const reloadRuntime = useAppStore((state) => state.reloadRuntime);
  const openConfigDirectory = useAppStore((state) => state.openConfigDirectory);
  const clearStoredProviderSession = useAppStore((state) => state.clearStoredProviderSession);
  const connectProvider = useAppStore((state) => state.connectProvider);
  const cancelConnectProvider = useAppStore((state) => state.cancelConnectProvider);
  const disconnectProvider = useAppStore((state) => state.disconnectProvider);
  const refreshProviderConnection = useAppStore((state) => state.refreshProviderConnection);
  const hydrateLibraries = useAppStore((state) => state.hydrateLibraries);
  const restartOnboarding = useAppStore((state) => state.restartOnboarding);
  const [consentProvider, setConsentProvider] = useState<OAuthProvider | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [configForm, setConfigForm] = useState(desktopConfig);

  useEffect(() => {
    setConfigForm(desktopConfig);
  }, [desktopConfig]);

  return (
    <>
      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
        <SectionCard>
          <SectionHeader title="AMP" />
          <p className="max-w-2xl text-sm leading-6 text-[var(--muted)]">
            Runs entirely on this device — sign-in, playlists, and playback stay local. No
            account, no cloud.
          </p>

          <div className="mt-6 rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-1 h-5 w-5 text-[var(--acid)]" />
              <div>
                <p className="font-display text-xl text-[var(--paper)]">Running locally on this device</p>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                  Attach Spotify below and bring in SoundCloud likes from the SoundCloud panel. Tokens
                  stay on this machine.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5">
            <div className="flex items-start gap-3">
              <RotateCcw className="mt-1 h-5 w-5 text-[var(--acid)]" />
              <div>
                <p className="font-display text-xl text-[var(--paper)]">First-time setup</p>
                <p className="mt-2 max-w-md text-sm leading-6 text-[var(--muted)]">
                  Disconnect both providers and reopen the welcome guide. Imported tracks and
                  playlists stay in AMP.
                </p>
              </div>
            </div>
            <Btn kind="ghost" className="shrink-0" onClick={() => setConfirmRestart(true)}>
              Start over
            </Btn>
          </div>

          {runtime?.platform === "browser" ? (
            <div className="mt-6 rounded-[var(--radius-lg)] border border-[var(--warn)]/35 bg-[var(--warn)]/10 p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-1 h-5 w-5 text-[var(--warn)]" />
                <div>
                  <p className="font-display text-xl text-[var(--paper)]">Browser preview cannot attach providers</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    Spotify and SoundCloud attach flows only work inside the packaged Electron app. If this says
                    `browser`, launch the latest desktop installer instead of the web preview.
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-8 space-y-4">
            {(["spotify"] as OAuthProvider[]).map((provider) => {
              const connection = connections[provider];
              const providerConfig = getProviderConfigStatus(runtime, provider);
              const providerRuntime = runtime?.oauth[provider];
              return (
                <div
                  key={provider}
                  className="rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <p className="kicker">{providerLabel(provider)}</p>
                      <p className="mt-2 font-display text-2xl text-[var(--paper)]">
                        {connection.displayName ?? "Not connected"}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                        {connection.issue ??
                          providerRuntime?.message ??
                          (provider === "spotify"
                            ? "Saved tracks and playlists load straight into AMP."
                            : "Likes and playlists load straight into AMP.")}
                      </p>
                      <p className="mt-2 text-xs text-[var(--faint)]">
                        {librarySync[provider].importedCount > 0
                          ? `${librarySync[provider].importedCount} linked tracks in AMP`
                          : "No imported tracks yet"}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {connection.status === "connected" ? (
                        <>
                          <Btn
                            kind="secondary"
                            disabled={librarySync[provider].syncing}
                            onClick={() =>
                              // force=true: the connection signature is unchanged after a token
                              // refresh, so an unforced hydrate returns early and syncs nothing.
                              void refreshProviderConnection(provider)
                                .then(() => hydrateLibraries(true))
                                .catch(() => undefined)
                            }
                          >
                            <RefreshCcw
                              className={cn("h-4 w-4", librarySync[provider].syncing && "animate-spin")}
                            />
                            {librarySync[provider].syncing ? "Syncing…" : "Sync library"}
                          </Btn>
                          <Btn kind="ghost" onClick={() => void disconnectProvider(provider)}>
                            Disconnect
                          </Btn>
                        </>
                      ) : connection.status === "connecting" ? (
                        <Btn
                          kind="secondary"
                          title="Cancel sign-in"
                          onClick={() => void cancelConnectProvider(provider)}
                        >
                          Cancel
                        </Btn>
                      ) : (
                        <Btn
                          kind="primary"
                          onClick={() => {
                            if (providerConfig.ready) {
                              setConsentProvider(provider);
                            }
                          }}
                          disabled={!providerConfig.ready}
                        >
                          {providerConfig.ready ? "Connect Spotify" : "Sign-in unavailable"}
                        </Btn>
                      )}
                    </div>
                  </div>
                  <div className="kicker mt-4 flex items-center gap-3">
                    <ConnectionPill provider={provider} status={connection.status} />
                    <span>{formatClock(connection.connectedAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
        <SoundCloudConnectCard onRequestOAuth={() => setConsentProvider("soundcloud")} />
        </div>

        <div className="space-y-6">
          <AppearanceCard />
          <LocalMusicCard />
          <DiscordCard />
          <SectionCard>
            <SectionHeader title="Diagnostics" />
            <p className="text-sm leading-6 text-[var(--muted)]">
              Spotify plays through the in-app SDK; SoundCloud streams directly. These checks show
              what AMP can reach.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Btn kind="secondary" onClick={() => void reloadRuntime()}>
                Reload runtime
              </Btn>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              {runtime?.oauth.spotify.hasStoredSession ? (
                <Btn kind="secondary" onClick={() => void clearStoredProviderSession("spotify")}>
                  Clear Spotify session
                </Btn>
              ) : null}
              {runtime?.oauth.soundcloud.hasStoredSession ? (
                <Btn kind="secondary" onClick={() => void clearStoredProviderSession("soundcloud")}>
                  Clear SoundCloud session
                </Btn>
              ) : null}
            </div>
            <div className="mt-5 space-y-4">
              <EnvRow
                label="Desktop platform"
                ready={Boolean(runtime?.platform)}
                value={runtime?.platform ?? "unknown"}
              />
              <EnvRow
                label="Config folder"
                ready={Boolean(runtime?.configDirectory)}
                value={runtime?.configDirectory ?? "unknown"}
              />
              <EnvRow
                label="Spotify sign-in"
                ready={getProviderConfigStatus(runtime, "spotify").ready}
                value={getProviderConfigStatus(runtime, "spotify").value}
              />
              <EnvRow
                label="Spotify session storage"
                ready={Boolean(runtime?.oauth.spotify.hasStoredSession)}
                value={runtime ? getStorageBadgeText(runtime, "spotify") : "checking"}
              />
              <EnvRow
                label="SoundCloud sign-in"
                ready={getProviderConfigStatus(runtime, "soundcloud").ready}
                value={getProviderConfigStatus(runtime, "soundcloud").value}
              />
              <EnvRow
                label="SoundCloud session storage"
                ready={Boolean(runtime?.oauth.soundcloud.hasStoredSession)}
                value={runtime ? getStorageBadgeText(runtime, "soundcloud") : "checking"}
              />
            </div>
            <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-[var(--muted)]">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Encrypted SoundCloud playback requires an installer whose VMP signatures were verified
              during release. Unsigned builds cannot play those tracks.
            </p>
          </SectionCard>

          <SectionCard>
            <SectionHeader title="Developer tools" />
            <p className="text-sm leading-6 text-[var(--muted)]">
              Chromium DevTools — console, network, and element state for debugging playback or
              connection issues.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Btn kind="secondary" onClick={() => void openDevTools()}>
                Open DevTools
              </Btn>
              <Btn kind="secondary" onClick={() => void openConfigDirectory()}>
                Open config folder
              </Btn>
            </div>
          </SectionCard>

          {
            <SectionCard>
              <SectionHeader title="Connection credentials" />
              <p className="text-sm leading-6 text-[var(--muted)]">
                Add your own Spotify or SoundCloud app credentials. The SoundCloud secret is stored
                with the operating system's secure storage and is never returned to this form.
              </p>

              <div className="mt-6 space-y-4">
                <input
                  value={configForm.spotifyClientId}
                  onChange={(event) =>
                    setConfigForm((current) => ({ ...current, spotifyClientId: event.target.value }))
                  }
                  placeholder="SPOTIFY_CLIENT_ID"
                  className="w-full rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-3 text-sm text-[var(--paper)] outline-none"
                />
                <input
                  value={configForm.soundCloudClientId}
                  onChange={(event) =>
                    setConfigForm((current) => ({ ...current, soundCloudClientId: event.target.value }))
                  }
                  placeholder="SOUNDCLOUD_CLIENT_ID"
                  className="w-full rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-3 text-sm text-[var(--paper)] outline-none"
                />
                <input
                  type="password"
                  value={configForm.soundCloudClientSecret}
                  onChange={(event) =>
                    setConfigForm((current) => ({ ...current, soundCloudClientSecret: event.target.value }))
                  }
                  placeholder={
                    configForm.soundCloudClientSecretConfigured
                      ? "SoundCloud secret configured — enter a replacement"
                      : "SOUNDCLOUD_CLIENT_SECRET"
                  }
                  className="w-full rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-3 text-sm text-[var(--paper)] outline-none"
                />
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <Btn kind="primary" onClick={() => void saveDesktopConfig(configForm)}>
                  Save credentials
                </Btn>
                {configForm.soundCloudClientSecretConfigured ? (
                  <Btn
                    kind="secondary"
                    onClick={() =>
                      void saveDesktopConfig({
                        ...configForm,
                        soundCloudClientSecret: "",
                        soundCloudClientSecretConfigured: false
                      })
                    }
                  >
                    Clear SoundCloud secret
                  </Btn>
                ) : null}
              </div>
            </SectionCard>
          }
        </div>
      </div>

      <ProviderConsentDialog
        provider={consentProvider}
        onClose={() => setConsentProvider(null)}
        onConfirm={(provider) => {
          setConsentProvider(null);
          void connectProvider(provider);
        }}
      />

      <ConfirmDialog
        open={confirmRestart}
        title="Start over?"
        body="Disconnects Spotify and SoundCloud and reopens the welcome setup. Imported tracks and playlists stay in AMP."
        confirmLabel="Disconnect & start over"
        onCancel={() => setConfirmRestart(false)}
        onConfirm={() => {
          setConfirmRestart(false);
          void restartOnboarding();
        }}
      />
    </>
  );
}

function ProviderConsentDialog({
  provider,
  onClose,
  onConfirm
}: {
  provider: OAuthProvider | null;
  onClose(): void;
  onConfirm(provider: OAuthProvider): void;
}) {
  // Hooks BEFORE the early return — bailing out first changed the hook count between renders
  // (0 hooks closed → 1 open), which is a hard React crash the moment the dialog opens.
  const runtime = useAppStore((state) => state.runtime);
  useEscapeClose(Boolean(provider), onClose);

  if (!provider) {
    return null;
  }

  const copy = providerConsentCopy[provider];
  const providerConfig = getProviderConfigStatus(runtime, provider);
  const providerRuntime = runtime?.oauth[provider];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={tween.quick}
        onClick={onClose}
        className="fixed inset-0 z-[49] grid place-items-center bg-[var(--mat-scrim)] px-6 backdrop-blur-md"
      >
        <motion.div
          initial={modalVariants.initial}
          animate={modalVariants.animate}
          exit={modalVariants.exit}
          transition={spring.pop}
          role="dialog"
          aria-modal="true"
          onClick={(event) => event.stopPropagation()}
          className="vibrancy glass-overlay z-[50] w-full max-w-2xl rounded-[var(--radius-xl)] p-6"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p
                className={cn(
                  "text-xs uppercase tracking-[0.14em]",
                  provider === "spotify" ? "text-[var(--spotify)]" : "text-[var(--soundcloud)]"
                )}
              >
                {providerLabel(provider)} permissions
              </p>
              <h3 className="mt-3 font-display text-3xl text-[var(--paper)]">{copy.title}</h3>
            </div>
            <Btn kind="ghost" className="shrink-0" onClick={onClose}>
              Close
            </Btn>
          </div>

          <p className="mt-4 text-sm leading-7 text-[var(--muted)]">{copy.summary}</p>

          <div className="mt-6 rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] p-5">
            <p className="kicker">AMP will ask to</p>
            <div className="mt-4 space-y-3">
              {copy.access.map((item) => (
                <div key={item} className="flex items-start gap-3 text-sm leading-6 text-[var(--paper)]">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--acid)]" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 rounded-[var(--radius-lg)] border border-[var(--edge)]/80 bg-[var(--shell)]/50 p-4 text-sm leading-6 text-[var(--muted)]">
            <p>{copy.caution}</p>
            <p className="mt-3">
              {providerRuntime?.storageMode === "memory-only"
                ? "This connection will stay active until the app closes."
                : "Your connection will be saved securely on this device so you can come back without reconnecting every time."}
            </p>
          </div>

          {!providerConfig.ready ? (
            <div className="mt-5 rounded-[var(--radius-lg)] border border-[var(--warn)]/35 bg-[var(--warn)]/10 p-4 text-sm leading-6 text-[var(--paper)]">
              <p className="font-semibold text-[var(--paper)]">Provider sign-in is not configured on this device yet.</p>
              <p className="mt-2 text-[var(--muted)]">{providerConfig.message}</p>
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <Btn kind="ghost" onClick={onClose}>
              Not now
            </Btn>
            <Btn kind="primary" onClick={() => onConfirm(provider)} disabled={!providerConfig.ready}>
              {providerConfig.ready ? copy.confirmLabel : "Sign-in unavailable"}
            </Btn>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function EnvRow({ label, ready, value }: { label: string; ready: boolean; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-[var(--radius-lg)] border border-[var(--edge)] bg-[var(--panel)] px-4 py-3">
      <div>
        <p className="text-sm text-[var(--muted)]">{label}</p>
        <p className="mt-1 font-mono text-xs text-[var(--paper)]">{value}</p>
      </div>
      {ready ? (
        <CheckCircle2 className="h-5 w-5 text-[var(--acid)]" />
      ) : (
        <AlertTriangle className="h-5 w-5 text-[var(--warn)]" />
      )}
    </div>
  );
}
