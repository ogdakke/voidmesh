import { calculatePreviewDetailBitrate, calculatePreviewSweepBitrate } from "#config";
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
} from "mediabunny";
import {
  getNestedDirectoryHandle,
  getVideoEditCacheDirectory,
  getVideoEditCacheRootDirectory,
  listDirectoryEntries,
  readArrayBufferFile,
  readJsonFile,
  removeDirectoryEntry,
  removeFileEntry,
  requestPersistentStorage,
  writeArrayBufferFile,
  writeBlobFile,
  writeJsonFile,
} from "./opfs.ts";

const CACHE_VERSION = 2;
const FRAME_INDEX_FILE_NAME = "frame-index.bin";
const MANIFEST_FILE_NAME = "manifest.json";
const DETAIL_SEGMENT_DURATION_SECONDS = 1;
const SWEEP_SEGMENT_DURATION_SECONDS = 2;
const SWEEP_TARGET_PIXELS = 1280 * 720;
const DETAIL_WINDOW_RADIUS_SEGMENTS = 2;
const MAX_VIDEO_EDIT_CACHE_BYTES = 8 * 1024 * 1024 * 1024;

export type VideoEditCacheTier = "sweep" | "detail";

export interface VideoEditCacheSegment {
  tier: VideoEditCacheTier;
  index: number;
  startTime: number;
  endTime: number;
  startOrdinal: number | null;
  endOrdinal: number | null;
  frameCount: number;
  fileName: string;
  mimeType: string;
  ready: boolean;
  byteLength: number;
  width: number;
  height: number;
  lastAccessedAt: number;
}

export interface VideoEditCacheTierManifest {
  width: number;
  height: number;
  segmentDuration: number;
  segments: VideoEditCacheSegment[];
}

export interface VideoEditCacheManifest {
  version: number;
  cacheKey: string;
  duration: number;
  fps: number | null;
  width: number;
  height: number;
  frameCount: number;
  frameIndexReady: boolean;
  conformStatus: "pending" | "partial" | "ready" | "failed";
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  tiers: {
    sweep: VideoEditCacheTierManifest;
    detail: VideoEditCacheTierManifest;
  };
  error?: string;
}

export interface VideoEditCacheFrameIndex {
  timestamps: number[];
  durations: number[];
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
  | { type: "touch-segment"; cacheKey: string; tier: VideoEditCacheTier; segmentIndex: number }
  | { type: "dispose-cache"; cacheKey: string };

export type FromVideoEditCacheWorkerMessage =
  | {
      type: "manifest";
      cacheKey: string;
      manifest: VideoEditCacheManifest;
    }
  | {
      type: "segment-ready";
      cacheKey: string;
      tier: VideoEditCacheTier;
      segmentIndex: number;
      manifest: VideoEditCacheManifest;
    }
  | {
      type: "error";
      cacheKey: string;
      message: string;
    };

interface CacheBuildTask {
  tier: VideoEditCacheTier;
  index: number;
}

interface CacheBuildJob {
  cacheKey: string;
  durationHint: number;
  fpsHint: number | null;
  manifest: VideoEditCacheManifest;
  queue: CacheBuildTask[];
  queued: Set<string>;
  building: boolean;
  disposed: boolean;
  input: Input;
  videoTrack: NonNullable<Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>>;
  frameIndex: VideoEditCacheFrameIndex | null;
  frameIndexPromise: Promise<VideoEditCacheFrameIndex>;
}

const jobs = new Map<string, CacheBuildJob>();

function isTieredManifest(value: unknown): value is VideoEditCacheManifest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const manifest = value as Partial<VideoEditCacheManifest>;
  return Boolean(
    manifest.tiers &&
    typeof manifest.tiers === "object" &&
    manifest.tiers.sweep &&
    typeof manifest.tiers.sweep === "object" &&
    Array.isArray(manifest.tiers.sweep.segments) &&
    manifest.tiers.detail &&
    typeof manifest.tiers.detail === "object" &&
    Array.isArray(manifest.tiers.detail.segments),
  );
}

function postMessageToMain(message: FromVideoEditCacheWorkerMessage): void {
  self.postMessage(message);
}

