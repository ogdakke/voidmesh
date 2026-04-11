import { logger } from "./client.logger.ts";
import { createVideoEditCacheHandle, type VideoEditCacheFrameIndex } from "./video-edit-cache.ts";
import { demuxVideo, type VideoDemuxHandle } from "./video-demux.ts";

const DEFAULT_CACHE_FRAME_LIMIT = 12;
const DEFAULT_CACHE_BYTE_LIMIT = 192 * 1024 * 1024;

export type ExactVideoFrameMode = "interactive" | "exact";

export interface ExactVideoFrameResult {
  bitmap: ImageBitmap;
  cacheKey: string;
  time: number;
  cacheStatus: "hit" | "miss";
  decodeMs: number;
  source: "original" | "proxy";
}

export interface ExactVideoFrameSession {
  getFrame(time: number, mode?: ExactVideoFrameMode): Promise<ExactVideoFrameResult>;
  setDisplayedFrame(cacheKey: string | null): void;
  isManagedBitmap(bitmap: ImageBitmap): boolean;
  dispose(): void;
}

interface CachedFrame {
  key: string;
  time: number;
  bitmap: ImageBitmap;
  bytes: number;
  lastUsedAt: number;
}

class BlobVideoFrameSession {
  #demuxPromise: Promise<VideoDemuxHandle> | null = null;
  #cache = new Map<string, CachedFrame>();
  #bitmapKeys = new Map<ImageBitmap, string>();
  #queue: Promise<void> = Promise.resolve();
  #displayedCacheKey: string | null = null;
  #disposed = false;
  #cacheBytes = 0;

  constructor(
    private readonly blob: Blob,
    private readonly debugLabel: string,
    private readonly source: "original" | "proxy",
    private readonly minTime: number,
    private readonly maxTime: number,
  ) {}

  async getFrame(time: number, cacheIdentity?: string): Promise<ExactVideoFrameResult> {
    const clampedTime = Math.max(this.minTime, Math.min(time, this.maxTime));
    const normalizedTime = clampedTime;
    const localKey = cacheIdentity ?? String(Math.round(normalizedTime * 1_000_000));
    const cacheKey = `${this.debugLabel}:${localKey}`;
    const cached = this.#cache.get(cacheKey);
    if (cached) {
      cached.lastUsedAt = performance.now();
      return {
        bitmap: cached.bitmap,
        cacheKey,
        time: normalizedTime,
        cacheStatus: "hit",
        decodeMs: 0,
        source: this.source,
      };
    }

    return await this.#enqueue(async () => {
      const existing = this.#cache.get(cacheKey);
      if (existing) {
        existing.lastUsedAt = performance.now();
        return {
          bitmap: existing.bitmap,
          cacheKey,
          time: normalizedTime,
          cacheStatus: "hit",
          decodeMs: 0,
          source: this.source,
        };
      }

      const demux = await this.#getDemux();
      if (this.#disposed) {
        throw new Error("Video frame session was disposed");
      }

      const decodeStartedAt = performance.now();
      logger.info("[video-frame-engine] Decode start", {
        label: this.debugLabel,
        time: normalizedTime,
        source: this.source,
        cacheSize: this.#cache.size,
        cacheBytes: this.#cacheBytes,
      });
      const iterator = demux.frames([normalizedTime])[Symbol.asyncIterator]();
      const result = await iterator.next();
      if (result.done || !result.value) {
        throw new Error("Failed to decode exact video frame");
      }

      const decodeMs = performance.now() - decodeStartedAt;
      this.#storeFrame(cacheKey, normalizedTime, result.value);
      logger.info("[video-frame-engine] Decode complete", {
        label: this.debugLabel,
        time: normalizedTime,
        source: this.source,
        decodeMs: Number(decodeMs.toFixed(2)),
        cacheSize: this.#cache.size,
        cacheBytes: this.#cacheBytes,
      });
      return {
        bitmap: result.value,
        cacheKey,
        time: normalizedTime,
        cacheStatus: "miss",
        decodeMs,
        source: this.source,
      };
    });
  }

  setDisplayedFrame(cacheKey: string | null): void {
    this.#displayedCacheKey = cacheKey;
    this.#evictIfNeeded();
  }

  isManagedBitmap(bitmap: ImageBitmap): boolean {
    return this.#bitmapKeys.has(bitmap);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    for (const frame of this.#cache.values()) {
      frame.bitmap.close();
    }
    this.#cache.clear();
    this.#bitmapKeys.clear();
    this.#cacheBytes = 0;

    if (this.#demuxPromise) {
      void this.#demuxPromise
        .then((demux) => demux.dispose())
        .catch((error) =>
          logger.debug("[video-frame-engine] Failed to dispose demux session", { error }),
        );
    }
  }

  async #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  #storeFrame(key: string, time: number, bitmap: ImageBitmap): void {
    const frame: CachedFrame = {
      key,
      time,
      bitmap,
      bytes: Math.max(1, bitmap.width * bitmap.height * 4),
      lastUsedAt: performance.now(),
    };
    this.#cache.set(key, frame);
    this.#bitmapKeys.set(bitmap, key);
    this.#cacheBytes += frame.bytes;
    this.#evictIfNeeded();
  }

  #evictIfNeeded(): void {
    while (
      this.#cache.size > DEFAULT_CACHE_FRAME_LIMIT ||
      this.#cacheBytes > DEFAULT_CACHE_BYTE_LIMIT
    ) {
      const evictionCandidate = [...this.#cache.values()]
        .filter((frame) => frame.key !== this.#displayedCacheKey)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];

      if (!evictionCandidate) {
        return;
      }

      this.#cache.delete(evictionCandidate.key);
      this.#bitmapKeys.delete(evictionCandidate.bitmap);
      this.#cacheBytes -= evictionCandidate.bytes;
      evictionCandidate.bitmap.close();
    }
  }

  #getDemux(): Promise<VideoDemuxHandle> {
    this.#demuxPromise ??= demuxVideo(this.blob);
    void this.#demuxPromise
      .then((demux) => {
        if (this.#disposed) {
          demux.dispose();
        }
      })
      .catch(() => {
        // getFrame() handles decode failures and triggers the caller's fallback path.
      });
    return this.#demuxPromise;
  }
}

