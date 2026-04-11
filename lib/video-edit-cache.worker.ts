import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import {
  getVideoEditCacheDirectory,
  getVideoEditCacheRootDirectory,
  readArrayBufferFile,
  readBlobFile,
  readJsonFile,
  removeDirectoryEntry,
  removeFileEntry,
  requestPersistentStorage,
  writeBlobFile,
  writeArrayBufferFile,
  writeJsonFile,
} from "./opfs.ts";

const CACHE_VERSION = 4;
const FRAME_INDEX_FILE_NAME = "frame-index.bin";
const KEYFRAME_INDEX_FILE_NAME = "keyframe-index.bin";
const MANIFEST_FILE_NAME = "manifest.json";
const PROXY_FILE_NAME = "scrub-proxy.mp4";
const MAX_PROXY_EDGE = 1280;
const MAX_PROXY_FRAME_RATE = 30;
const PROXY_KEYFRAME_INTERVAL_SECONDS = 0.5;

export interface VideoEditCacheProxyManifest {
  status: "not-needed" | "pending" | "ready" | "failed";
  fileName?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  bitrate?: number;
  codec?: string;
  byteLength?: number;
  error?: string;
}

export interface VideoEditCacheManifest {
  version: number;
  cacheKey: string;
  duration: number;
  fps: number | null;
  width: number;
  height: number;
  frameCount: number;
  keyframeCount: number;
  frameIndexReady: boolean;
  keyframeIndexReady: boolean;
  status: "pending" | "ready" | "failed";
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  proxy: VideoEditCacheProxyManifest;
  error?: string;
}

export interface VideoEditCacheFrameIndex {
  timestamps: number[];
  durations: number[];
}

export interface VideoEditCacheKeyframeIndex {
  ordinals: number[];
  timestamps: number[];
}

export type ToVideoEditCacheWorkerMessage =
  | {
      type: "ensure-cache";
      cacheKey: string;
      blob: Blob;
      duration: number;
      fps: number | null;
    }
  | { type: "prioritize-time"; cacheKey: string; time: number }
  | { type: "dispose-cache"; cacheKey: string };

export type FromVideoEditCacheWorkerMessage =
  | {
      type: "manifest";
      cacheKey: string;
      manifest: VideoEditCacheManifest;
    }
  | {
      type: "error";
      cacheKey: string;
      message: string;
    };

interface CacheBuildJob {
  cacheKey: string;
  manifest: VideoEditCacheManifest;
  input: Input;
  videoTrack: NonNullable<Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>>;
  buildPromise: Promise<void> | null;
  disposed: boolean;
}

const jobs = new Map<string, CacheBuildJob>();

function isManifest(value: unknown): value is VideoEditCacheManifest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const manifest = value as Partial<VideoEditCacheManifest>;
  return (
    manifest.version === CACHE_VERSION &&
    typeof manifest.cacheKey === "string" &&
    typeof manifest.duration === "number" &&
    typeof manifest.width === "number" &&
    typeof manifest.height === "number" &&
    typeof manifest.frameCount === "number" &&
    typeof manifest.keyframeCount === "number" &&
    typeof manifest.frameIndexReady === "boolean" &&
    typeof manifest.keyframeIndexReady === "boolean" &&
    typeof manifest.status === "string" &&
    !!manifest.proxy &&
    typeof manifest.proxy === "object" &&
    typeof manifest.proxy.status === "string"
  );
}

function createManifest(
  cacheKey: string,
  duration: number,
  fps: number | null,
  width: number,
  height: number,
): VideoEditCacheManifest {
  const now = Date.now();
  return {
    version: CACHE_VERSION,
    cacheKey,
    duration,
    fps,
    width,
    height,
    frameCount: 0,
    keyframeCount: 0,
    frameIndexReady: false,
    keyframeIndexReady: false,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    proxy: {
      status: "pending",
    },
  };
}

function isManifestCompatible(
  manifest: VideoEditCacheManifest,
  width: number,
  height: number,
): boolean {
  return (
    manifest.version === CACHE_VERSION && manifest.width === width && manifest.height === height
  );
}

