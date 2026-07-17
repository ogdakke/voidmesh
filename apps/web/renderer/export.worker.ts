import { calculateVideoBitrate, config } from "#config";
import { demuxAudio, type DemuxedAudio } from "#lib/audio-demux.ts";
import {
  buildGifPaletteFromPixels,
  mapGifFrameToPalette,
  type GifPalette,
} from "#lib/gif-encode-core.ts";
import { decodeGif, getFrameAtTime, type GifDecodeResult } from "#lib/gif-decoder.ts";
import { createFrameIterator, demuxVideo, type VideoDemuxHandle } from "#lib/video-demux.ts";
import { GIFEncoder } from "gifenc";
import { HeadlessExportRenderer } from "./headless-export-renderer.ts";
import type { ExportJobSnapshot } from "./export-snapshot.ts";
import { calculateTargetResolution, defaultGifConfig, qualityConfigs } from "./export-formats.ts";
import type { ExportProgress } from "./video-exporter.ts";
import {
  type EncodedVideoChunkData,
  VideoEncoderSession,
  muxEncodedVideo,
  selectH264Codec,
} from "./video-encode-core.ts";

export type ToExportWorkerMessage = { type: "start"; job: ExportJobSnapshot };

export type FromExportWorkerMessage =
  | { type: "progress"; progress: ExportProgress }
  | { type: "done"; blob: Blob }
  | { type: "error"; message: string; unsupported?: boolean };

function post(msg: FromExportWorkerMessage): void {
  self.postMessage(msg);
}

function assertWorkerSupport(): void {
  if (!navigator.gpu) throw new Error("UNSUPPORTED_WORKER_EXPORT: Worker WebGPU is unavailable");
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: OffscreenCanvas is unavailable");
  }
  if (typeof VideoFrame === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: VideoFrame is unavailable");
  }
}

function emitProgress(progress: ExportProgress): void {
  post({ type: "progress", progress });
}

function createUnsupportedWorkerExportError(message: string): Error {
  return new Error(`UNSUPPORTED_WORKER_EXPORT: ${message}`);
}

function getEvenGifDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
): { width: number; height: number } {
  const scale = sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
  return {
    width: Math.floor((sourceWidth * scale) / 2) * 2 || 2,
    height: Math.floor((sourceHeight * scale) / 2) * 2 || 2,
  };
}

async function exportMp4Mov(job: ExportJobSnapshot): Promise<Blob> {
  if (typeof VideoDecoder === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: VideoDecoder is unavailable");
  }
  if (typeof VideoEncoder === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: VideoEncoder is unavailable");
  }
  if (job.entity.mediaSource.type !== "video") {
    throw new Error("MP4/MOV export requires a video source");
  }

  const source = job.entity.mediaSource;
  const demux = await demuxVideo(source.blob);
  try {
    const fps = job.options.fps ?? config.videoExporting.defaults.fps;
    const totalFrames = Math.round(demux.duration * fps);
    const dimensions = calculateTargetResolution(
      demux.width,
      demux.height,
      job.options.advanced?.resolution ?? "original",
    );
    const bitrate =
      job.options.advanced?.bitrate ??
      Math.round(
        calculateVideoBitrate(dimensions.width, dimensions.height) *
          qualityConfigs[job.options.quality ?? "high"].bitrateFactor,
      );
    let codec: string;
    try {
      codec = await selectH264Codec(dimensions.width, dimensions.height, fps, bitrate);
    } catch (error) {
      throw createUnsupportedWorkerExportError(
        error instanceof Error ? error.message : "H.264 codec not supported",
      );
    }
    const renderer = await HeadlessExportRenderer.create(dimensions.width, dimensions.height);
    try {
      if (job.requiresP3 && !renderer.colorConfig.supportsP3) {
        throw createUnsupportedWorkerExportError("Worker WebGPU display-p3 canvas is unavailable");
      }
      const audioData =
        job.options.includeAudio && source.hasAudio ? await demuxAudio(source.blob) : null;
      return await encodeRenderedVideo({
        job,
        demux,
        renderer,
        width: dimensions.width,
        height: dimensions.height,
        fps,
        totalFrames,
        bitrate,
        codec,
        audioData,
      });
    } finally {
      renderer.destroy();
    }
  } finally {
    demux.dispose();
  }
}

