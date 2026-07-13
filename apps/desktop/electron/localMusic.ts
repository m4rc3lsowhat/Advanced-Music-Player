import type { UnifiedTrack } from "@amp/core";
import { createHash } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

/*
 * Local music: scan user-configured folders for audio files, read tags + embedded artwork with
 * music-metadata, and expose them as UnifiedTracks. Files are served to the renderer over the
 * amp-local:// protocol (registered in main.ts) with a path whitelist, so the app origin can only
 * ever read audio inside a folder the user explicitly added — never arbitrary disk paths.
 */

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus", ".webm", ".mp4", ".alac", ".aiff", ".aif"
]);
const MAX_SCAN_DEPTH = 8;
const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;

export interface LocalTrackFile {
  /** Stable id = sha1 of the absolute path; also the amp-local:// key. */
  id: string;
  absolutePath: string;
  /** Cached artwork file (extracted embedded picture), if any. */
  artworkPath?: string;
}

export class LocalMusicManager {
  private configPath: string;
  private artworkDir: string;
  private folders: string[] = [];
  /** id → file, rebuilt on every scan; the protocol handler maps ids back to whitelisted paths. */
  private index = new Map<string, LocalTrackFile>();
  private loaded = false;
  private folderMutation: Promise<void> = Promise.resolve();
  private scanGeneration = 0;

  constructor(userDataPath: string) {
    this.configPath = path.join(userDataPath, "local-music.json");
    this.artworkDir = path.join(userDataPath, "local-artwork");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.artworkDir, { recursive: true }).catch(() => undefined);
    await this.loadConfig();
  }

  private async loadConfig(): Promise<void> {
    if (this.loaded) {
      return;
    }
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as { folders?: string[] };
      this.folders = Array.isArray(parsed.folders) ? parsed.folders.filter((f) => typeof f === "string") : [];
    } catch {
      this.folders = [];
    }
    this.loaded = true;
  }

  private async saveConfig(folders: string[]): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    const tempPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify({ folders }, null, 2), "utf8");
      await fs.rename(tempPath, this.configPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async updateFolders(update: (folders: string[]) => string[]): Promise<string[]> {
    let result: string[] = [];
    const operation = this.folderMutation.then(async () => {
      const next = update([...this.folders]);
      await this.saveConfig(next);
      this.folders = next;
      this.scanGeneration += 1;
      result = [...next];
    });
    this.folderMutation = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async getFolders(): Promise<string[]> {
    await this.loadConfig();
    return [...this.folders];
  }

  async addFolder(folder: string): Promise<string[]> {
    await this.loadConfig();
    const normalized = path.resolve(folder);
    return this.updateFolders((folders) =>
      folders.includes(normalized) ? folders : [...folders, normalized]
    );
  }

  async removeFolder(folder: string): Promise<string[]> {
    await this.loadConfig();
    const normalized = path.resolve(folder);
    return this.updateFolders((folders) => folders.filter((candidate) => candidate !== normalized));
  }

  /** Whitelist check + lookup: only ids from the last scan, whose REAL path is inside a folder.
   *  Resolving symlinks (realpath) closes the escape where a symlink named song.mp3 inside a folder
   *  points at an arbitrary file outside it. */
  resolveAudioPath(id: string): string | undefined {
    const entry = this.index.get(id);
    if (!entry) {
      return undefined;
    }
    let realFile: string;
    try {
      realFile = realpathSync(entry.absolutePath);
    } catch {
      return undefined;
    }
    const insideAFolder = this.folders.some((folder) => {
      try {
        return isInside(realpathSync(folder), realFile);
      } catch {
        return false;
      }
    });
    return insideAFolder ? entry.absolutePath : undefined;
  }

  resolveArtworkPath(id: string): string | undefined {
    const entry = this.index.get(id);
    if (!entry?.artworkPath) {
      return undefined;
    }
    // Artwork lives in our own cache dir — safe to serve as long as the track id is known.
    return isInside(this.artworkDir, entry.artworkPath) ? entry.artworkPath : undefined;
  }

  /** Walk every configured folder, parse tags, and return UnifiedTracks (rebuilds the id index). */
  async scan(): Promise<UnifiedTrack[]> {
    await this.loadConfig();
    const mm = await import("music-metadata");
    const generation = ++this.scanGeneration;
    const folders = [...this.folders];
    const nextIndex = new Map<string, LocalTrackFile>();
    const tracks: UnifiedTrack[] = [];
    const files: string[] = [];
    const seenFiles = new Set<string>();

    for (const folder of folders) {
      const realFolder = await fs.realpath(folder).catch(() => undefined);
      if (!realFolder) {
        continue;
      }
      const candidates = await walkAudioFiles(folder, MAX_SCAN_DEPTH).catch(() => [] as string[]);
      for (const candidate of candidates) {
        const absolutePath = await fs.realpath(candidate).catch(() => undefined);
        if (!absolutePath || !isInside(realFolder, absolutePath) || seenFiles.has(absolutePath)) {
          continue;
        }
        seenFiles.add(absolutePath);
        files.push(absolutePath);
      }
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.min(6, files.length) }, async () => {
      while (cursor < files.length) {
        const absolutePath = files[cursor++];
        const id = hashPath(absolutePath);
        try {
          const metadata = await mm.parseFile(absolutePath, { duration: true, skipCovers: false });
          const artworkPath = await this.cacheArtwork(id, metadata.common.picture?.[0]);
          nextIndex.set(id, { id, absolutePath, artworkPath });
          tracks.push(buildLocalTrack(id, absolutePath, metadata, Boolean(artworkPath)));
        } catch {
          // Unreadable/corrupt/unsupported-codec file: still list it by filename so it's visible,
          // but mark it so a play attempt can fail honestly.
          nextIndex.set(id, { id, absolutePath });
          tracks.push(buildFilenameTrack(id, absolutePath));
        }
      }
    });
    await Promise.all(workers);

    // A folder was added or removed while metadata parsing was in flight. Restart from the current
    // configuration so neither the main-process index nor the renderer receives an obsolete scan.
    if (generation !== this.scanGeneration) {
      return this.scan();
    }

    this.index = nextIndex;
    const retainedArtwork = new Set(
      [...nextIndex.values()].flatMap((entry) => (entry.artworkPath ? [path.resolve(entry.artworkPath)] : []))
    );
    const cachedArtwork = await fs.readdir(this.artworkDir).catch(() => [] as string[]);
    await Promise.all(
      cachedArtwork.map((name) => {
        const candidate = path.resolve(this.artworkDir, name);
        return retainedArtwork.has(candidate)
          ? Promise.resolve()
          : fs.rm(candidate, { force: true }).catch(() => undefined);
      })
    );
    // Alphabetical by title keeps the Library list stable across rescans.
    tracks.sort((a, b) => a.title.localeCompare(b.title));
    return tracks;
  }

  private async cacheArtwork(
    id: string,
    picture: { data: Uint8Array; format?: string } | undefined
  ): Promise<string | undefined> {
    if (!picture?.data?.length || picture.data.length > MAX_ARTWORK_BYTES) {
      return undefined;
    }
    const ext = detectArtworkExtension(picture.data);
    if (!ext) {
      return undefined;
    }
    const target = path.join(this.artworkDir, `${id}.${ext}`);
    const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, Buffer.from(picture.data));
      await fs.rename(tempPath, target);
      return target;
    } catch {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      return undefined;
    }
  }
}