function getSweepSize(width: number, height: number): { width: number; height: number } {
  const pixelCount = Math.max(1, width * height);
  if (pixelCount <= SWEEP_TARGET_PIXELS) {
    return { width, height };
  }

  const scale = Math.sqrt(SWEEP_TARGET_PIXELS / pixelCount);
  return {
    width: normalizeDimension(width * scale),
    height: normalizeDimension(height * scale),
  };
}

function normalizeDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function createTierSegments(
  tier: VideoEditCacheTier,
  duration: number,
  segmentDuration: number,
  width: number,
  height: number,
): VideoEditCacheSegment[] {
  const segmentCount = Math.max(1, Math.ceil(duration / segmentDuration));
  return Array.from({ length: segmentCount }, (_, index) => ({
    tier,
    index,
    startTime: index * segmentDuration,
    endTime: Math.min(duration, (index + 1) * segmentDuration),
    startOrdinal: null,
    endOrdinal: null,
    frameCount: 0,
    fileName: `${index.toString().padStart(6, "0")}.mp4`,
    mimeType: "video/mp4",
    ready: false,
    byteLength: 0,
    width,
    height,
    lastAccessedAt: 0,
  }));
}

function createManifest(
  cacheKey: string,
  duration: number,
  fpsHint: number | null,
  width: number,
  height: number,
): VideoEditCacheManifest {
  const sweepSize = getSweepSize(width, height);
  const createdAt = Date.now();
  return {
    version: CACHE_VERSION,
    cacheKey,
    duration,
    fps: fpsHint,
    width,
    height,
    frameCount: 0,
    frameIndexReady: false,
    conformStatus: "pending",
    createdAt,
    updatedAt: createdAt,
    lastAccessedAt: createdAt,
    tiers: {
      sweep: {
        width: sweepSize.width,
        height: sweepSize.height,
        segmentDuration: SWEEP_SEGMENT_DURATION_SECONDS,
        segments: createTierSegments(
          "sweep",
          duration,
          SWEEP_SEGMENT_DURATION_SECONDS,
          sweepSize.width,
          sweepSize.height,
        ),
      },
      detail: {
        width,
        height,
        segmentDuration: DETAIL_SEGMENT_DURATION_SECONDS,
        segments: createTierSegments(
          "detail",
          duration,
          DETAIL_SEGMENT_DURATION_SECONDS,
          width,
          height,
        ),
      },
    },
  };
}