async function loadOrCreateManifest(
  cacheKey: string,
  durationHint: number,
  fpsHint: number | null,
  width: number,
  height: number,
): Promise<VideoEditCacheManifest> {
  const cacheDir = await getVideoEditCacheDirectory(cacheKey, true);
  const existing = await readJsonFile<unknown>(cacheDir, MANIFEST_FILE_NAME);
  if (isManifest(existing) && isManifestCompatible(existing, width, height)) {
    existing.duration = durationHint > 0 ? durationHint : existing.duration;
    existing.fps ??= fpsHint;
    existing.lastAccessedAt = Date.now();
    existing.updatedAt = existing.updatedAt ?? existing.lastAccessedAt;
    return existing;
  }

  const rootDir = await getVideoEditCacheRootDirectory(false).catch(() => null);
  if (rootDir) {
    await removeDirectoryEntry(rootDir, cacheKey).catch(() => {});
  }

  const freshDir = await getVideoEditCacheDirectory(cacheKey, true);
  const manifest = createManifest(cacheKey, durationHint, fpsHint, width, height);
  await writeJsonFile(freshDir, MANIFEST_FILE_NAME, manifest);
  return manifest;
}

function shouldBuildAdaptiveProxy(
  blob: Blob,
  manifest: VideoEditCacheManifest,
  sourceCodec: string | null | undefined,
): boolean {
  const pixelCount = manifest.width * manifest.height;
  const averageBytesPerSecond = manifest.duration > 0 ? blob.size / manifest.duration : blob.size;
  const sourceFps = manifest.fps ?? 0;
  return (
    sourceCodec !== "avc" ||
    pixelCount > 1920 * 1080 ||
    averageBytesPerSecond > 2_500_000 ||
    sourceFps > MAX_PROXY_FRAME_RATE
  );
}

function roundToEven(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function getProxyDimensions(width: number, height: number): { width: number; height: number } {
  const longestEdge = Math.max(width, height);
  const scale = longestEdge > MAX_PROXY_EDGE ? MAX_PROXY_EDGE / longestEdge : 1;
  return {
    width: roundToEven(width * scale),
    height: roundToEven(height * scale),
  };
}

function getProxyFrameRate(fps: number | null): number {
  if (!fps || !Number.isFinite(fps) || fps <= 0) {
    return MAX_PROXY_FRAME_RATE;
  }
  return Math.max(12, Math.min(MAX_PROXY_FRAME_RATE, Math.round(fps)));
}

function getProxyBitrate(width: number, height: number, frameRate: number): number {
  const pixels = width * height;
  const megapixels = pixels / 1_000_000;
  const bitrate = Math.round(megapixels * frameRate * 100_000);
  return Math.max(1_500_000, Math.min(5_000_000, bitrate));
}

function encodeFrameIndex(frameIndex: VideoEditCacheFrameIndex): ArrayBuffer {
  const count = Math.min(frameIndex.timestamps.length, frameIndex.durations.length);
  const buffer = new ArrayBuffer(count * Float64Array.BYTES_PER_ELEMENT * 2);
  const view = new Float64Array(buffer);
  for (let index = 0; index < count; index++) {
    view[index * 2] = frameIndex.timestamps[index]!;
    view[index * 2 + 1] = frameIndex.durations[index]!;
  }
  return buffer;
}

function decodeFrameIndex(buffer: ArrayBuffer): VideoEditCacheFrameIndex {
  const view = new Float64Array(buffer);
  const timestamps: number[] = [];
  const durations: number[] = [];
  for (let index = 0; index < view.length; index += 2) {
    timestamps.push(view[index]!);
    durations.push(view[index + 1]!);
  }
  return { timestamps, durations };
}

function encodeKeyframeIndex(keyframeIndex: VideoEditCacheKeyframeIndex): ArrayBuffer {
  const count = Math.min(keyframeIndex.ordinals.length, keyframeIndex.timestamps.length);
  const buffer = new ArrayBuffer(count * Float64Array.BYTES_PER_ELEMENT * 2);
  const view = new Float64Array(buffer);
  for (let index = 0; index < count; index++) {
    view[index * 2] = keyframeIndex.ordinals[index]!;
    view[index * 2 + 1] = keyframeIndex.timestamps[index]!;
  }
  return buffer;
}

function decodeKeyframeIndex(buffer: ArrayBuffer): VideoEditCacheKeyframeIndex {
  const view = new Float64Array(buffer);
  const ordinals: number[] = [];
  const timestamps: number[] = [];
  for (let index = 0; index < view.length; index += 2) {
    ordinals.push(view[index]!);
    timestamps.push(view[index + 1]!);
  }
  return { ordinals, timestamps };
}

async function persistManifest(job: CacheBuildJob): Promise<void> {
  const cacheDir = await getVideoEditCacheDirectory(job.cacheKey, true);
  job.manifest.updatedAt = Date.now();
  job.manifest.lastAccessedAt = job.manifest.updatedAt;
  await writeJsonFile(cacheDir, MANIFEST_FILE_NAME, job.manifest);
}

async function loadFrameIndex(cacheKey: string): Promise<VideoEditCacheFrameIndex | null> {
  const cacheDir = await getVideoEditCacheDirectory(cacheKey, false).catch(() => null);
  if (!cacheDir) return null;
  const buffer = await readArrayBufferFile(cacheDir, FRAME_INDEX_FILE_NAME);
  return buffer ? decodeFrameIndex(buffer) : null;
}

async function loadKeyframeIndex(cacheKey: string): Promise<VideoEditCacheKeyframeIndex | null> {
  const cacheDir = await getVideoEditCacheDirectory(cacheKey, false).catch(() => null);
  if (!cacheDir) return null;
  const buffer = await readArrayBufferFile(cacheDir, KEYFRAME_INDEX_FILE_NAME);
  return buffer ? decodeKeyframeIndex(buffer) : null;
}

async function buildIndices(job: CacheBuildJob): Promise<void> {
  const existingFrameIndex = job.manifest.frameIndexReady
    ? await loadFrameIndex(job.cacheKey)
    : null;
  const existingKeyframeIndex = job.manifest.keyframeIndexReady
    ? await loadKeyframeIndex(job.cacheKey)
    : null;

  if (existingFrameIndex && existingKeyframeIndex) {
    job.manifest.frameCount = existingFrameIndex.timestamps.length;
    job.manifest.keyframeCount = existingKeyframeIndex.ordinals.length;
    job.manifest.status = "ready";
    await persistManifest(job);
    postMessageToMain({ type: "manifest", cacheKey: job.cacheKey, manifest: job.manifest });
    return;
  }

  const packetSink = new EncodedPacketSink(job.videoTrack);
  const frameIndex: VideoEditCacheFrameIndex = {
    timestamps: [],
    durations: [],
  };
  const keyframeIndex: VideoEditCacheKeyframeIndex = {
    ordinals: [],
    timestamps: [],
  };

  let ordinal = 0;
  for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
    frameIndex.timestamps.push(packet.timestamp);
    frameIndex.durations.push(packet.duration);
    if (packet.type === "key") {
      keyframeIndex.ordinals.push(ordinal);
      keyframeIndex.timestamps.push(packet.timestamp);
    }
    ordinal++;
  }

  const cacheDir = await getVideoEditCacheDirectory(job.cacheKey, true);
  await writeArrayBufferFile(cacheDir, FRAME_INDEX_FILE_NAME, encodeFrameIndex(frameIndex));
  await writeArrayBufferFile(
    cacheDir,
    KEYFRAME_INDEX_FILE_NAME,
    encodeKeyframeIndex(keyframeIndex),
  );

  job.manifest.frameCount = frameIndex.timestamps.length;
  job.manifest.keyframeCount = keyframeIndex.ordinals.length;
  job.manifest.frameIndexReady = true;
  job.manifest.keyframeIndexReady = true;
  job.manifest.status = "ready";
  delete job.manifest.error;
  await persistManifest(job);
  postMessageToMain({ type: "manifest", cacheKey: job.cacheKey, manifest: job.manifest });
}

