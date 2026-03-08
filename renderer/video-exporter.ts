/**
 * Video Exporter - Exports videos with shader effects applied
 *
 * Supports multiple export formats:
 * - MP4: WebCodecs H.264 + mediabunny MP4 muxer
 * - WebM: WebCodecs VP9/VP8 + mediabunny WebM muxer
 * - MOV: WebCodecs H.264 + mediabunny MP4 muxer (same container as MP4)
 * - GIF: gifenc pipeline (separate module)
 *
 * Uses a Web Worker for encoding and muxing to keep the main thread responsive.
 * The main thread handles WebGPU rendering (GPU device cannot be transferred to workers).
 */

import type { ToWorkerMessage, FromWorkerMessage } from "./video-export.worker.ts";
import { config, calculateVideoBitrate } from "#config";
import { logger, LogLevel } from "#lib/client.logger.ts";
import {
  type ExportFormat,
  type QualityPreset,
  type ResolutionPreset,
  type GifDitherMode,
  qualityConfigs,
  calculateTargetResolution,
} from "./export-formats.ts";
import type { DemuxedAudio } from "#lib/audio-demux.ts";
import { encodeFrames, selectCodec } from "./frame-encoder.ts";
import { createProgressChannel } from "./progress-channel.ts";

/** Check if the video element supports requestVideoFrameCallback */
function hasRVFC(video: HTMLVideoElement): boolean {
  return "requestVideoFrameCallback" in video;
}

export interface ExportProgress {
  frame: number;
  totalFrames: number;
  percent: number; // 0-1
  stage:
    | "extracting" // Extracting/rendering frames from video
    | "encoding" // Encoding video with WebCodecs
    | "muxing" // Creating container
    | "extracting-audio" // Extracting audio from original
    | "adding-audio" // Muxing audio into processed video
    | "done";
  message?: string;
}

export interface VideoExportOptions {
  /** Frames per second. Default: 30 */
  fps?: number;
  /** Export format. Default: 'mp4' */
  format?: ExportFormat;
  /** Quality preset. Default: 'high' */
  quality?: QualityPreset;
  /** Include audio from original video. Default: true (except GIF) */
  includeAudio?: boolean;
  /** Advanced encoding options */
  advanced?: {
    /** Explicit bitrate in bps. Overrides auto-calculation. */
    bitrate?: number;
    /** Target resolution. Default: 'original' */
    resolution?: ResolutionPreset | { width: number; height: number };
    /** GIF dither algorithm. Default: 'floyd_steinberg' */
    gifDither?: GifDitherMode;
    /** GIF maximum width (maintains aspect ratio). Default: 480 */
    gifMaxWidth?: number;
  };
}

export interface VideoExportHandle {
  /** Async iterable for progress updates - consume via for-await */
  progress: AsyncIterable<ExportProgress>;
  /** Promise that resolves to the final video blob */
  result: Promise<Blob>;
  /** Cancel the export */
  cancel: () => void;
}

/**
 * Unified source descriptor for animated content (video or GIF).
 * Abstracts over HTMLVideoElement vs GIF frames for the export pipeline.
 */
export interface AnimatedSource {
  width: number;
  height: number;
  duration: number;
  /** Original video element for audio extraction/state management. Null for GIF sources. */
  videoElement: HTMLVideoElement | null;
}

/**
 * Export animated content (video or GIF) with shader effects applied to each frame
 *
 * @param source - Animated source descriptor (video or GIF dimensions/duration)
 * @param renderFrame - Function that renders a frame at given timestamp, returns ImageBitmap
 * @param options - Export options (format, fps, quality, etc.)
 * @returns Handle with progress iterable, result promise, and cancel function
 */