function isManifestCompatible(
  manifest: VideoEditCacheManifest,
  width: number,
  height: number,
): boolean {
  if (!isTieredManifest(manifest)) {
    return false;
  }
  const sweepSize = getSweepSize(width, height);
  return (
    manifest.version === CACHE_VERSION &&
    manifest.width === width &&
    manifest.height === height &&
    manifest.tiers.sweep.width === sweepSize.width &&
    manifest.tiers.sweep.height === sweepSize.height &&
    manifest.tiers.sweep.segmentDuration === SWEEP_SEGMENT_DURATION_SECONDS &&
    manifest.tiers.detail.width === width &&
    manifest.tiers.detail.height === height &&
    manifest.tiers.detail.segmentDuration === DETAIL_SEGMENT_DURATION_SECONDS
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
  if (isTieredManifest(existing) && isManifestCompatible(existing, width, height)) {
    existing.lastAccessedAt = Date.now();
    existing.updatedAt = existing.updatedAt ?? Date.now();
    existing.tiers.sweep.segments ??= [];
    existing.tiers.detail.segments ??= [];
    return existing;
  }

  const root = await getVideoEditCacheRootDirectory(true);
  await removeDirectoryEntry(root, cacheKey);
  const freshDir = await getVideoEditCacheDirectory(cacheKey, true);
  const duration = durationHint > 0 ? durationHint : 0;
  const manifest = createManifest(cacheKey, duration, fpsHint, width, height);
  await writeJsonFile(freshDir, MANIFEST_FILE_NAME, manifest);
  return manifest;
}

function updateManifestStatus(manifest: VideoEditCacheManifest): void {
  const sweepReadyCount = manifest.tiers.sweep.segments.filter((segment) => segment.ready).length;
  const detailReadyCount = manifest.tiers.detail.segments.filter((segment) => segment.ready).length;

  if (
    sweepReadyCount === manifest.tiers.sweep.segments.length &&
    manifest.tiers.sweep.segments.length > 0
  ) {
    manifest.conformStatus = "ready";
    return;
  }

  if (sweepReadyCount > 0 || detailReadyCount > 0) {
    manifest.conformStatus = "partial";
    return;
  }

  manifest.conformStatus = "pending";
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid]! < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function hydrateSegmentsFromFrameIndex(
  segments: VideoEditCacheSegment[],
  timestamps: readonly number[],
  duration: number,
): void {
  const lastTimestamp = timestamps[timestamps.length - 1] ?? duration;
  for (const segment of segments) {
    const startOrdinal = lowerBound(timestamps, segment.startTime);
    const endExclusive =
      segment.endTime >= duration || segment.endTime > lastTimestamp
        ? timestamps.length
        : lowerBound(timestamps, segment.endTime);

    segment.frameCount = Math.max(0, endExclusive - startOrdinal);
    segment.startOrdinal = segment.frameCount > 0 ? startOrdinal : null;
    segment.endOrdinal = segment.frameCount > 0 ? endExclusive - 1 : null;
  }
}

async function persistManifest(job: CacheBuildJob): Promise<void> {
  const cacheDir = await getVideoEditCacheDirectory(job.cacheKey, true);
  job.manifest.updatedAt = Date.now();
  job.manifest.lastAccessedAt = Date.now();
  await writeJsonFile(cacheDir, MANIFEST_FILE_NAME, job.manifest);
}

function buildTaskKey(task: CacheBuildTask): string {
  return `${task.tier}:${task.index}`;
}

function enqueueSegment(
  job: CacheBuildJob,
  tier: VideoEditCacheTier,
  segmentIndex: number,
  front = false,
): void {
  const tierManifest = job.manifest.tiers[tier];
  if (segmentIndex < 0 || segmentIndex >= tierManifest.segments.length) return;
  const segment = tierManifest.segments[segmentIndex];
  const task: CacheBuildTask = { tier, index: segmentIndex };
  const taskKey = buildTaskKey(task);
  if (!segment || segment.ready || job.queued.has(taskKey)) return;
  if (front) {
    job.queue.unshift(task);
  } else {
    job.queue.push(task);
  }
  job.queued.add(taskKey);
}

function findSegmentIndexForTime(
  segments: readonly VideoEditCacheSegment[],
  time: number,
  duration: number,
): number {
  if (segments.length === 0) return 0;
  const clampedTime = Math.max(0, Math.min(time, duration));
  const segmentDuration = Math.max(segments[0]?.endTime ?? 1, 1) - (segments[0]?.startTime ?? 0);
  return Math.max(0, Math.min(segments.length - 1, Math.floor(clampedTime / segmentDuration)));
}

function reprioritizeJob(job: CacheBuildJob, time: number): void {
  job.manifest.lastAccessedAt = Date.now();

  const detailSegments = job.manifest.tiers.detail.segments;
  const detailIndex = findSegmentIndexForTime(detailSegments, time, job.manifest.duration);
  enqueueSegment(job, "detail", detailIndex, true);
  for (let offset = 1; offset <= DETAIL_WINDOW_RADIUS_SEGMENTS; offset++) {
    enqueueSegment(job, "detail", detailIndex + offset, true);
    enqueueSegment(job, "detail", detailIndex - offset, true);
  }

  const sweepSegments = job.manifest.tiers.sweep.segments;
  const sweepIndex = findSegmentIndexForTime(sweepSegments, time, job.manifest.duration);
  enqueueSegment(job, "sweep", sweepIndex, true);
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

async function loadFrameIndex(cacheKey: string): Promise<VideoEditCacheFrameIndex | null> {
  const cacheDir = await getVideoEditCacheDirectory(cacheKey, false);
  const buffer = await readArrayBufferFile(cacheDir, FRAME_INDEX_FILE_NAME);
  return buffer ? decodeFrameIndex(buffer) : null;
}

async function buildFrameIndex(job: CacheBuildJob): Promise<VideoEditCacheFrameIndex> {
  const packetSink = new EncodedPacketSink(job.videoTrack);
  const packets: { timestamp: number; duration: number }[] = [];

  for await (const packet of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
    packets.push({ timestamp: packet.timestamp, duration: packet.duration });
  }

  packets.sort((left, right) => left.timestamp - right.timestamp || left.duration - right.duration);

  if (packets.length === 0) {
    throw new Error("No video packets found while building frame index");
  }

  const frameIndex: VideoEditCacheFrameIndex = {
    timestamps: packets.map((packet) => packet.timestamp),
    durations: packets.map((packet) => packet.duration),
  };

  const cacheDir = await getVideoEditCacheDirectory(job.cacheKey, true);
  await writeArrayBufferFile(cacheDir, FRAME_INDEX_FILE_NAME, encodeFrameIndex(frameIndex));
  job.manifest.frameCount = frameIndex.timestamps.length;
  job.manifest.frameIndexReady = true;
  hydrateSegmentsFromFrameIndex(
    job.manifest.tiers.sweep.segments,
    frameIndex.timestamps,
    job.manifest.duration,
  );
  hydrateSegmentsFromFrameIndex(
    job.manifest.tiers.detail.segments,
    frameIndex.timestamps,
    job.manifest.duration,
  );
  await persistManifest(job);
  return frameIndex;
}

async function ensureFrameIndex(job: CacheBuildJob): Promise<VideoEditCacheFrameIndex> {
  if (job.frameIndex) {
    return job.frameIndex;
  }

  const existing = job.manifest.frameIndexReady ? await loadFrameIndex(job.cacheKey) : null;
  if (existing) {
    job.frameIndex = existing;
    job.manifest.frameCount = existing.timestamps.length;
    hydrateSegmentsFromFrameIndex(
      job.manifest.tiers.sweep.segments,
      existing.timestamps,
      job.manifest.duration,
    );
    hydrateSegmentsFromFrameIndex(
      job.manifest.tiers.detail.segments,
      existing.timestamps,
      job.manifest.duration,
    );
    return existing;
  }

  job.frameIndex = await buildFrameIndex(job);
  return job.frameIndex;
}

function getEffectiveFps(job: CacheBuildJob, frameIndex: VideoEditCacheFrameIndex): number {
  if (job.manifest.fps && job.manifest.fps > 0) {
    return job.manifest.fps;
  }
  const duration = Math.max(job.manifest.duration, 0.001);
  return Math.max(1, frameIndex.timestamps.length / duration);
}

function getSegmentDirectoryName(tier: VideoEditCacheTier): string {
  return tier;
}

async function getSegmentDirectory(
  cacheKey: string,
  tier: VideoEditCacheTier,
  create = true,
): Promise<FileSystemDirectoryHandle> {
  const cacheDir = await getVideoEditCacheDirectory(cacheKey, create);
  return await getNestedDirectoryHandle(cacheDir, getSegmentDirectoryName(tier), create);
}

async function touchSegment(
  cacheKey: string,
  tier: VideoEditCacheTier,
  segmentIndex: number,
): Promise<void> {
  const existingJob = jobs.get(cacheKey);
  if (existingJob) {
    const segment = existingJob.manifest.tiers[tier].segments[segmentIndex];
    if (!segment) return;
    segment.lastAccessedAt = Date.now();
    existingJob.manifest.lastAccessedAt = segment.lastAccessedAt;
    await persistManifest(existingJob).catch(() => {});
    return;
  }

  const cacheDir = await getVideoEditCacheDirectory(cacheKey, false).catch(() => null);
  if (!cacheDir) return;
  const manifest = await readJsonFile<unknown>(cacheDir, MANIFEST_FILE_NAME);
  if (!isTieredManifest(manifest)) return;
  const segment = manifest.tiers[tier].segments[segmentIndex];
  if (!segment) return;
  segment.lastAccessedAt = Date.now();
  manifest.lastAccessedAt = segment.lastAccessedAt;
  await writeJsonFile(cacheDir, MANIFEST_FILE_NAME, manifest).catch(() => {});
}

async function buildSegment(
  job: CacheBuildJob,
  task: CacheBuildTask,
  frameIndex: VideoEditCacheFrameIndex,
): Promise<void> {
  const tierManifest = job.manifest.tiers[task.tier];
  const segment = tierManifest.segments[task.index];
  if (!segment || segment.ready) return;

  const sink = new VideoSampleSink(job.videoTrack);
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat(),
    target,
  });
  const fps = getEffectiveFps(job, frameIndex);
  const bitrate =
    task.tier === "sweep"
      ? calculatePreviewSweepBitrate(segment.width, segment.height)
      : calculatePreviewDetailBitrate(segment.width, segment.height);
  const videoSource = new VideoSampleSource({
    codec: "avc",
    bitrate,
    keyFrameInterval: 1 / Math.max(fps, 1),
    bitrateMode: "variable",
    hardwareAcceleration: "no-preference",
    latencyMode: "quality",
  });

  output.addVideoTrack(videoSource, { frameRate: fps });
  await output.start();
  let finalized = false;

  const needsResize =
    segment.width !== job.manifest.width || segment.height !== job.manifest.height;
  const canvas = needsResize ? new OffscreenCanvas(segment.width, segment.height) : null;
  const context = canvas?.getContext("2d", { alpha: false }) ?? null;
  if (context) {
    context.imageSmoothingEnabled = true;
  }

  try {
    for await (const sample of sink.samples(segment.startTime, segment.endTime)) {
      let encodedSample: VideoSample | null = null;
      let sourceFrame: VideoFrame | null = null;
      try {
        if (needsResize && canvas && context) {
          const source = sample.toCanvasImageSource();
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(source, 0, 0, canvas.width, canvas.height);
          encodedSample = new VideoSample(canvas, {
            timestamp: sample.timestamp,
            duration: sample.duration,
            rotation: sample.rotation,
          });
        } else {
          sourceFrame = sample.toVideoFrame();
          encodedSample = new VideoSample(sourceFrame, {
            timestamp: sample.timestamp,
            duration: sample.duration,
            rotation: sample.rotation,
          });
        }

        await videoSource.add(encodedSample, { keyFrame: true });
      } finally {
        encodedSample?.close();
        sourceFrame?.close();
        sample.close();
      }
    }

    videoSource.close();
    await output.finalize();
    finalized = true;

    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0) {
      return;
    }

    const blob = new Blob([buffer], { type: segment.mimeType });
    const videoDir = await getSegmentDirectory(job.cacheKey, task.tier, true);
    await writeBlobFile(videoDir, segment.fileName, blob);

    segment.ready = true;
    segment.byteLength = blob.size;
    segment.lastAccessedAt = Date.now();
    updateManifestStatus(job.manifest);
    await persistManifest(job);
    await enforceCacheBudget(job.cacheKey);
    postMessageToMain({
      type: "segment-ready",
      cacheKey: job.cacheKey,
      tier: task.tier,
      segmentIndex: task.index,
      manifest: job.manifest,
    });
  } finally {
    if (!finalized) {
      await output.cancel().catch(() => {});
    }
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
  updateManifestStatus(manifest);

  const job: CacheBuildJob = {
    cacheKey,
    durationHint,
    fpsHint,
    manifest,
    queue: [],
    queued: new Set<string>(),
    building: false,
    disposed: false,
    input,
    videoTrack,
    frameIndex: null,
    frameIndexPromise: Promise.resolve({ timestamps: [], durations: [] }),
  };
  job.frameIndexPromise = ensureFrameIndex(job);
  jobs.set(cacheKey, job);

  enqueueSegment(job, "sweep", 0, false);
  for (const segment of manifest.tiers.sweep.segments) {
    if (!segment.ready && segment.index !== 0) {
      enqueueSegment(job, "sweep", segment.index, false);
    }
  }

  postMessageToMain({ type: "manifest", cacheKey, manifest });
  return job;
}