function findFrameOrdinalAtOrBeforeTime(
  frameIndex: VideoEditCacheFrameIndex,
  time: number,
): number {
  const timestamps = frameIndex.timestamps;
  if (timestamps.length === 0) {
    return 0;
  }

  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (timestamps[mid]! < time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  if (low <= 0) {
    return 0;
  }
  if (low >= timestamps.length) {
    return timestamps.length - 1;
  }
  return timestamps[low]! <= time ? low : low - 1;
}

function getFrameTimeForOrdinal(frameIndex: VideoEditCacheFrameIndex, ordinal: number): number {
  return (
    frameIndex.timestamps[Math.max(0, Math.min(ordinal, frameIndex.timestamps.length - 1))] ?? 0
  );
}

class ExactVideoFrameSessionImpl implements ExactVideoFrameSession {
  #fallbackSession: BlobVideoFrameSession;
  #cacheHandle: ReturnType<typeof createVideoEditCacheHandle>;
  #proxySession: BlobVideoFrameSession | null = null;
  #proxySessionPromise: Promise<BlobVideoFrameSession | null> | null = null;

  constructor(
    private readonly blob: Blob,
    private readonly duration: number,
    private readonly fps: number | null,
    private readonly debugLabel: string,
  ) {
    this.#cacheHandle = createVideoEditCacheHandle(blob, duration, fps);
    this.#fallbackSession = new BlobVideoFrameSession(
      blob,
      `${debugLabel}:original`,
      "original",
      0,
      duration,
    );
  }

  async getFrame(
    time: number,
    mode: ExactVideoFrameMode = "exact",
  ): Promise<ExactVideoFrameResult> {
    const clampedTime = Math.max(0, Math.min(time, this.duration));
    const cacheHandle = this.#cacheHandle;
    if (mode === "interactive") {
      const proxySession = await this.#getProxySession();
      if (proxySession) {
        return await proxySession.getFrame(clampedTime);
      }
    }

    if (cacheHandle) {
      cacheHandle.prioritizeTime(clampedTime);

      const frameIndex = await cacheHandle.getFrameIndex();
      if (frameIndex && frameIndex.timestamps.length > 0) {
        const ordinal = findFrameOrdinalAtOrBeforeTime(frameIndex, clampedTime);
        const frameTime = getFrameTimeForOrdinal(frameIndex, ordinal);
        return await this.#fallbackSession.getFrame(frameTime, `ordinal:${ordinal}`);
      }
    }

    return await this.#fallbackSession.getFrame(clampedTime);
  }

  setDisplayedFrame(cacheKey: string | null): void {
    this.#fallbackSession.setDisplayedFrame(
      cacheKey?.startsWith(`${this.debugLabel}:original:`) ? cacheKey : null,
    );
    this.#proxySession?.setDisplayedFrame(
      cacheKey?.startsWith(`${this.debugLabel}:proxy:`) ? cacheKey : null,
    );
  }

  isManagedBitmap(bitmap: ImageBitmap): boolean {
    return (
      this.#fallbackSession.isManagedBitmap(bitmap) ||
      this.#proxySession?.isManagedBitmap(bitmap) === true
    );
  }

  dispose(): void {
    this.#proxySession?.dispose();
    this.#proxySession = null;
    this.#proxySessionPromise = null;
    this.#fallbackSession.dispose();
    this.#cacheHandle?.dispose();
  }

  async #getProxySession(): Promise<BlobVideoFrameSession | null> {
    if (this.#proxySession) {
      return this.#proxySession;
    }
    if (this.#proxySessionPromise) {
      return await this.#proxySessionPromise;
    }
    if (!this.#cacheHandle) {
      return null;
    }

    this.#proxySessionPromise = (async () => {
      const manifest = await this.#cacheHandle?.getManifest();
      if (!manifest || manifest.proxy.status !== "ready") {
        return null;
      }

      const proxyFile = await this.#cacheHandle?.getProxyFile();
      if (!proxyFile) {
        return null;
      }

      const proxyDuration = manifest.duration > 0 ? manifest.duration : this.duration;
      this.#proxySession = new BlobVideoFrameSession(
        proxyFile,
        `${this.debugLabel}:proxy`,
        "proxy",
        0,
        proxyDuration,
      );
      return this.#proxySession;
    })().finally(() => {
      this.#proxySessionPromise = null;
    });

    return await this.#proxySessionPromise;
  }
}

export function createExactVideoFrameSession(
  blob: Blob,
  duration: number,
  fps: number | null,
  debugLabel: string,
): ExactVideoFrameSession {
  return new ExactVideoFrameSessionImpl(blob, duration, fps, debugLabel);
}
