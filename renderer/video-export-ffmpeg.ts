/**
 * FFmpeg-based Video Export Pipeline
 *
 * Handles export to formats that require ffmpeg (WebM, GIF, MOV).
 * Uses PNG frame extraction → ffmpeg encoding workflow.
 */

import {
  getFFmpeg,
  writeFramesToFS,
  cleanupFrames,
  encodeVideo,
  encodeGif,
  extractAudio,
  terminateFFmpeg,
  type EncodeProgressCallback,
} from "#lib/ffmpeg-service.ts";
import {
  type ExportFormat,
  type QualityPreset,
  type GifDitherMode,
  type ResolutionPreset,
  formatSupportsAudio,
  calculateTargetResolution,
  defaultGifConfig,
} from "./export-formats.ts";
import type { ExportProgress, AnimatedSource } from "./video-exporter.ts";

// ============================================================================
// Types
// ============================================================================

export interface FFmpegExportOptions {
  fps: number;
  format: Exclude<ExportFormat, "mp4">;
  quality: QualityPreset;
  resolution?: ResolutionPreset | { width: number; height: number };
  includeAudio?: boolean;
  advanced?: {
    crf?: number;
    bitrate?: number;
    gifDither?: GifDitherMode;
    gifMaxWidth?: number;
  };
}

export interface FFmpegExportHandle {
  progress: AsyncIterable<ExportProgress>;
  result: Promise<Blob>;
  cancel: () => void;
}

// ============================================================================
// Main Export Function
// ============================================================================

/**
 * Export animated content using FFmpeg for formats not supported by WebCodecs fast path
 */
export function exportVideoFFmpeg(
  source: AnimatedSource,
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  options: FFmpegExportOptions,
): FFmpegExportHandle {
  let cancelled = false;
  let resolveResult: (blob: Blob) => void;
  let rejectResult: (error: Error) => void;

  const resultPromise = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  // Progress channel
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

  // Start export
  runFFmpegExport(source, renderFrame, options, emitProgress, () => cancelled)
    .then((blob) => {
      resolveResult(blob);
    })
    .catch((error) => {
      rejectResult(error);
    });

  return {
    progress: progressGenerator(),
    result: resultPromise,
    cancel: () => {
      cancelled = true;
      terminateFFmpeg(); // Actually stop FFmpeg worker
      wakeProgressGenerator(); // Break the progress generator loop
      rejectResult(new Error("Export cancelled"));
    },
  };
}

// ============================================================================
// Internal Export Pipeline
// ============================================================================

async function runFFmpegExport(
  source: AnimatedSource,
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  options: FFmpegExportOptions,
  emitProgress: (progress: ExportProgress) => void,
  isCancelled: () => boolean,
): Promise<Blob> {
  const { fps, format, quality, resolution = "original", includeAudio = true, advanced } = options;

  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const duration = source.duration;
  const totalFrames = Math.ceil(duration * fps);

  // Calculate target resolution
  const { width, height } = calculateTargetResolution(sourceWidth, sourceHeight, resolution);

  // Ensure ffmpeg is loaded
  await getFFmpeg();

  // Store original video state (only if we have a video element)
  const video = source.videoElement;
  const wasPlaying = video ? !video.paused : false;
  const originalTime = video ? video.currentTime : 0;

  try {
    video?.pause();

    // Phase 1: Extract frames as PNG blobs
    const frames: Blob[] = [];

    emitProgress({
      frame: 0,
      totalFrames,
      percent: 0,
      stage: "extracting",
      message: "Extracting frames...",
    });

    for (let i = 0; i < totalFrames; i++) {
      if (isCancelled()) {
        throw new Error("Export cancelled");
      }

      const timestampSeconds = i / fps;

      // Render frame through shader
      const bitmap = await renderFrame(timestampSeconds);

      // Convert ImageBitmap to PNG Blob
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d")!;

      // Scale if resolution differs from source
      if (width !== bitmap.width || height !== bitmap.height) {
        ctx.drawImage(bitmap, 0, 0, width, height);
      } else {
        ctx.drawImage(bitmap, 0, 0);
      }
      bitmap.close();

      const pngBlob = await canvas.convertToBlob({ type: "image/png" });
      frames.push(pngBlob);

      emitProgress({
        frame: i + 1,
        totalFrames,
        percent: ((i + 1) / totalFrames) * 0.4, // 0-40% for frame extraction
        stage: "extracting",
        message: `Extracting frame ${i + 1}/${totalFrames}`,
      });

      // Yield to event loop periodically
      if (i % 5 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (isCancelled()) {
      throw new Error("Export cancelled");
    }

    // Phase 2: Extract audio if needed (skip for GIF sources - no audio)
    let audioBlob: Blob | null = null;
    if (includeAudio && formatSupportsAudio(format) && video) {
      emitProgress({
        frame: totalFrames,
        totalFrames,
        percent: 0.4,
        stage: "extracting-audio",
        message: "Extracting audio...",
      });

      // Get original video as blob for audio extraction
      const videoBlob = await fetch(video.src).then((r) => r.blob());
      audioBlob = await extractAudio(videoBlob, (p) => {
        emitProgress({
          frame: totalFrames,
          totalFrames,
          percent: 0.4 + p.percent * 0.001, // 40-50% for audio
          stage: "extracting-audio",
          message: p.message,
        });
      });
    }

    if (isCancelled()) {
      throw new Error("Export cancelled");
    }

    // Phase 3: Write frames to ffmpeg filesystem
    const framePattern = await writeFramesToFS(frames, (p) => {
      emitProgress({
        frame: totalFrames,
        totalFrames,
        percent: 0.5 + p.percent * 0.001, // 50-60% for writing frames
        stage: "encoding",
        message: p.message,
      });
    });

    if (isCancelled()) {
      // Cleanup frames before throwing
      await cleanupFrames(frames.length);
      throw new Error("Export cancelled");
    }

    // Phase 4: Encode video
    let resultBlob: Blob;

    const encodeProgressCallback: EncodeProgressCallback = (p) => {
      emitProgress({
        frame: totalFrames,
        totalFrames,
        percent: 0.6 + p.percent * 0.0035, // 60-95% for encoding
        stage: "encoding",
        message: p.message,
      });
    };

    if (format === "gif") {
      resultBlob = await encodeGif(
        {
          width,
          height,
          fps: Math.min(fps, defaultGifConfig.maxFps),
          framePattern,
          maxWidth: advanced?.gifMaxWidth ?? defaultGifConfig.maxWidth,
          dither: advanced?.gifDither ?? defaultGifConfig.dither,
        },
        encodeProgressCallback,
      );
    } else {
      resultBlob = await encodeVideo(
        {
          format,
          width,
          height,
          fps,
          quality,
          crf: advanced?.crf,
          bitrate: advanced?.bitrate,
          audioBlob,
          framePattern,
        },
        encodeProgressCallback,
      );
    }

    // Phase 5: Cleanup
    emitProgress({
      frame: totalFrames,
      totalFrames,
      percent: 0.95,
      stage: "encoding",
      message: "Cleaning up...",
    });

    await cleanupFrames(frames.length);

    // Done!
    emitProgress({
      frame: totalFrames,
      totalFrames,
      percent: 1,
      stage: "done",
      message: "Export complete",
    });

    return resultBlob;
  } finally {
    // Restore video state (only if we have a video element)
    if (video) {
      video.currentTime = originalTime;
      if (wasPlaying) {
        await video.play();
      }
    }
  }
}