async function readAllCacheManifests(): Promise<VideoEditCacheManifest[]> {
  const root = await getVideoEditCacheRootDirectory(false).catch(() => null);
  if (!root) {
    return [];
  }

  const manifests: VideoEditCacheManifest[] = [];
  for (const handle of await listDirectoryEntries(root)) {
    if (handle.kind !== "directory") continue;
    const manifest = await readJsonFile<unknown>(
      handle as FileSystemDirectoryHandle,
      MANIFEST_FILE_NAME,
    );
    if (isTieredManifest(manifest)) {
      manifests.push(manifest);
      continue;
    }

    await removeDirectoryEntry(root, handle.name).catch(() => {});
  }
  return manifests;
}

function getManifestByteLength(manifest: VideoEditCacheManifest): number {
  const sweepBytes = manifest.tiers.sweep.segments.reduce(
    (sum, segment) => sum + segment.byteLength,
    0,
  );
  const detailBytes = manifest.tiers.detail.segments.reduce(
    (sum, segment) => sum + segment.byteLength,
    0,
  );
  return sweepBytes + detailBytes;
}

async function enforceCacheBudget(currentCacheKey: string): Promise<void> {
  const manifests = await readAllCacheManifests();
  let totalBytes = manifests.reduce((sum, manifest) => sum + getManifestByteLength(manifest), 0);
  if (totalBytes <= MAX_VIDEO_EDIT_CACHE_BYTES) {
    return;
  }

  const root = await getVideoEditCacheRootDirectory(true);
  const detailCandidates = manifests
    .filter((manifest) => manifest.cacheKey !== currentCacheKey)
    .flatMap((manifest) =>
      manifest.tiers.detail.segments
        .filter((segment) => segment.ready && segment.byteLength > 0)
        .map((segment) => ({ manifest, segment })),
    )
    .sort((left, right) => left.segment.lastAccessedAt - right.segment.lastAccessedAt);

  for (const candidate of detailCandidates) {
    if (totalBytes <= MAX_VIDEO_EDIT_CACHE_BYTES) break;
    const detailDir = await getSegmentDirectory(candidate.manifest.cacheKey, "detail", false).catch(
      () => null,
    );
    if (!detailDir) continue;

    await removeFileEntry(detailDir, candidate.segment.fileName);
    totalBytes -= candidate.segment.byteLength;
    candidate.segment.ready = false;
    candidate.segment.byteLength = 0;
    candidate.segment.lastAccessedAt = 0;
    updateManifestStatus(candidate.manifest);
    const cacheDir = await getVideoEditCacheDirectory(candidate.manifest.cacheKey, true);
    await writeJsonFile(cacheDir, MANIFEST_FILE_NAME, candidate.manifest);
  }

  if (totalBytes <= MAX_VIDEO_EDIT_CACHE_BYTES) {
    return;
  }

  const removableSweepCaches = manifests
    .filter((manifest) => manifest.cacheKey !== currentCacheKey)
    .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);

  for (const manifest of removableSweepCaches) {
    if (totalBytes <= MAX_VIDEO_EDIT_CACHE_BYTES) break;
    totalBytes -= getManifestByteLength(manifest);
    await removeDirectoryEntry(root, manifest.cacheKey);
  }
}