async function buildAdaptiveProxy(job: CacheBuildJob, blob: Blob): Promise<void> {
  const cacheDir = await getVideoEditCacheDirectory(job.cacheKey, true);
  const shouldBuild = shouldBuildAdaptiveProxy(blob, job.manifest, job.videoTrack.codec);

  if (!shouldBuild) {
    job.manifest.proxy = {
      status: "not-needed",
    };
    await removeFileEntry(cacheDir, PROXY_FILE_NAME).catch(() => {});
    await persistManifest(job);
    postMessageToMain({ type: "manifest", cacheKey: job.cacheKey, manifest: job.manifest });
    return;
  }

  const existingProxy =
    job.manifest.proxy.status === "ready"
      ? await readBlobFile(cacheDir, job.manifest.proxy.fileName ?? PROXY_FILE_NAME)
      : null;
  if (existingProxy) {
    job.manifest.proxy = {
      ...job.manifest.proxy,
      status: "ready",
      fileName: job.manifest.proxy.fileName ?? PROXY_FILE_NAME,
      mimeType: existingProxy.type || "video/mp4",
      byteLength: existingProxy.size,
      error: undefined,
    };
    await persistManifest(job);
    postMessageToMain({ type: "manifest", cacheKey: job.cacheKey, manifest: job.manifest });
    return;
  }

  const { width, height } = getProxyDimensions(job.manifest.width, job.manifest.height);
  const frameRate = getProxyFrameRate(job.manifest.fps);
  const bitrate = getProxyBitrate(width, height, frameRate);

  job.manifest.proxy = {
    status: "pending",
    fileName: PROXY_FILE_NAME,
    mimeType: "video/mp4",
    width,
    height,
    frameRate,
    bitrate,
    codec: "avc",
  };
  await persistManifest(job);
  postMessageToMain({ type: "manifest", cacheKey: job.cacheKey, manifest: job.manifest });

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat(),
    target,
  });

  try {
    const conversion = await Conversion.init({
      input: job.input,
      output,
      showWarnings: false,
      video: {
        width,
        height,
        fit: "contain",
        codec: "avc",
        bitrate,
        frameRate,
        keyFrameInterval: PROXY_KEYFRAME_INTERVAL_SECONDS,
      },
      audio: {
        discard: true,
      },
    });

    if (!conversion.isValid) {
      throw new Error("Failed to create adaptive scrub proxy: output configuration is invalid");
    }

    await conversion.execute();

    if (!target.buffer) {
      throw new Error("Adaptive scrub proxy conversion completed without an output buffer");
    }

    const proxyBlob = new Blob([target.buffer], { type: "video/mp4" });
    await writeBlobFile(cacheDir, PROXY_FILE_NAME, proxyBlob);
    job.manifest.proxy = {
      status: "ready",
      fileName: PROXY_FILE_NAME,
      mimeType: proxyBlob.type || "video/mp4",
      width,
      height,
      frameRate,
      bitrate,
      codec: "avc",
      byteLength: proxyBlob.size,
    };
    await persistManifest(job);
    postMessageToMain({ type: "manifest", cacheKey: job.cacheKey, manifest: job.manifest });
  } catch (error) {
    await output.cancel().catch(() => {});
    job.manifest.proxy = {
      status: "failed",
      fileName: PROXY_FILE_NAME,
      mimeType: "video/mp4",
      width,
      height,
      frameRate,
      bitrate,
      codec: "avc",
      error: error instanceof Error ? error.message : "Failed to build adaptive scrub proxy",
    };
    await removeFileEntry(cacheDir, PROXY_FILE_NAME).catch(() => {});
    await persistManifest(job);
    postMessageToMain({ type: "manifest", cacheKey: job.cacheKey, manifest: job.manifest });
  }
}

