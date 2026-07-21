import { applyPalette, quantize } from "gifenc";
import { floydSteinbergDither } from "./floyd-steinberg.ts";

export type GifPalette = [number, number, number][];

export function buildGifPaletteFromPixels(
  pixelFrames: readonly Uint8ClampedArray[] | readonly Uint8ClampedArray<ArrayBuffer>[],
  maxColors: number,
): GifPalette {
  const byteLength = pixelFrames.reduce((sum, pixels) => sum + pixels.byteLength, 0);
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const pixels of pixelFrames) {
    combined.set(pixels, offset);
    offset += pixels.byteLength;
  }
  return quantize(combined, maxColors);
}

export function mapGifFrameToPalette(params: {
  pixels: Uint8ClampedArray | Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  palette: GifPalette;
  dither: boolean;
}): Uint8Array {
  const { pixels, width, height, palette, dither } = params;
  if (dither) floydSteinbergDither(pixels, width, height, palette);
  return applyPalette(pixels, palette);
}