async function drainJob(job: CacheBuildJob): Promise<void> {
  if (job.building || job.disposed) return;
  job.building = true;
  try {
    const frameIndex = await job.frameIndexPromise;
    job.frameIndex = frameIndex;
    while (!job.disposed && job.queue.length > 0) {
      const task = job.queue.shift()!;
      job.queued.delete(buildTaskKey(task));
      await buildSegment(job, task, frameIndex);
    }
  } catch (error) {
    job.manifest.conformStatus = "failed";
    job.manifest.error = error instanceof Error ? error.message : "Failed to build edit cache";
    await persistManifest(job).catch(() => {});
    postMessageToMain({
      type: "error",
      cacheKey: job.cacheKey,
      message: job.manifest.error,
    });
  } finally {
    job.building = false;
  }
}

self.onmessage = async (event: MessageEvent<ToVideoEditCacheWorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "ensure-cache": {
      try {
        const job = await ensureJob(message.cacheKey, message.blob, message.duration, message.fps);
        void drainJob(job);
      } catch (error) {
        postMessageToMain({
          type: "error",
          cacheKey: message.cacheKey,
          message: error instanceof Error ? error.message : "Failed to initialize edit cache",
        });
      }
      break;
    }
    case "prioritize-time": {
      const job = jobs.get(message.cacheKey);
      if (!job) break;
      reprioritizeJob(job, message.time);
      void persistManifest(job).catch(() => {});
      void drainJob(job);
      break;
    }
    case "touch-segment": {
      void touchSegment(message.cacheKey, message.tier, message.segmentIndex);
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