async function ensureJob(
  cacheKey: string,
  blob: Blob,
  durationHint: number,
  fpsHint: number | null,
): Promise<CacheBuildJob> {
  const existing = jobs.get(cacheKey);
  if (existing) return existing;

  await requestPersistentStorage().catch(() => false);

  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    input.dispose();
    throw new Error("No video track found in source");
  }

  const duration = durationHint || (await videoTrack.computeDuration());
  const manifest = await loadOrCreateManifest(
    cacheKey,
    duration,
    fpsHint,
    videoTrack.displayWidth,
    videoTrack.displayHeight,
  );
  manifest.duration = duration;
  manifest.fps ??= fpsHint;

  const job: CacheBuildJob = {
    cacheKey,
    manifest,
    input,
    videoTrack,
    buildPromise: null,
    disposed: false,
  };

  jobs.set(cacheKey, job);
  postMessageToMain({ type: "manifest", cacheKey, manifest });
  return job;
}

function postMessageToMain(message: FromVideoEditCacheWorkerMessage): void {
  self.postMessage(message);
}

async function startBuild(job: CacheBuildJob, blob: Blob): Promise<void> {
  if (job.buildPromise || job.disposed) {
    return await (job.buildPromise ?? Promise.resolve());
  }

  job.buildPromise = (async () => {
    try {
      await buildIndices(job);
      if (job.disposed) {
        return;
      }
      await buildAdaptiveProxy(job, blob);
    } catch (error) {
      job.manifest.status = "failed";
      job.manifest.error = error instanceof Error ? error.message : "Failed to build video index";
      await persistManifest(job).catch(() => {});
      postMessageToMain({
        type: "error",
        cacheKey: job.cacheKey,
        message: job.manifest.error,
      });
    } finally {
      job.buildPromise = null;
    }
  })();

  await job.buildPromise;
}

self.onmessage = async (event: MessageEvent<ToVideoEditCacheWorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "ensure-cache": {
      try {
        const job = await ensureJob(message.cacheKey, message.blob, message.duration, message.fps);
        await startBuild(job, message.blob);
      } catch (error) {
        postMessageToMain({
          type: "error",
          cacheKey: message.cacheKey,
          message: error instanceof Error ? error.message : "Failed to initialize video index",
        });
      }
      break;
    }
    case "prioritize-time": {
      const job = jobs.get(message.cacheKey);
      if (!job) break;
      job.manifest.lastAccessedAt = Date.now();
      void persistManifest(job).catch(() => {});
      break;
    }
    case "dispose-cache": {
      const job = jobs.get(message.cacheKey);
      if (!job) break;
      job.disposed = true;
      job.input.dispose();
      jobs.delete(message.cacheKey);
      break;
    }
  }
};
