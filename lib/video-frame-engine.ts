import { logger } from "./client.logger.ts";
import {
  createVideoEditCacheHandle,
  type VideoEditCacheFrameIndex,
  type VideoEditCacheManifest,
  type VideoEditCacheSegment,
} from "./video-edit-cache.ts";
import { demuxVideo, type VideoDemuxHandle } from "./video-demux.ts";

const DEFAULT_CACHE_FRAME_LIMIT = 12;
const DEFAULT_CACHE_BYTE_LIMIT = 192 * 1024 * 1024;

export interface ExactVideoFrameResult {
  bitmap: ImageBitmap;
  cacheKey: string;
  time: number;
  cacheStatus: "hit" | "miss";
  decodeMs: number;
  source: "original" | "cache";
}

export interface ExactVideoFrameSession {
  getFrame(time: number): Promise<ExactVideoFrameResult>;
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
    private readonly fps: number | null,
    private readonly debugLabel: string,
    private readonly source: "original" | "cache",
    private readonly minTime: number,
    private readonly maxTime: number,
  ) {}

  async getFrame(time: number, cacheIdentity?: string): Promise<ExactVideoFrameResult> {
    const clampedTime = Math.max(this.minTime, Math.min(time, this.maxTime));
    const normalizedTime =
      cacheIdentity || !(this.fps && this.fps > 0)
        ? clampedTime
        : Math.round(clampedTime * this.fps) / this.fps;
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

function findNearestFrameOrdinal(frameIndex: VideoEditCacheFrameIndex, time: number): number {
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

  const previous = timestamps[low - 1]!;
  const current = timestamps[low]!;
  return Math.abs(previous - time) <= Math.abs(current - time) ? low - 1 : low;
}

function getFrameTimeForOrdinal(frameIndex: VideoEditCacheFrameIndex, ordinal: number): number {
  return (
    frameIndex.timestamps[Math.max(0, Math.min(ordinal, frameIndex.timestamps.length - 1))] ?? 0
  );
}

function findReadySegmentForOrdinal(
  segments: VideoEditCacheSegment[],
  ordinal: number,
): VideoEditCacheSegment | null {
  for (const segment of segments) {
    if (!segment.ready || segment.startOrdinal === null || segment.endOrdinal === null) continue;
    if (ordinal >= segment.startOrdinal && ordinal <= segment.endOrdinal) {
      return segment;
    }
  }
  return null;
}

class ExactVideoFrameSessionImpl implements ExactVideoFrameSession {
  #fallbackSession: BlobVideoFrameSession;
  #cacheHandle: ReturnType<typeof createVideoEditCacheHandle>;
  #segmentSessions = new Map<string, Promise<BlobVideoFrameSession | null>>();
  #resolvedSegmentSessions = new Map<string, BlobVideoFrameSession>();

  constructor(
    private readonly blob: Blob,
    private readonly duration: number,
    private readonly fps: number | null,
    private readonly debugLabel: string,
  ) {
    this.#cacheHandle = createVideoEditCacheHandle(blob, duration, fps);
    this.#fallbackSession = new BlobVideoFrameSession(
      blob,
      fps,
      `${debugLabel}:original`,
      "original",
      0,
      duration,
    );
  }

  async getFrame(time: number): Promise<ExactVideoFrameResult> {
    const clampedTime = Math.max(0, Math.min(time, this.duration));
    const cacheHandle = this.#cacheHandle;
    if (cacheHandle) {
      cacheHandle.prioritizeTime(clampedTime);

      const [manifest, frameIndex] = await Promise.all([
        cacheHandle.getManifest(),
        cacheHandle.getFrameIndex(),
      ]);
      if (manifest && frameIndex && frameIndex.timestamps.length > 0) {
        const ordinal = findNearestFrameOrdinal(frameIndex, clampedTime);
        const frameTime = getFrameTimeForOrdinal(frameIndex, ordinal);
        const segment = this.#findBestReadySegment(manifest, ordinal);
        if (segment) {
          const sessionKey = this.#getSegmentSessionKey(segment);
          const session = await this.#getOrCreateSegmentSession(segment);
          if (session) {
            try {
              return await session.getFrame(frameTime, `ordinal:${ordinal}`);
            } catch (error) {
              logger.warn("[video-frame-engine] Cached segment decode failed, falling back", {
                label: this.debugLabel,
                tier: segment.tier,
                segmentIndex: segment.index,
                time: frameTime,
                ordinal,
                error,
              });
              this.#invalidateSegmentSession(sessionKey, session);
            }
          }
        }

        return await this.#fallbackSession.getFrame(frameTime, `ordinal:${ordinal}`);
      }
    }

    return await this.#fallbackSession.getFrame(clampedTime);
  }

  setDisplayedFrame(cacheKey: string | null): void {
    this.#fallbackSession.setDisplayedFrame(
      cacheKey?.startsWith(`${this.debugLabel}:original:`) ? cacheKey : null,
    );

    for (const [sessionKey, sessionPromise] of this.#segmentSessions) {
      void sessionPromise.then((session) => {
        session?.setDisplayedFrame(
          cacheKey?.startsWith(`${this.debugLabel}:${sessionKey}:`) ? cacheKey : null,
        );
      });
    }
  }

  isManagedBitmap(bitmap: ImageBitmap): boolean {
    if (this.#fallbackSession.isManagedBitmap(bitmap)) {
      return true;
    }
    for (const session of this.#resolvedSegmentSessions.values()) {
      if (session.isManagedBitmap(bitmap)) {
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    this.#fallbackSession.dispose();
    this.#cacheHandle?.dispose();
    for (const session of this.#resolvedSegmentSessions.values()) {
      session.dispose();
    }
    this.#segmentSessions.clear();
    this.#resolvedSegmentSessions.clear();
  }

  #findBestReadySegment(
    manifest: VideoEditCacheManifest,
    ordinal: number,
  ): VideoEditCacheSegment | null {
    return (
      findReadySegmentForOrdinal(manifest.tiers.detail.segments, ordinal) ??
      findReadySegmentForOrdinal(manifest.tiers.sweep.segments, ordinal)
    );
  }

  #getSegmentSessionKey(segment: VideoEditCacheSegment): string {
    return `${segment.tier}:${segment.index}`;
  }

  async #getOrCreateSegmentSession(
    segment: VideoEditCacheSegment,
  ): Promise<BlobVideoFrameSession | null> {
    const sessionKey = this.#getSegmentSessionKey(segment);
    let sessionPromise = this.#segmentSessions.get(sessionKey);
    if (!sessionPromise) {
      sessionPromise = this.#loadSegmentSession(segment);
      this.#segmentSessions.set(sessionKey, sessionPromise);
    }
    const session = await sessionPromise;
    if (!session) {
      this.#segmentSessions.delete(sessionKey);
      return null;
    }
    this.#resolvedSegmentSessions.set(sessionKey, session);
    return session;
  }

  #invalidateSegmentSession(sessionKey: string, session: BlobVideoFrameSession | null): void {
    session?.dispose();
    this.#segmentSessions.delete(sessionKey);
    this.#resolvedSegmentSessions.delete(sessionKey);
  }

  async #loadSegmentSession(segment: VideoEditCacheSegment): Promise<BlobVideoFrameSession | null> {
    const cacheHandle = this.#cacheHandle;
    if (!cacheHandle) return null;

    try {
      const file = await cacheHandle.getSegmentFile(segment);
      if (!file) {
        return null;
      }

      const sessionKey = this.#getSegmentSessionKey(segment);
      return new BlobVideoFrameSession(
        file,
        this.fps,
        `${this.debugLabel}:${sessionKey}`,
        "cache",
        segment.startTime,
        Math.max(segment.endTime, segment.startTime),
      );
    } catch (error) {
      logger.warn("[video-frame-engine] Failed to load cached segment", {
        label: this.debugLabel,
        tier: segment.tier,
        segmentIndex: segment.index,
        error,
      });
      return null;
    }
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
