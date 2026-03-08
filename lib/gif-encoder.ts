/**
 * GIF Encoding utility — encodes GifFrame[] into a GIF Blob via a Web Worker.
 *
 * All heavy work (palette quantization, applyPalette, LZW compression) runs
 * off the main thread. Input bitmaps are cloned before transfer so callers
 * retain ownership of the originals.
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
  // Clone bitmaps so originals stay valid for entity creation
  const clonedBitmaps = await Promise.all(frames.map((f) => createImageBitmap(f.bitmap)));
  const delays = frames.map((f) => f.delay);

  const worker = new Worker(new URL("./gif-encoder-worker.ts", import.meta.url), {
    type: "module",
  });

  return new Promise<Blob>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "progress") {
        onProgress?.(e.data.frame, e.data.total);
      } else if (e.data.type === "done") {
        resolve(new Blob([e.data.bytes], { type: "image/gif" }));
        worker.terminate();
      }
    };

    worker.onerror = (err) => {
      reject(new Error(`GIF encoding failed: ${err.message}`));
      worker.terminate();
    };

    // Transfer cloned bitmaps to the worker (zero-copy)
    worker.postMessage({ bitmaps: clonedBitmaps, delays, width, height }, clonedBitmaps);
  });
}
