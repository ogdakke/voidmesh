import { logger } from "./client.logger.ts";
import {
  getVideoEditCacheDirectory,
  isOpfsSupported,
  readArrayBufferFile,
  readBlobFile,
  requestPersistentStorage,
} from "./opfs.ts";
import type {
  FromVideoEditCacheWorkerMessage,
  ToVideoEditCacheWorkerMessage,
  VideoEditCacheFrameIndex,
  VideoEditCacheKeyframeIndex,
  VideoEditCacheManifest,
} from "./video-edit-cache.worker.ts";

export type { VideoEditCacheFrameIndex, VideoEditCacheKeyframeIndex, VideoEditCacheManifest };

const FRAME_INDEX_FILE_NAME = "frame-index.bin";
const KEYFRAME_INDEX_FILE_NAME = "keyframe-index.bin";

export interface VideoEditCacheHandle {
  getManifest(): Promise<VideoEditCacheManifest | null>;
  getFrameIndex(): Promise<VideoEditCacheFrameIndex | null>;
  getKeyframeIndex(): Promise<VideoEditCacheKeyframeIndex | null>;
  getProxyFile(): Promise<File | null>;
  prioritizeTime(time: number): void;
  dispose(): void;
}

function isEditCacheSupported(): boolean {
  return (
    isOpfsSupported() && typeof Worker !== "undefined" && typeof crypto?.subtle !== "undefined"
  );
}

async function hashBlob(blob: Blob): Promise<string> {
  const head = await blob.slice(0, Math.min(blob.size, 64 * 1024)).arrayBuffer();
  const tailStart = Math.max(0, blob.size - 64 * 1024);
  const tail = tailStart === 0 ? new ArrayBuffer(0) : await blob.slice(tailStart).arrayBuffer();
  const encoder = new TextEncoder();
  const metadata = encoder.encode(`${blob.type}:${blob.size}`);
  const combined = new Uint8Array(metadata.byteLength + head.byteLength + tail.byteLength);
  combined.set(metadata, 0);
  combined.set(new Uint8Array(head), metadata.byteLength);
  combined.set(new Uint8Array(tail), metadata.byteLength + head.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class VideoEditCacheWorkerClient {
  #worker: Worker | null = null;
  #handles = new Map<string, Set<VideoEditCacheHandleImpl>>();

  #ensureWorker(): Worker | null {
    if (!isEditCacheSupported()) return null;
    this.#worker ??= new Worker(new URL("./video-edit-cache.worker.ts", import.meta.url), {
      type: "module",
    });
    this.#worker.onmessage = (event: MessageEvent<FromVideoEditCacheWorkerMessage>) => {
      const handles = this.#handles.get(event.data.cacheKey);
      if (!handles) return;

      switch (event.data.type) {
        case "manifest":
          for (const handle of handles) {
            handle.applyManifest(event.data.manifest);
          }
          break;
        case "error":
          logger.warn("[video-edit-cache] Worker error", {
            cacheKey: event.data.cacheKey,
            message: event.data.message,
          });
          break;
      }
    };
    this.#worker.onerror = (event) => {
      logger.error("[video-edit-cache] Worker crashed", event.message);
    };
    return this.#worker;
  }

  registerHandle(handle: VideoEditCacheHandleImpl): void {
    if (!handle.cacheKey) return;
    const existing = this.#handles.get(handle.cacheKey) ?? new Set<VideoEditCacheHandleImpl>();
    existing.add(handle);
    this.#handles.set(handle.cacheKey, existing);
  }

  unregisterHandle(handle: VideoEditCacheHandleImpl): void {
    if (!handle.cacheKey) return;
    const existing = this.#handles.get(handle.cacheKey);
    if (!existing) return;
    existing.delete(handle);
    if (existing.size === 0) {
      this.#handles.delete(handle.cacheKey);
      this.#ensureWorker()?.postMessage({
        type: "dispose-cache",
        cacheKey: handle.cacheKey,
      } satisfies ToVideoEditCacheWorkerMessage);
    }
  }

  ensureCache(
    handle: VideoEditCacheHandleImpl,
    blob: Blob,
    duration: number,
    fps: number | null,
  ): void {
    const worker = this.#ensureWorker();
    if (!worker || !handle.cacheKey) return;
    this.registerHandle(handle);
    worker.postMessage({
      type: "ensure-cache",
      cacheKey: handle.cacheKey,
      blob,
      duration,
      fps,
    } satisfies ToVideoEditCacheWorkerMessage);
  }

  prioritizeTime(cacheKey: string, time: number): void {
    const worker = this.#ensureWorker();
    if (!worker) return;
    worker.postMessage({
      type: "prioritize-time",
      cacheKey,
      time,
    } satisfies ToVideoEditCacheWorkerMessage);
  }
}

