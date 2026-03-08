/**
 * Web Worker for GIF encoding via gifenc.
 *
 * Receives transferred ImageBitmaps + frame delays, performs palette
 * quantization and LZW encoding entirely off the main thread.
 * Posts per-frame progress and the final GIF bytes (transferred).
 */

interface EncodeRequest {
  bitmaps: ImageBitmap[];
  delays: number[];
  width: number;
  height: number;
}

self.onmessage = async (e: MessageEvent<EncodeRequest>) => {
  const { bitmaps, delays, width, height } = e.data;
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");

  // Sample frames at reduced resolution for palette generation
  const sampleSize = 128;
  const sampleCanvas = new OffscreenCanvas(sampleSize, sampleSize);
  const sampleCtx = sampleCanvas.getContext("2d")!;
  const sampleInterval = Math.max(1, Math.floor(bitmaps.length / 20));
  const sampledPixels: Uint8ClampedArray[] = [];

  for (let i = 0; i < bitmaps.length; i += sampleInterval) {
    sampleCtx.drawImage(bitmaps[i]!, 0, 0, sampleSize, sampleSize);
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

  for (let i = 0; i < bitmaps.length; i++) {
    ctx.drawImage(bitmaps[i]!, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const indexed = applyPalette(pixels, palette);
    gif.writeFrame(indexed, width, height, {
      palette,
      delay: Math.round(delays[i]!),
    });
    bitmaps[i]!.close();
    self.postMessage({ type: "progress", frame: i + 1, total: bitmaps.length });
  }

  gif.finish();
  const bytes = gif.bytes();
  self.postMessage({ type: "done", bytes }, { transfer: [bytes.buffer] });
};