export function exportVideo(
  source: AnimatedSource,
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  options: VideoExportOptions = {},
  audioData?: DemuxedAudio | null,
): VideoExportHandle {
  const { videoExporting } = config;
  const format = options.format ?? "mp4";
  const fps = options.fps ?? videoExporting.defaults.fps;

  // GIF uses a separate pipeline (gifenc)
  if (format === "gif") {
    return exportGifLazy(source, renderFrame, options);
  }

  const resolution = calculateTargetResolution(
    source.width,
    source.height,
    options.advanced?.resolution ?? "original",
  );

  const video = source.videoElement;

  // RVFC-capable video: use playback-based export (handles B-frames correctly)
  if (video && hasRVFC(video)) {
    return exportWithPlayback(
      video,
      source,
      renderFrame,
      fps,
      resolution,
      format,
      options,
      audioData ?? null,
    );
  }

  // Seek-based path (GIF sources, non-RVFC browsers): delegate to shared FrameEncoder
  const handle = encodeFrames(renderFrame, {
    width: resolution.width,
    height: resolution.height,
    fps,
    duration: source.duration,
    format: format as "mp4" | "mov",
    quality: options.quality,
    bitrate: options.advanced?.bitrate,
    audioData: audioData ?? null,
  });

  // Adapt EncodeProgress → ExportProgress
  async function* adaptProgress(): AsyncGenerator<ExportProgress> {
    for await (const p of handle.progress) {
      yield {
        frame: p.frame,
        totalFrames: p.totalFrames,
        percent: p.percent,
        stage: p.stage === "encoding" ? "extracting" : p.stage,
      };
    }
  }

  return {
    progress: adaptProgress(),
    result: handle.result,
    cancel: handle.cancel,
  };
}

/**
 * RVFC playback-based export: manages its own worker because frames are fed
 * asynchronously during requestVideoFrameCallback, not in a simple loop.
 */
function exportWithPlayback(
  video: HTMLVideoElement,
  source: AnimatedSource,
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  fps: number,
  resolution: { width: number; height: number },
  format: ExportFormat,
  options: VideoExportOptions,
  audioData: DemuxedAudio | null,
): VideoExportHandle {
  const qualityFactor = qualityConfigs[options.quality ?? "high"].bitrateFactor;
  const bitrate =
    options.advanced?.bitrate ??
    Math.round(calculateVideoBitrate(resolution.width, resolution.height) * qualityFactor);

  let cancelled = false;
  let resolveResult: (blob: Blob) => void;
  let rejectResult: (error: Error) => void;

  const resultPromise = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const progress = createProgressChannel<ExportProgress>(
    (p) => p.stage === "done",
    () => cancelled,
  );

  const worker = new Worker(new URL("./video-export.worker.ts", import.meta.url), {
    type: "module",
  });

  worker.onmessage = (event: MessageEvent<FromWorkerMessage>) => {
    const msg = event.data;

    switch (msg.type) {
      case "progress":
        progress.emit({
          frame: msg.frame,
          totalFrames: msg.totalFrames,
          percent: msg.percent,
          stage: msg.stage,
        });
        break;
      case "done":
        resolveResult!(msg.blob);
        worker.terminate();
        break;
      case "error":
        cancelled = true;
        rejectResult!(new Error(msg.message));
        progress.wake();
        worker.terminate();
        break;
    }
  };

  worker.onerror = (event) => {
    cancelled = true;
    rejectResult!(new Error(event.message || "Worker error"));
    progress.wake();
    worker.terminate();
  };

  runPlaybackExportPipeline(
    video,
    source,
    renderFrame,
    fps,
    bitrate,
    resolution,
    format,
    worker,
    () => cancelled,
    audioData,
  ).catch((err) => {
    cancelled = true;
    rejectResult!(err);
    progress.wake();
    worker.terminate();
  });

  return {
    progress: progress.generator(),
    result: resultPromise,
    cancel: () => {
      cancelled = true;
      const msg: ToWorkerMessage = { type: "cancel" };
      worker.postMessage(msg);
      worker.terminate();
      progress.wake();
      rejectResult(new Error("Export cancelled"));
    },
  };
}