const workerClient = new VideoEditCacheWorkerClient();

class VideoEditCacheHandleImpl implements VideoEditCacheHandle {
  #manifest: VideoEditCacheManifest | null = null;
  #frameIndex: VideoEditCacheFrameIndex | null = null;
  #keyframeIndex: VideoEditCacheKeyframeIndex | null = null;
  #proxyFile: File | null = null;
  readonly readyPromise: Promise<void>;
  cacheKey: string | null = null;

  constructor(
    private readonly blob: Blob,
    private readonly duration: number,
    private readonly fps: number | null,
  ) {
    this.readyPromise = this.#initialize();
  }

  async #initialize(): Promise<void> {
    if (!isEditCacheSupported()) return;

    try {
      await requestPersistentStorage().catch(() => false);
      this.cacheKey = await hashBlob(this.blob);
      workerClient.ensureCache(this, this.blob, this.duration, this.fps);
    } catch (error) {
      logger.warn("[video-edit-cache] Failed to initialize cache handle", { error });
    }
  }

  applyManifest(manifest: VideoEditCacheManifest): void {
    this.#manifest = manifest;
    if (manifest.proxy.status !== "ready") {
      this.#proxyFile = null;
    }
  }

  async getManifest(): Promise<VideoEditCacheManifest | null> {
    await this.readyPromise;
    return this.#manifest;
  }

  async getFrameIndex(): Promise<VideoEditCacheFrameIndex | null> {
    await this.readyPromise;
    if (this.#frameIndex) {
      return this.#frameIndex;
    }
    if (!this.cacheKey) {
      return null;
    }

    const cacheDir = await getVideoEditCacheDirectory(this.cacheKey, false).catch(() => null);
    if (!cacheDir) {
      return null;
    }

    const buffer = await readArrayBufferFile(cacheDir, FRAME_INDEX_FILE_NAME);
    if (!buffer) {
      return null;
    }

    const view = new Float64Array(buffer);
    const timestamps: number[] = [];
    const durations: number[] = [];
    for (let index = 0; index < view.length; index += 2) {
      timestamps.push(view[index]!);
      durations.push(view[index + 1]!);
    }
    this.#frameIndex = { timestamps, durations };
    return this.#frameIndex;
  }

  async getKeyframeIndex(): Promise<VideoEditCacheKeyframeIndex | null> {
    await this.readyPromise;
    if (this.#keyframeIndex) {
      return this.#keyframeIndex;
    }
    if (!this.cacheKey) {
      return null;
    }

    const cacheDir = await getVideoEditCacheDirectory(this.cacheKey, false).catch(() => null);
    if (!cacheDir) {
      return null;
    }

    const buffer = await readArrayBufferFile(cacheDir, KEYFRAME_INDEX_FILE_NAME);
    if (!buffer) {
      return null;
    }

    const view = new Float64Array(buffer);
    const ordinals: number[] = [];
    const timestamps: number[] = [];
    for (let index = 0; index < view.length; index += 2) {
      ordinals.push(view[index]!);
      timestamps.push(view[index + 1]!);
    }
    this.#keyframeIndex = { ordinals, timestamps };
    return this.#keyframeIndex;
  }

  async getProxyFile(): Promise<File | null> {
    await this.readyPromise;
    if (this.#proxyFile) {
      return this.#proxyFile;
    }
    if (!this.cacheKey) {
      return null;
    }

    const manifest = await this.getManifest();
    if (!manifest || manifest.proxy.status !== "ready") {
      return null;
    }

    const cacheDir = await getVideoEditCacheDirectory(this.cacheKey, false).catch(() => null);
    if (!cacheDir) {
      return null;
    }

    const file = await readBlobFile(cacheDir, manifest.proxy.fileName ?? "scrub-proxy.mp4");
    if (!file) {
      return null;
    }

    this.#proxyFile = file;
    return this.#proxyFile;
  }

  prioritizeTime(time: number): void {
    if (!this.cacheKey) return;
    workerClient.prioritizeTime(this.cacheKey, time);
  }

  dispose(): void {
    workerClient.unregisterHandle(this);
  }
}

export function createVideoEditCacheHandle(
  blob: Blob,
  duration: number,
  fps: number | null,
): VideoEditCacheHandle | null {
  if (!isEditCacheSupported()) {
    return null;
  }
  return new VideoEditCacheHandleImpl(blob, duration, fps);
}