function detectArtworkExtension(data: Uint8Array): "png" | "jpg" | "webp" | undefined {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "jpg";
  }
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

function isInside(folder: string, file: string): boolean {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function hashPath(absolutePath: string): string {
  return createHash("sha1").update(path.resolve(absolutePath)).digest("hex");
}

async function walkAudioFiles(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > maxDepth) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        await walk(full, depth + 1);
      } else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  await walk(path.resolve(root), 0);
  return out;
}

function buildLocalTrack(
  id: string,
  absolutePath: string,
  metadata: import("music-metadata").IAudioMetadata,
  hasArtwork: boolean
): UnifiedTrack {
  const common = metadata.common;
  const title = common.title?.trim() || path.parse(absolutePath).name;
  const artists = [
    ...(common.artists ?? []),
    ...(common.artist ? [common.artist] : []),
    ...(common.albumartist ? [common.albumartist] : [])
  ]
    .map((a) => a?.trim())
    .filter((a): a is string => Boolean(a));
  const creators = dedupe(artists);
  return {
    id,
    provider: "local",
    providerTrackId: id,
    title,
    creators: creators.length > 0 ? creators : ["Unknown artist"],
    artworkUrl: hasArtwork ? `amp-local://art/${id}` : undefined,
    durationMs: Math.round((metadata.format.duration ?? 0) * 1000),
    explicit: false,
    playable: true,
    album: common.album?.trim() || undefined,
    genre: common.genre?.[0]?.trim() || undefined
  };
}

function buildFilenameTrack(id: string, absolutePath: string): UnifiedTrack {
  return {
    id,
    provider: "local",
    providerTrackId: id,
    title: path.parse(absolutePath).name,
    creators: ["Unknown artist"],
    durationMs: 0,
    explicit: false,
    playable: true
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
