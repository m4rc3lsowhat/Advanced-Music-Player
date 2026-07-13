import { promises as fs, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CacheEntry } from "./types";

// Hard ceiling on cached entries — beyond this the oldest entries are evicted so a long session
// can't grow memory (and the store.json flush) without bound. Eviction drains down to the
// low-water mark so the O(n log n) oldest-first sort amortizes over many inserts instead of
// firing on every write once the cache sits at the cap.
const MAX_ENTRIES = 600;
const LOW_WATER_ENTRIES = 480;

export class CacheStore {
  private cacheDir: string;
  private memoryCache = new Map<string, CacheEntry>();
  private memoryOnlyKeys = new Set<string>();
  private dirty = false;
  private revision = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushQueue: Promise<void> = Promise.resolve();
  private writeGeneration = 0;

  constructor(userDataPath: string) {
    this.cacheDir = path.join(userDataPath, "gateway-cache");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await this.hydrate();
  }

  get<T>(key: string): T | undefined {
    const entry = this.memoryCache.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);
      this.memoryOnlyKeys.delete(key);
      this.dirty = true;
      this.revision += 1;
      this.scheduleFlush();
      return undefined;
    }
    return entry.data as T;
  }

  set(key: string, data: unknown, ttlMs: number, etag?: string): void {
    this.memoryOnlyKeys.delete(key);
    this.storeEntry(key, data, ttlMs, etag);
  }

  /** Cache credentials and signed media URLs for this process without writing them to disk. */
  setMemoryOnly(key: string, data: unknown, ttlMs: number, etag?: string): void {
    this.memoryOnlyKeys.add(key);
    this.storeEntry(key, data, ttlMs, etag);
  }

  private storeEntry(key: string, data: unknown, ttlMs: number, etag?: string): void {
    const now = Date.now();
    this.memoryCache.set(key, {
      key,
      data,
      etag,
      expiresAt: now + ttlMs,
      createdAt: now
    });
    if (this.memoryCache.size > MAX_ENTRIES) {
      this.evictStale(now);
    }
    this.dirty = true;
    this.revision += 1;
    this.scheduleFlush();
  }

  /** Drop expired entries, then oldest-first down to the low-water mark. */
  private evictStale(now: number): void {
    for (const [key, entry] of this.memoryCache) {
      if (entry.expiresAt <= now) {
        this.memoryCache.delete(key);
        this.memoryOnlyKeys.delete(key);
      }
    }
    if (this.memoryCache.size <= MAX_ENTRIES) {
      return;
    }
    const oldestFirst = [...this.memoryCache.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const entry of oldestFirst.slice(0, this.memoryCache.size - LOW_WATER_ENTRIES)) {
      this.memoryCache.delete(entry.key);
      this.memoryOnlyKeys.delete(entry.key);
    }
  }

  invalidate(pattern?: RegExp): void {
    if (!pattern) {
      this.memoryCache.clear();
      this.memoryOnlyKeys.clear();
      this.dirty = true;
      this.revision += 1;
      this.scheduleFlush();
      return;
    }

    for (const key of this.memoryCache.keys()) {
      if (pattern.test(key)) {
        this.memoryCache.delete(key);
        this.memoryOnlyKeys.delete(key);
        this.dirty = true;
        this.revision += 1;
      }
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 2000);
  }

  private writeSnapshotSync(entries: CacheEntry[]): void {
    const targetPath = path.join(this.cacheDir, "store.json");
    const temporaryPath = `${targetPath}.${process.pid}.sync.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(entries, null, 2), "utf8");
      renameSync(temporaryPath, targetPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  /**
   * Flush immediately and SYNCHRONOUSLY (quit path) — the debounce timer alone loses the last ~2s
   * of writes, and an async write started inside `before-quit` can be cut off mid-flight when the
   * process exits. The payload is small (bounded by MAX_ENTRIES), so blocking a few ms is fine.
   */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) {
      return;
    }
    try {
      this.writeGeneration += 1;
      const revision = this.revision;
      const now = Date.now();
      const entries = Array.from(this.memoryCache.values()).filter(
        (entry) => entry.expiresAt > now && !this.memoryOnlyKeys.has(entry.key)
      );
      this.writeSnapshotSync(entries);
      if (this.revision === revision) {
        this.dirty = false;
      }
    } catch {
      // Cache flush failure is non-critical.
    }
  }

  private flush(): void {
    if (!this.dirty) {
      return;
    }

    const revision = this.revision;
    const generation = ++this.writeGeneration;
    const now = Date.now();
    const entries = Array.from(this.memoryCache.values()).filter(
      (entry) => entry.expiresAt > now && !this.memoryOnlyKeys.has(entry.key)
    );
    const payload = JSON.stringify(entries, null, 2);
    const targetPath = path.join(this.cacheDir, "store.json");
    const temporaryPath = `${targetPath}.${process.pid}.${generation}.tmp`;

    const run = this.flushQueue.then(async () => {
      try {
        await fs.writeFile(temporaryPath, payload, "utf8");
        // renameSync runs in this continuation without an await between the generation check and
        // replace. flushNow can therefore invalidate a pending snapshot without a stale async
        // rename landing after the quit-time write.
        if (generation === this.writeGeneration) {
          renameSync(temporaryPath, targetPath);
          if (this.revision === revision) {
            this.dirty = false;
          } else {
            this.scheduleFlush();
          }
        }
      } catch {
        // Cache flush failure is non-critical; keep dirty so a later mutation can retry.
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
    this.flushQueue = run.catch(() => undefined);
  }

  private async hydrate(): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(this.cacheDir, "store.json"), "utf8");
      const entries = JSON.parse(raw) as CacheEntry[];
      const now = Date.now();
      let scrubbedSensitiveEntry = false;

      for (const entry of entries) {
        // Older releases persisted signed SoundCloud URLs and DRM/OAuth material in store.json.
        // Never hydrate those values and rewrite the store without them.
        if (entry.key.startsWith("soundcloud:stream:")) {
          scrubbedSensitiveEntry = true;
          continue;
        }
        if (entry.expiresAt > now) {
          this.memoryCache.set(entry.key, entry);
        }
      }
      if (scrubbedSensitiveEntry) {
        this.dirty = true;
        this.revision += 1;
        this.scheduleFlush();
      }
    } catch {
      // Hydration failure is fine on first run.
    }
  }
}
