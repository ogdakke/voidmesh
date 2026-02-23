/**
 * Video Exporter - Exports videos with shader effects applied
 *
 * Supports multiple export formats:
 * - MP4: WebCodecs fast path (H.264 + mp4box.js) - fastest, best compatibility
 * - WebM/MOV/GIF: FFmpeg pipeline (PNG frames → ffmpeg.wasm encode)
 *
 * Uses a Web Worker for H.264 encoding and MP4 muxing to keep the main thread responsive.
 * The main thread handles WebGPU rendering (GPU device cannot be transferred to workers).
 */

import type { ToWorkerMessage, FromWorkerMessage } from "./video-export.worker.ts";
import { config, calculateVideoBitrate, getH264Codec } from "#config";
import { logger, LogLevel } from "#lib/client.logger.ts";
import {
  type ExportFormat,
  type QualityPreset,
  type ResolutionPreset,
  type GifDitherMode,
} from "./export-formats.ts";
import { exportVideoFFmpeg } from "./video-export-ffmpeg.ts";

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
    | "encoding" // Encoding video with WebCodecs or FFmpeg
    | "muxing" // Creating MP4 container
    | "extracting-audio" // Extracting audio from original (ffmpeg)
    | "adding-audio" // Muxing audio into processed video (ffmpeg)
    | "done";
  message?: string; // Optional detailed status message
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
    /** CRF value (0-51, lower = better quality). Overrides quality preset. */
    crf?: number;
    /** Explicit bitrate in kbps. Overrides auto-calculation. */
    bitrate?: number;
    /** Target resolution. Default: 'original' */
    resolution?: ResolutionPreset | { width: number; height: number };
    /** Two-pass encoding for better file size (WebM/MP4). */
    twoPass?: boolean;
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
): VideoExportHandle {
  const { videoExporting } = config;
  const format = options.format ?? "mp4";
  const fps = options.fps ?? videoExporting.defaults.fps;
  const quality = options.quality ?? "high";

  // Route to FFmpeg pipeline for non-MP4 formats
  if (format !== "mp4") {
    return exportVideoFFmpeg(source, renderFrame, {
      fps,
      format,
      quality,
      resolution: options.advanced?.resolution,
      includeAudio: options.includeAudio,
      advanced: {
        crf: options.advanced?.crf,
        bitrate: options.advanced?.bitrate,
        gifDither: options.advanced?.gifDither,
        gifMaxWidth: options.advanced?.gifMaxWidth,
      },
    });
  }

  // MP4 fast path: WebCodecs + mp4box.js
  // Auto-calculate bitrate based on resolution if not explicitly provided
  const bitrate = options.advanced?.bitrate ?? calculateVideoBitrate(source.width, source.height);

  let cancelled = false;
  let resolveResult: (blob: Blob) => void;
  let rejectResult: (error: Error) => void;

  const resultPromise = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  // Progress channel using a simple queue pattern
  const progressQueue: ExportProgress[] = [];
  let progressResolve: (() => void) | null = null;

  function emitProgress(progress: ExportProgress): void {
    progressQueue.push(progress);
    if (progressResolve) {
      progressResolve();
      progressResolve = null;
    }
  }

  // Wake up the progress generator without adding a progress event
  // Used when cancelling to break the generator out of its wait
  function wakeProgressGenerator(): void {
    if (progressResolve) {
      progressResolve();
      progressResolve = null;
    }
  }

  async function* progressGenerator(): AsyncGenerator<ExportProgress> {
    while (true) {
      // Check for cancellation before waiting
      if (cancelled) return;

      if (progressQueue.length > 0) {
        const progress = progressQueue.shift()!;
        yield progress;
        if (progress.stage === "done") return;
      } else {
        await new Promise<void>((resolve) => {
          progressResolve = resolve;
        });
        // Check for cancellation after waking up
        if (cancelled) return;
      }
    }
  }

  // Create worker
  const worker = new Worker(new URL("./video-export.worker.ts", import.meta.url), {
    type: "module",
  });

  // Handle worker messages
  worker.onmessage = (event: MessageEvent<FromWorkerMessage>) => {
    const msg = event.data;

    switch (msg.type) {
      case "progress":
        emitProgress({
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
        rejectResult!(new Error(msg.message));
        worker.terminate();
        break;
    }
  };

  worker.onerror = (event) => {
    rejectResult!(new Error(event.message || "Worker error"));
    worker.terminate();
  };

  // Start export in background
  runExport(source, renderFrame, fps, bitrate, worker, () => cancelled).catch((err) => {
    rejectResult!(err);
    worker.terminate();
  });

  return {
    progress: progressGenerator(),
    result: resultPromise,
    cancel: () => {
      cancelled = true;
      const msg: ToWorkerMessage = { type: "cancel" };
      worker.postMessage(msg);
      worker.terminate();
      wakeProgressGenerator(); // Break the progress generator loop
      rejectResult(new Error("Export cancelled"));
    },
  };
}

async function runExport(
  source: AnimatedSource,
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  fps: number,
  bitrate: number,
  worker: Worker,
  isCancelled: () => boolean,
): Promise<void> {
  const width = source.width;
  const height = source.height;
  const duration = source.duration;
  const totalFrames = Math.round(duration * fps);

  // Check WebCodecs support
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs API not supported in this browser");
  }

  const { videoExporting } = config;

  // Select H.264 level appropriate for the actual resolution/fps
  // (lower levels are more reliably hardware-decoded on iOS)
  const codec = getH264Codec(width, height, fps);

  // Check H.264 support (High Profile)
  const codecSupport = await VideoEncoder.isConfigSupported({
    codec,
    width,
    height,
    bitrate,
    framerate: fps,
  });

  if (!codecSupport.supported) {
    throw new Error("H.264 High Profile codec not supported");
  }

  // Initialize worker with all encoder config
  const initMsg: ToWorkerMessage = {
    type: "init",
    width,
    height,
    fps,
    bitrate,
    totalFrames,
    // Encoder config from centralized config
    codec,
    mp4Timescale: videoExporting.mp4Timescale,
    keyFrameIntervalSeconds: videoExporting.keyFrameIntervalSeconds,
    hardwareAcceleration: videoExporting.hardwareAcceleration,
    latencyMode: videoExporting.latencyMode,
    bitrateMode: videoExporting.bitrateMode,
    debug: logger.level <= LogLevel.DEBUG,
  };
  worker.postMessage(initMsg);

  const video = source.videoElement;
  const wasPlaying = video ? !video.paused : false;
  const originalTime = video ? video.currentTime : 0;

  try {
    logger.debug(
      `[export] Starting export: ${totalFrames} frames at ${fps}fps, ${width}x${height}, duration=${duration.toFixed(3)}s`,
    );
    const exportStart = performance.now();

    // For video sources with requestVideoFrameCallback support, use
    // playback-based capture. This lets the browser's decoder naturally
    // handle B-frames instead of seeking frame-by-frame (which produces
    // duplicate frames because B-frames can't be decoded on a paused video).
    if (video && hasRVFC(video)) {
      await runPlaybackExport(video, renderFrame, fps, totalFrames, worker, isCancelled);
    } else {
      // Fallback: seek-based export for GIF sources or browsers without RVFC
      source.videoElement?.pause();
      await runSeekExport(renderFrame, fps, totalFrames, worker, isCancelled);
    }

    logger.debug(
      `[export] All frames rendered in ${((performance.now() - exportStart) / 1000).toFixed(1)}s, signaling finish to worker`,
    );

    // Signal finish to worker
    const finishMsg: ToWorkerMessage = { type: "finish" };
    worker.postMessage(finishMsg);
  } finally {
    // Restore video state
    if (video) {
      video.pause();
      video.currentTime = originalTime;
      if (wasPlaying) {
        await video.play();
      }
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
  let nextFrameTime = 0; // Next target timestamp to capture

  // Seek to beginning and wait
  video.pause();
  video.currentTime = 0;
  await new Promise<void>((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
  });

  // Mute to avoid audio during export playback
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

    // Stall detection: if no frame is captured within 30s, abort
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

    // Capture all remaining frames up to totalFrames using whatever frame
    // the video element currently has composited (used both by RVFC and ended handler)
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

        // Capture frames for every target timestamp the video has passed.
        // The video may play faster than we can process, so we capture
        // all frames up to the current media time.
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

        // Request next frame callback
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

    // When the video reaches its end, RVFC stops firing. Flush remaining
    // frames using the last composited frame (visually correct for the
    // final few frames near the end of the video).
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

    // Start playback and register RVFC
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
 * Seek-based export fallback: used for GIF sources or browsers without
 * requestVideoFrameCallback. Seeks to each frame timestamp sequentially.
 */
async function runSeekExport(
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  fps: number,
  totalFrames: number,
  worker: Worker,
  isCancelled: () => boolean,
): Promise<void> {
  for (let i = 0; i < totalFrames; i++) {
    if (isCancelled()) {
      throw new Error("Export cancelled");
    }

    const timestampSeconds = i / fps;
    const timestampUs = Math.floor(timestampSeconds * 1_000_000);
    const frameStart = performance.now();

    const renderedBitmap = await renderFrame(timestampSeconds);
    const renderTime = performance.now() - frameStart;

    const frameMsg: ToWorkerMessage = {
      type: "frame",
      bitmap: renderedBitmap,
      frameIndex: i,
      timestampUs,
    };
    worker.postMessage(frameMsg, [renderedBitmap]);

    if (i % 10 === 0) {
      logger.debug(`[export] frame ${i}/${totalFrames} rendered in ${renderTime.toFixed(1)}ms`);
    }

    if (i % 5 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
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
