/**
 * GIF Decoder - Decodes animated GIFs using the browser's ImageDecoder API
 */

import type { GifFrame } from "#types/canvas.ts";
import { logger } from "./client.logger.ts";

export interface GifDecodeResult {
  frames: GifFrame[];
  width: number;
  height: number;
  /** Total duration in seconds */
  duration: number;
  /** Average frames per second */
  fps: number;
}

/** Memory warning threshold: warn if decoded frames exceed this size in bytes */
const MEMORY_WARNING_BYTES = 512 * 1024 * 1024; // 512MB

/**
 * Check if a file is an animated GIF (has more than 1 frame).
 * Uses ImageDecoder to inspect frame count without fully decoding.
 */
export async function isAnimatedGif(file: File): Promise<boolean> {
  if (file.type !== "image/gif") return false;

  // ImageDecoder API check
  if (typeof ImageDecoder === "undefined") return false;

  let decoder: ImageDecoder | null = null;
  try {
    decoder = new ImageDecoder({
      data: file.stream(),
      type: "image/gif",
    });

    // Wait for full stream to be parsed so frameCount is accurate
    await decoder.completed;
    const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
    return frameCount > 1;
  } catch {
    return false;
  } finally {
    decoder?.close();
  }
}

/**
 * Decode all frames from an animated GIF file.
 * Returns frames with pre-computed cumulative timestamps for efficient lookup.
 */
export async function decodeGif(source: Blob): Promise<GifDecodeResult> {
  if (typeof ImageDecoder === "undefined") {
    throw new Error("ImageDecoder API not supported");
  }

  const decoder = new ImageDecoder({
    data: source.stream(),
    type: "image/gif",
  });

  // Wait for the full stream to be parsed so frameCount is accurate
  await decoder.completed;

  const track = decoder.tracks.selectedTrack;
  if (!track) {
    decoder.close();
    throw new Error("No image track found in GIF");
  }

  const frameCount = track.frameCount;
  if (frameCount === 0) {
    decoder.close();
    throw new Error("GIF has no frames");
  }

  const frames: GifFrame[] = [];
  let cumulativeTimestamp = 0;

  for (let i = 0; i < frameCount; i++) {
    const result = await decoder.decode({ frameIndex: i });
    const videoFrame = result.image;

    // Read duration BEFORE closing the frame
    const durationUs = videoFrame.duration ?? 100_000; // default 100ms if missing
    const delayMs = durationUs / 1000;

    // Create ImageBitmap from the VideoFrame (handles disposal methods correctly)
    const bitmap = await createImageBitmap(videoFrame);
    videoFrame.close();

    frames.push({
      bitmap,
      delay: delayMs,
      timestamp: cumulativeTimestamp,
    });

    cumulativeTimestamp += delayMs;

    // Warn about memory after first frame
    if (i === 0 && frameCount > 1) {
      const estimatedBytes = bitmap.width * bitmap.height * 4 * frameCount;
      if (estimatedBytes > MEMORY_WARNING_BYTES) {
        const estimatedMB = Math.round(estimatedBytes / (1024 * 1024));
        logger.warn(
          `Large GIF: ${frameCount} frames at ${bitmap.width}x${bitmap.height} ≈ ${estimatedMB}MB decoded`,
        );
      }
    }
  }

  decoder.close();

  const totalDurationMs = cumulativeTimestamp;
  const duration = totalDurationMs / 1000;
  const fps = totalDurationMs > 0 ? (frameCount / totalDurationMs) * 1000 : 10;

  return {
    frames,
    width: frames[0]!.bitmap.width,
    height: frames[0]!.bitmap.height,
    duration,
    fps,
  };
}

/**
 * Get the GIF frame at a given time using binary search on cumulative timestamps.
 *
 * @param frames - Array of GIF frames with pre-computed cumulative timestamps
 * @param timeSeconds - Target time in seconds
 * @param loop - Whether to loop (wraps time modulo duration)
 * @returns The frame to display at the given time
 */
export function getFrameAtTime(frames: GifFrame[], timeSeconds: number, loop: boolean): GifFrame {
  if (frames.length === 0) {
    throw new Error("No frames available");
  }

  if (frames.length === 1) {
    return frames[0]!;
  }

  const lastFrame = frames[frames.length - 1]!;
  const totalDurationMs = lastFrame.timestamp + lastFrame.delay;

  let timeMs = timeSeconds * 1000;

  if (loop && totalDurationMs > 0) {
    timeMs = timeMs % totalDurationMs;
  } else if (timeMs >= totalDurationMs) {
    return lastFrame;
  }

  if (timeMs < 0) {
    return frames[0]!;
  }

  // Binary search for the frame whose timestamp range includes timeMs
  let low = 0;
  let high = frames.length - 1;

  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (frames[mid]!.timestamp <= timeMs) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return frames[low]!;
}
