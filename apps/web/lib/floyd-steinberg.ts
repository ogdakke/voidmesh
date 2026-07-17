/**
 * Floyd-Steinberg Error-Diffusion Dithering
 *
 * Applies Floyd-Steinberg dithering on RGBA pixel data against a given palette.
 * Distributes quantization error to neighboring pixels:
 *   [*] 7/16
 *   3/16 5/16 1/16
 */

/**
 * Apply Floyd-Steinberg dithering to RGBA pixel data in-place.
 * After dithering, each pixel's RGB channels are snapped to the nearest palette color.
 *
 * @param rgba - RGBA pixel data (modified in-place)
 * @param width - Image width
 * @param height - Image height
 * @param palette - Array of [r, g, b] palette colors
 */
export function floydSteinbergDither(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  palette: [number, number, number][],
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      const oldR = rgba[i]!;
      const oldG = rgba[i + 1]!;
      const oldB = rgba[i + 2]!;

      // Find nearest palette color
      const [newR, newG, newB] = nearestColor(oldR, oldG, oldB, palette);

      rgba[i] = newR;
      rgba[i + 1] = newG;
      rgba[i + 2] = newB;

      const errR = oldR - newR;
      const errG = oldG - newG;
      const errB = oldB - newB;

      // Distribute error to neighbors
      diffuse(rgba, width, height, x + 1, y, errR, errG, errB, 7 / 16);
      diffuse(rgba, width, height, x - 1, y + 1, errR, errG, errB, 3 / 16);
      diffuse(rgba, width, height, x, y + 1, errR, errG, errB, 5 / 16);
      diffuse(rgba, width, height, x + 1, y + 1, errR, errG, errB, 1 / 16);
    }
  }
}

function diffuse(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  errR: number,
  errG: number,
  errB: number,
  factor: number,
): void {
  if (x < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  rgba[i] = clamp(rgba[i]! + errR * factor);
  rgba[i + 1] = clamp(rgba[i + 1]! + errG * factor);
  rgba[i + 2] = clamp(rgba[i + 2]! + errB * factor);
}

function nearestColor(
  r: number,
  g: number,
  b: number,
  palette: [number, number, number][],
): [number, number, number] {
  let minDist = Infinity;
  let best = palette[0]!;
  for (const color of palette) {
    const dr = r - color[0];
    const dg = g - color[1];
    const db = b - color[2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < minDist) {
      minDist = dist;
      best = color;
    }
  }
  return best;
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