/** Full pipeline for RVFC playback-based export (worker init + playback + finish) */
async function runPlaybackExportPipeline(
  video: HTMLVideoElement,
  source: AnimatedSource,
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  fps: number,
  bitrate: number,
  resolution: { width: number; height: number },
  format: ExportFormat,
  worker: Worker,
  isCancelled: () => boolean,
  audioData: DemuxedAudio | null,
): Promise<void> {
  const { width, height } = resolution;
  const totalFrames = Math.round(source.duration * fps);

  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs API not supported in this browser");
  }

  const { videoExporting } = config;
  const codec = await selectCodec(width, height, fps, bitrate);

  const initMsg: ToWorkerMessage = {
    type: "init",
    width,
    height,
    fps,
    bitrate,
    totalFrames,
    format,
    codec,
    keyFrameIntervalSeconds: videoExporting.keyFrameIntervalSeconds,
    hardwareAcceleration: videoExporting.hardwareAcceleration,
    latencyMode: videoExporting.latencyMode,
    bitrateMode: videoExporting.bitrateMode,
    debug: logger.level <= LogLevel.DEBUG,
  };
  worker.postMessage(initMsg);

  if (audioData) {
    const audioMsg: ToWorkerMessage = {
      type: "audio-track",
      packets: audioData.packets,
      codec: audioData.codec,
      sampleRate: audioData.sampleRate,
      numberOfChannels: audioData.numberOfChannels,
      description: audioData.description,
    };
    worker.postMessage(audioMsg);
  }

  const wasPlaying = !video.paused;
  const originalTime = video.currentTime;

  try {
    logger.debug(
      `[export] Starting ${format} playback export: ${totalFrames} frames at ${fps}fps, ${width}x${height}, codec=${codec}`,
    );
    const exportStart = performance.now();

    await runPlaybackExport(video, renderFrame, fps, totalFrames, worker, isCancelled);

    logger.debug(
      `[export] All frames rendered in ${((performance.now() - exportStart) / 1000).toFixed(1)}s, signaling finish to worker`,
    );

    const finishMsg: ToWorkerMessage = { type: "finish" };
    worker.postMessage(finishMsg);
  } finally {
    video.pause();
    video.currentTime = originalTime;
    if (wasPlaying) {
      await video.play();
    }
  }
}

/**
 * Playback-based export: play the video and capture each frame via
 * requestVideoFrameCallback. This ensures B-frames are properly decoded
 * since the browser's video pipeline handles them naturally during playback.
 */
