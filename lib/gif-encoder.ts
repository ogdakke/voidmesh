/**
 * GIF Encoding utility — encodes GifFrame[] into a GIF Blob using gifenc.
 *
 * Palette is quantized from downsampled (128×128) frames for efficiency.
 * Used by the upscale queue to re-encode upscaled GIF frames.
 */

import type { GifFrame } from "#types/canvas.ts";

/**
 * Encode an array of GifFrame bitmaps into a GIF Blob.
 *
 * @param frames - Array of GifFrames with bitmaps and delay values
 * @param width - Output GIF width
 * @param height - Output GIF height
 * @param onProgress - Optional progress callback (frame index, total)
 * @returns GIF Blob
 */
export async function encodeGifFromFrames(
  frames: GifFrame[],
  width: number,
  height: number,
  onProgress?: (frame: number, total: number) => void,
): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");

  // Sample frames at reduced resolution for palette generation (saves ~60× memory)
  const sampleSize = 128;
  const sampleCanvas = new OffscreenCanvas(sampleSize, sampleSize);
  const sampleCtx = sampleCanvas.getContext("2d")!;
  const sampleInterval = Math.max(1, Math.floor(frames.length / 20));
  const sampledPixels: Uint8ClampedArray[] = [];

  for (let i = 0; i < frames.length; i += sampleInterval) {
    sampleCtx.drawImage(frames[i]!.bitmap, 0, 0, sampleSize, sampleSize);
    sampledPixels.push(sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data);
  }

  const combined = new Uint8Array(sampledPixels.reduce((s, p) => s + p.length, 0));
  let offset = 0;
  for (const p of sampledPixels) {
    combined.set(p, offset);
    offset += p.length;
  }
  const palette = quantize(combined, 128);

  // Encode frames at full resolution
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  const gif = GIFEncoder();

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    ctx.drawImage(frame.bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const indexed = applyPalette(pixels, palette);
    gif.writeFrame(indexed, width, height, {
      palette,
      delay: Math.round(frame.delay),
    });
    onProgress?.(i + 1, frames.length);
  }

  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}
