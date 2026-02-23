/**
 * Palette extraction from images.
 *
 * @example
 * ```ts
 * import { extractPaletteFromImage } from "./lib/palette-extraction";
 *
 * const palette = await extractPaletteFromImage(file, {
 *   colorCount: 16,  // number of colors to extract
 *   sampleSize: 100, // downsample to 100x100 max
 *   iterations: 10,  // k-means iterations
 * });
 * ```
 */

export { extractPaletteFromImage, type PaletteExtractionOptions } from "./extract-palette.ts";