async function runPlaybackExport(
  video: HTMLVideoElement,
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  fps: number,
  totalFrames: number,
  worker: Worker,
  isCancelled: () => boolean,
): Promise<void> {
  const frameDuration = 1 / fps;
  let frameIndex = 0;
  let nextFrameTime = 0;

  video.pause();
  video.currentTime = 0;
  await new Promise<void>((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
  });

  const originalMuted = video.muted;
  video.muted = true;

  return new Promise<void>((resolve, reject) => {
    type RVFCCallback = (now: number, metadata: { mediaTime: number }) => void;
    const rvfc = video as HTMLVideoElement & {
      requestVideoFrameCallback: (cb: RVFCCallback) => number;
      cancelVideoFrameCallback: (id: number) => void;
    };

    let callbackId: number;
    let settled = false;

    const STALL_TIMEOUT_MS = 30_000;
    let stallTimer = setTimeout(onStall, STALL_TIMEOUT_MS);

    function resetStallTimer(): void {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(onStall, STALL_TIMEOUT_MS);
    }

    function onStall(): void {
      if (settled) return;
      settled = true;
      video.pause();
      video.muted = originalMuted;
      reject(new Error(`Export stalled: no frames captured for ${STALL_TIMEOUT_MS / 1000}s`));
    }

    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      video.pause();
      video.muted = originalMuted;
      resolve();
    }

    async function captureRemainingFrames(): Promise<void> {
      while (frameIndex < totalFrames) {
        if (isCancelled()) throw new Error("Export cancelled");

        const timestampSeconds = frameIndex / fps;
        const timestampUs = Math.floor(timestampSeconds * 1_000_000);
        const frameStart = performance.now();

        const renderedBitmap = await renderFrame(timestampSeconds);
        const renderTime = performance.now() - frameStart;

        const frameMsg: ToWorkerMessage = {
          type: "frame",
          bitmap: renderedBitmap,
          frameIndex,
          timestampUs,
        };
        worker.postMessage(frameMsg, [renderedBitmap]);

        if (frameIndex % 10 === 0) {
          logger.debug(
            `[export] frame ${frameIndex}/${totalFrames} (flush), rendered in ${renderTime.toFixed(1)}ms`,
          );
        }

        frameIndex++;
        nextFrameTime = frameIndex / fps;
      }
    }

    const onFrame: RVFCCallback = async (_now, metadata) => {
      try {
        if (isCancelled() || settled) {
          clearTimeout(stallTimer);
          video.pause();
          video.muted = originalMuted;
          if (!settled) {
            settled = true;
            reject(new Error("Export cancelled"));
          }
          return;
        }

        const mediaTime = metadata.mediaTime;

        while (nextFrameTime <= mediaTime + frameDuration * 0.5 && frameIndex < totalFrames) {
          const timestampSeconds = frameIndex / fps;
          const timestampUs = Math.floor(timestampSeconds * 1_000_000);
          const frameStart = performance.now();

          const renderedBitmap = await renderFrame(timestampSeconds);
          const renderTime = performance.now() - frameStart;

          const frameMsg: ToWorkerMessage = {
            type: "frame",
            bitmap: renderedBitmap,
            frameIndex,
            timestampUs,
          };
          worker.postMessage(frameMsg, [renderedBitmap]);
          resetStallTimer();

          if (frameIndex % 10 === 0) {
            logger.debug(
              `[export] frame ${frameIndex}/${totalFrames} captured at mediaTime=${mediaTime.toFixed(3)}s, rendered in ${renderTime.toFixed(1)}ms`,
            );
          }

          frameIndex++;
          nextFrameTime = frameIndex / fps;
        }

        if (frameIndex >= totalFrames) {
          finish();
          return;
        }

        callbackId = rvfc.requestVideoFrameCallback(onFrame);
      } catch (err) {
        clearTimeout(stallTimer);
        video.pause();
        video.muted = originalMuted;
        rvfc.cancelVideoFrameCallback(callbackId);
        video.removeEventListener("ended", onEnded);
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    };

    const onEnded = async () => {
      video.removeEventListener("ended", onEnded);
      if (settled || frameIndex >= totalFrames) return;

      logger.debug(
        `[export] video ended with ${totalFrames - frameIndex} frames remaining, flushing`,
      );
      try {
        await captureRemainingFrames();
        finish();
      } catch (err) {
        clearTimeout(stallTimer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    };
    video.addEventListener("ended", onEnded);

    callbackId = rvfc.requestVideoFrameCallback(onFrame);
    video.play().catch((err) => {
      clearTimeout(stallTimer);
      rvfc.cancelVideoFrameCallback(callbackId);
      video.removeEventListener("ended", onEnded);
      video.muted = originalMuted;
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * Lazy import for GIF export to keep it tree-shakable
 */
function exportGifLazy(
  source: AnimatedSource,
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  options: VideoExportOptions,
): VideoExportHandle {
  let cancelled = false;
  let resolveResult: (blob: Blob) => void;
  let rejectResult: (error: Error) => void;

  const resultPromise = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const progress = createProgressChannel<ExportProgress>(
    (p) => p.stage === "done",
    () => cancelled,
  );

  import("./gif-export.ts")
    .then(({ exportGif }) =>
      exportGif(source, renderFrame, options, progress.emit, () => cancelled),
    )
    .then((blob) => resolveResult(blob))
    .catch((err) => rejectResult(err));

  return {
    progress: progress.generator(),
    result: resultPromise,
    cancel: () => {
      cancelled = true;
      progress.wake();
      rejectResult(new Error("Export cancelled"));
    },
  };
}

/**
 * Check if video export is supported in the current browser
 */
export async function isVideoExportSupported(): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") {
    return false;
  }

  try {
    const result = await VideoEncoder.isConfigSupported({
      codec: config.videoExporting.codec,
      width: 640,
      height: 480,
      bitrate: 1_000_000,
      framerate: 30,
    });
    return result.supported ?? false;
  } catch {
    return false;
  }
}

// Re-export types for convenient access
export type {
  ExportFormat,
  QualityPreset,
  ResolutionPreset,
  GifDitherMode,
} from "./export-formats.ts";
export {
  formatConfigs,
  qualityConfigs,
  defaultGifConfig,
  getFormatExtension,
  getFormatMimeType,
  formatSupportsAudio,
} from "./export-formats.ts";
