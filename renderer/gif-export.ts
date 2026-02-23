/**
 * GIF Export Pipeline - gifenc-based GIF encoding
 *
 * Pipeline:
 * 1. Palette generation: sample every Nth frame, concatenate RGBA, run gifenc.quantize()
 * 2. Per-frame encode: render → OffscreenCanvas downscale → Floyd-Steinberg dither → gifenc encode
 * 3. Return final GIF blob
 */

import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { floydSteinbergDither } from "#lib/floyd-steinberg.ts";
import { defaultGifConfig } from "./export-formats.ts";
import type { ExportProgress, AnimatedSource, VideoExportOptions } from "./video-exporter.ts";
import { logger } from "#lib/client.logger.ts";

/**
 * Export animated content as GIF using gifenc
 */
export async function exportGif(
  source: AnimatedSource,
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  options: VideoExportOptions,
  emitProgress: (progress: ExportProgress) => void,
  isCancelled: () => boolean,
): Promise<Blob> {
  const fps = Math.min(options.fps ?? 30, defaultGifConfig.maxFps);
  const maxWidth = options.advanced?.gifMaxWidth ?? defaultGifConfig.maxWidth;
  const maxColors = defaultGifConfig.maxColors;
  const useDither = (options.advanced?.gifDither ?? "floyd_steinberg") !== "none";
  const totalFrames = Math.ceil(source.duration * fps);

  // Calculate output dimensions (downscale if needed, maintaining aspect ratio)
  let outWidth = source.width;
  let outHeight = source.height;
  if (outWidth > maxWidth) {
    const scale = maxWidth / outWidth;
    outWidth = maxWidth;
    outHeight = Math.round(source.height * scale);
  }
  // Ensure even dimensions
  outWidth = Math.floor(outWidth / 2) * 2 || 2;
  outHeight = Math.floor(outHeight / 2) * 2 || 2;

  const video = source.videoElement;
  const wasPlaying = video ? !video.paused : false;
  const originalTime = video ? video.currentTime : 0;

  try {
    video?.pause();

    // Phase 1: Generate global palette by sampling frames
    emitProgress({
      frame: 0,
      totalFrames,
      percent: 0,
      stage: "encoding",
      message: "Generating color palette...",
    });

    const sampleInterval = Math.max(1, Math.floor(totalFrames / 20));
    const sampledPixels: Uint8ClampedArray[] = [];
    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    for (let i = 0; i < totalFrames; i += sampleInterval) {
      if (isCancelled()) throw new Error("Export cancelled");

      const timestampSeconds = i / fps;
      const bitmap = await renderFrame(timestampSeconds);
      ctx.drawImage(bitmap, 0, 0, outWidth, outHeight);
      bitmap.close();

      const imageData = ctx.getImageData(0, 0, outWidth, outHeight);
      sampledPixels.push(imageData.data);

      emitProgress({
        frame: i,
        totalFrames,
        percent: (i / totalFrames) * 0.15, // 0-15% for palette sampling
        stage: "encoding",
        message: "Sampling frames for palette...",
      });
    }

    // Concatenate sampled pixels and quantize
    const totalSamplePixels = sampledPixels.reduce((sum, p) => sum + p.length, 0);
    const allPixels = new Uint8Array(totalSamplePixels);
    let offset = 0;
    for (const pixels of sampledPixels) {
      allPixels.set(pixels, offset);
      offset += pixels.length;
    }

    const palette = quantize(allPixels, maxColors);

    logger.debug(`[gif-export] Generated palette with ${palette.length} colors`);

    // Phase 2: Encode each frame
    const gif = GIFEncoder();

    // Calculate frame delays in centiseconds
    // At 30fps, each frame is ~3.33cs. Alternate 3cs/4cs to maintain sync.
    const nominalDelayCentiseconds = 100 / fps;
    let accumulatedError = 0;

    for (let i = 0; i < totalFrames; i++) {
      if (isCancelled()) throw new Error("Export cancelled");

      const timestampSeconds = i / fps;
      const bitmap = await renderFrame(timestampSeconds);

      ctx.drawImage(bitmap, 0, 0, outWidth, outHeight);
      bitmap.close();

      const imageData = ctx.getImageData(0, 0, outWidth, outHeight);

      // Apply Floyd-Steinberg dithering
      if (useDither) {
        floydSteinbergDither(imageData.data, outWidth, outHeight, palette);
      }

      // Map pixels to palette indices
      const indexed = applyPalette(imageData.data, palette);

      // Calculate variable delay to avoid cumulative drift
      const idealDelay = nominalDelayCentiseconds + accumulatedError;
      const actualDelay = Math.round(idealDelay);
      accumulatedError = idealDelay - actualDelay;

      // Convert to milliseconds for gifenc (it converts to centiseconds internally)
      gif.writeFrame(indexed, outWidth, outHeight, {
        palette,
        delay: actualDelay * 10, // gifenc expects milliseconds
        repeat: 0, // Loop forever
      });

      emitProgress({
        frame: i + 1,
        totalFrames,
        percent: 0.15 + ((i + 1) / totalFrames) * 0.85, // 15-100%
        stage: "encoding",
        message: `Encoding frame ${i + 1}/${totalFrames}`,
      });

      // Yield to event loop periodically
      if (i % 5 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    gif.finish();

    emitProgress({
      frame: totalFrames,
      totalFrames,
      percent: 1,
      stage: "done",
      message: "GIF export complete",
    });

    return new Blob([gif.bytes()], { type: "image/gif" });
  } finally {
    if (video) {
      video.currentTime = originalTime;
      if (wasPlaying) {
        await video.play();
      }
    }
  }
}
