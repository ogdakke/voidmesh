/**
 * Video Exporter - Exports videos with shader effects applied
 *
 * Supports multiple export formats:
 * - MP4: WebCodecs H.264 + mediabunny MP4 muxer
 * - MOV: WebCodecs H.264 + mediabunny MP4 muxer (same container as MP4)
 * - GIF: gifenc pipeline (separate module)
 *
 * Video frames are decoded via mediabunny's WebCodecs pipeline (see lib/video-demux.ts),
 * processed through shaders on the main thread, then encoded/muxed in a Web Worker.
 */

import { config } from "#config";
import {
  type ExportFormat,
  type QualityPreset,
  type ResolutionPreset,
  type GifDitherMode,
  calculateTargetResolution,
} from "./export-formats.ts";
import type { DemuxedAudio } from "#lib/audio-demux.ts";
import { encodeFrames } from "./frame-encoder.ts";
import { createProgressChannel } from "./progress-channel.ts";

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
 * Source descriptor for animated content (video or GIF).
 */
export interface AnimatedSource {
  width: number;
  height: number;
  duration: number;
}

/**
 * Export animated content (video or GIF) with shader effects applied to each frame.
 *
 * Video frames are decoded via WebCodecs (mediabunny) and provided through the
 * renderFrame callback. No HTMLVideoElement seeking or playback required.
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