async function encodeRenderedVideo(params: {
  job: ExportJobSnapshot;
  demux: VideoDemuxHandle;
  renderer: HeadlessExportRenderer;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  bitrate: number;
  codec: string;
  audioData: DemuxedAudio | null;
}): Promise<Blob> {
  const { job, demux, renderer, width, height, fps, totalFrames, bitrate, codec, audioData } =
    params;
  const format = (job.options.format ?? "mp4") as "mp4" | "mov";
  const encoder = new VideoEncoderSession({
    codec,
    width,
    height,
    bitrate,
    fps,
    keyFrameIntervalSeconds: config.videoExporting.keyFrameIntervalSeconds,
    hardwareAcceleration: config.videoExporting.hardwareAcceleration,
    latencyMode: config.videoExporting.latencyMode,
    bitrateMode: config.videoExporting.bitrateMode,
  });

  const { iterator } = createFrameIterator(demux, fps);
  const initialShaderTime = job.entity.shaderParams.time ?? 0;
  const animateShaderTime = job.entity.shaderParams.timeAutoPlay !== false;
  const throwEncodeUnsupported = (error: Error): never => {
    throw createUnsupportedWorkerExportError(
      `Worker VideoEncoder cannot encode the WebGPU export canvas: ${error.message}`,
    );
  };

  let chunks: readonly EncodedVideoChunkData[] = [];
  try {
    for (let i = 0; i < totalFrames; i++) {
      const timestampSeconds = i / fps;
      const timestampUs = Math.floor(timestampSeconds * 1_000_000);
      const { value: bitmap, done } = await iterator.next();
      if (done || !bitmap) throw new Error("No more video frames");

      if (animateShaderTime) {
        job.entity.shaderParams.time = initialShaderTime + timestampSeconds;
      }

      await renderer.renderToCanvas(job.entity, bitmap, width, height);
      bitmap.close();

      const frame = new VideoFrame(renderer.canvas, {
        timestamp: timestampUs,
        duration: encoder.frameDurationUs,
        alpha: "discard",
      });
      try {
        encoder.encodeFrame(frame, i);
      } catch (error) {
        throwEncodeUnsupported(error instanceof Error ? error : new Error("VideoEncoder failed"));
      } finally {
        frame.close();
      }
      try {
        await encoder.waitForBackpressure();
      } catch (error) {
        throwEncodeUnsupported(
          error instanceof Error ? error : new Error("VideoEncoder backpressure failed"),
        );
      }

      emitProgress({
        frame: i + 1,
        totalFrames,
        percent: ((i + 1) / totalFrames) * 0.8,
        stage: "extracting",
        message: `Rendering frame ${i + 1}/${totalFrames}`,
      });
    }

    try {
      chunks = await encoder.flush();
    } catch (error) {
      throwEncodeUnsupported(
        error instanceof Error ? error : new Error("VideoEncoder flush failed"),
      );
    }
  } finally {
    encoder.close();
  }

  emitProgress({
    frame: totalFrames,
    totalFrames,
    percent: 0.85,
    stage: "muxing",
    message: "Muxing video...",
  });

  return muxEncodedVideo({
    format,
    fps,
    chunks,
    audioData,
    totalFrames,
  });
}

async function exportGif(job: ExportJobSnapshot): Promise<Blob> {
  const fps = Math.min(job.options.fps ?? 30, defaultGifConfig.maxFps);
  const maxWidth = job.options.advanced?.gifMaxWidth ?? defaultGifConfig.maxWidth;
  const useDither = (job.options.advanced?.gifDither ?? "floyd_steinberg") !== "none";
  const sourceInfo = await getAnimatedSourceInfo(job);
  const totalFrames = Math.ceil(sourceInfo.duration * fps);
  const dimensions = getEvenGifDimensions(sourceInfo.width, sourceInfo.height, maxWidth);
  const renderer = await HeadlessExportRenderer.create(dimensions.width, dimensions.height);

  try {
    const palette = await buildGifPalette({
      job,
      renderer,
      sourceInfo,
      fps,
      totalFrames,
      width: dimensions.width,
      height: dimensions.height,
    });
    const gif = GIFEncoder();
    let accumulatedError = 0;
    const initialShaderTime = job.entity.shaderParams.time ?? 0;
    const timestamps = Array.from({ length: totalFrames }, (_, i) => i / fps);
    let i = 0;

    for await (const source of iterateFrameSources(job, sourceInfo, timestamps)) {
      const timestampSeconds = i / fps;
      const pixels = await renderFramePixels({
        job,
        renderer,
        source,
        timestampSeconds,
        initialShaderTime,
        width: dimensions.width,
        height: dimensions.height,
      });
      closeFrameSource(sourceInfo, source);

      const indexed = mapGifFrameToPalette({
        pixels,
        width: dimensions.width,
        height: dimensions.height,
        palette,
        dither: useDither,
      });
      const idealDelay = 100 / fps + accumulatedError;
      const delayCentiseconds = Math.max(1, Math.round(idealDelay));
      accumulatedError = idealDelay - delayCentiseconds;

      gif.writeFrame(indexed, dimensions.width, dimensions.height, {
        palette,
        repeat: 0,
        delay: delayCentiseconds * 10,
      });

      emitProgress({
        frame: i + 1,
        totalFrames,
        percent: 0.15 + ((i + 1) / totalFrames) * 0.85,
        stage: "encoding",
        message: `Encoding frame ${i + 1}/${totalFrames}`,
      });
      i++;
    }

    gif.finish();
    const bytes = gif.bytes();
    return new Blob([bytes], { type: "image/gif" });
  } finally {
    sourceInfo.dispose();
    renderer.destroy();
  }
}

type AnimatedSourceInfo =
  | {
      type: "video";
      width: number;
      height: number;
      duration: number;
      demux: VideoDemuxHandle;
      dispose(): void;
    }
  | {
      type: "gif";
      width: number;
      height: number;
      duration: number;
      gif: GifDecodeResult;
      dispose(): void;
    };

async function getAnimatedSourceInfo(job: ExportJobSnapshot): Promise<AnimatedSourceInfo> {
  if (job.entity.mediaSource.type === "video") {
    if (typeof VideoDecoder === "undefined") {
      throw new Error("UNSUPPORTED_WORKER_EXPORT: VideoDecoder is unavailable");
    }
    const demux = await demuxVideo(job.entity.mediaSource.blob);
    return {
      type: "video",
      width: demux.width,
      height: demux.height,
      duration: demux.duration,
      demux,
      dispose: () => demux.dispose(),
    };
  }

  if (typeof ImageDecoder === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: ImageDecoder is unavailable");
  }
  const gif = await decodeGif(job.entity.mediaSource.blob);
  return {
    type: "gif",
    width: gif.width,
    height: gif.height,
    duration: gif.duration,
    gif,
    dispose: () => {
      for (const frame of gif.frames) frame.bitmap.close();
    },
  };
}

async function buildGifPalette(params: {
  job: ExportJobSnapshot;
  renderer: HeadlessExportRenderer;
  sourceInfo: AnimatedSourceInfo;
  fps: number;
  totalFrames: number;
  width: number;
  height: number;
}): Promise<GifPalette> {
  const { job, renderer, sourceInfo, fps, totalFrames, width, height } = params;
  const sampleInterval = Math.max(1, Math.floor(totalFrames / 20));
  const initialShaderTime = job.entity.shaderParams.time ?? 0;
  const sampleFrameIndexes: number[] = [];
  for (let i = 0; i < totalFrames; i += sampleInterval) {
    sampleFrameIndexes.push(i);
  }
  const sampleTimestamps = sampleFrameIndexes.map((frameIndex) => frameIndex / fps);
  const sampledPixels: Uint8ClampedArray<ArrayBuffer>[] = [];
  let sampleIndex = 0;

  for await (const source of iterateFrameSources(job, sourceInfo, sampleTimestamps)) {
    const frameIndex = sampleFrameIndexes[sampleIndex]!;
    const timestampSeconds = sampleTimestamps[sampleIndex]!;
    sampledPixels.push(
      await renderFramePixels({
        job,
        renderer,
        source,
        timestampSeconds,
        initialShaderTime,
        width,
        height,
      }),
    );
    closeFrameSource(sourceInfo, source);

    emitProgress({
      frame: frameIndex + 1,
      totalFrames,
      percent: ((frameIndex + 1) / totalFrames) * 0.15,
      stage: "encoding",
      message: `Sampling frame ${frameIndex + 1}/${totalFrames}`,
    });
    sampleIndex++;
  }

  return buildGifPaletteFromPixels(sampledPixels, defaultGifConfig.maxColors);
}

async function* iterateFrameSources(
  job: ExportJobSnapshot,
  sourceInfo: AnimatedSourceInfo,
  timestamps: readonly number[],
): AsyncGenerator<ImageBitmap> {
  if (sourceInfo.type === "gif") {
    for (const timestampSeconds of timestamps) {
      yield getFrameAtTime(sourceInfo.gif.frames, timestampSeconds, true).bitmap;
    }
    return;
  }

  const demux = await demuxVideo(job.entity.mediaSource.blob);
  try {
    for await (const bitmap of demux.frames(timestamps)) {
      yield bitmap;
    }
  } finally {
    demux.dispose();
  }
}

async function renderFramePixels(params: {
  job: ExportJobSnapshot;
  renderer: HeadlessExportRenderer;
  source: ImageBitmap;
  timestampSeconds: number;
  initialShaderTime: number;
  width: number;
  height: number;
}): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const { job, renderer, source, timestampSeconds, initialShaderTime, width, height } = params;
  if (job.entity.shaderParams.timeAutoPlay !== false) {
    job.entity.shaderParams.time = initialShaderTime + timestampSeconds;
  }
  return renderer.renderToPixels(job.entity, source, width, height);
}

function closeFrameSource(sourceInfo: AnimatedSourceInfo, source: ImageBitmap): void {
  if (sourceInfo.type === "video") source.close();
}

async function handleStart(job: ExportJobSnapshot): Promise<void> {
  assertWorkerSupport();

  const format = job.options.format ?? "mp4";
  const blob = format === "gif" ? await exportGif(job) : await exportMp4Mov(job);

  post({ type: "done", blob });
}

self.onmessage = async (event: MessageEvent<ToExportWorkerMessage>) => {
  try {
    await handleStart(event.data.job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed";
    post({
      type: "error",
      message,
      unsupported: message.startsWith("UNSUPPORTED_WORKER_EXPORT:"),
    });
  }
};
