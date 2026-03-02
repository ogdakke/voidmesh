/**
 * Extract color palette from an image using k-means clustering.
 */

import type { ColorPalette, RGBA } from "#types/canvas.ts";
import { MAX_PALETTE_COLORS } from "#types/canvas.ts";
import { config } from "#config";
import { ColorSpace } from "#types/enums.ts";
import { kMeans, type RGB } from "./kmeans.ts";

export interface PaletteExtractionOptions {
  /** Number of colors to extract (default: 16, max: 16) */
  colorCount?: number;
  /** Sample size - image is downsampled to this max dimension (default: 100) */
  sampleSize?: number;
  /** K-means iterations (default: 10) */
  iterations?: number;
  /** Skip transparent pixels with alpha < threshold (default: true) */
  skipTransparent?: boolean;
  /** Alpha threshold for transparent pixel detection (default: 0.1) */
  alphaThreshold?: number;
  /** Color space for pixel sampling (default: srgb) */
  colorSpace?: ColorSpace;
}

const DEFAULT_OPTIONS: Required<PaletteExtractionOptions> = {
  colorCount: 16,
  sampleSize: 100,
  iterations: 10,
  skipTransparent: true,
  alphaThreshold: 0.1,
  colorSpace: ColorSpace.srgb,
};

/**
 * Load an image source to an HTMLImageElement.
 */
async function loadImage(
  source: File | HTMLImageElement | ImageBitmap,
): Promise<HTMLImageElement | ImageBitmap> {
  if (source instanceof HTMLImageElement) {
    // Wait for load if not complete
    if (!source.complete) {
      await new Promise<void>((resolve, reject) => {
        source.onload = () => resolve();
        source.onerror = () => reject(new Error("Failed to load image"));
      });
    }
    return source;
  }

  if (source instanceof ImageBitmap) {
    return source;
  }

  // File: create object URL and load
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(source);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image file"));
    };
    img.src = url;
  });
}

/**
 * Get pixel data from an image, downsampled to fit within sampleSize.
 */
function getPixelData(
  image: HTMLImageElement | ImageBitmap,
  sampleSize: number,
  colorSpace: ColorSpace,
): { data: Uint8ClampedArray; width: number; height: number } {
  const srcWidth = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const srcHeight = image instanceof HTMLImageElement ? image.naturalHeight : image.height;

  // Calculate target dimensions maintaining aspect ratio
  let targetWidth: number;
  let targetHeight: number;

  if (srcWidth <= sampleSize && srcHeight <= sampleSize) {
    // Image is smaller than sample size, use actual dimensions
    targetWidth = srcWidth;
    targetHeight = srcHeight;
  } else if (srcWidth > srcHeight) {
    targetWidth = sampleSize;
    targetHeight = Math.round((srcHeight / srcWidth) * sampleSize);
  } else {
    targetHeight = sampleSize;
    targetWidth = Math.round((srcWidth / srcHeight) * sampleSize);
  }

  // Ensure minimum dimensions
  targetWidth = Math.max(1, targetWidth);
  targetHeight = Math.max(1, targetHeight);

  // Create offscreen canvas and draw
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext("2d", {
    willReadFrequently: true,
    colorSpace: colorSpace,
  });
  if (!ctx) {
    throw new Error("Failed to get canvas 2D context");
  }

  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);

  return {
    data: imageData.data,
    width: targetWidth,
    height: targetHeight,
  };
}

/**
 * Convert RGB (0-255) to normalized RGBA (0-1).
 */
function rgbToRGBA(rgb: RGB): RGBA {
  return [rgb.r / 255, rgb.g / 255, rgb.b / 255, 1];
}

/**
 * Extract a color palette from an image.
 *
 * @param source - Image file, HTMLImageElement, or ImageBitmap
 * @param options - Extraction options
 * @returns ColorPalette with extracted colors
 *
 * @example
 * ```ts
 * const palette = await extractPaletteFromImage(file, { colorCount: 8 });
 * console.log(palette.colors); // Array of 8 RGBA colors
 * ```
 */
export async function extractPaletteFromImage(
  source: File | HTMLImageElement | ImageBitmap,
  options?: PaletteExtractionOptions,
): Promise<ColorPalette> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Clamp colorCount to valid range
  const colorCount = Math.min(Math.max(2, opts.colorCount), MAX_PALETTE_COLORS);

  // Load and sample image
  const image = await loadImage(source);
  const { data } = getPixelData(image, opts.sampleSize, opts.colorSpace);

  // Extract pixels as RGB, optionally skipping transparent ones
  const pixels: RGB[] = [];
  const alphaThreshold = opts.alphaThreshold * 255;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]!;

    // Skip transparent pixels if enabled
    if (opts.skipTransparent && alpha < alphaThreshold) {
      continue;
    }

    pixels.push({
      r: data[i]!,
      g: data[i + 1]!,
      b: data[i + 2]!,
    });
  }

  // Handle edge case: no valid pixels
  if (pixels.length === 0) {
    // Return a default grayscale palette
    const colors: RGBA[] = [];
    for (let i = 0; i < colorCount; i++) {
      const v = i / (colorCount - 1);
      colors.push([v, v, v, 1]);
    }
    return {
      id: config.customPaletteId,
      name: "Extracted",
      shortName: "Extracted",
      colors,
    };
  }

  // Run k-means clustering
  const centroids = kMeans(pixels, colorCount, opts.iterations);

  // Convert to normalized RGBA
  const colors: RGBA[] = centroids.map(rgbToRGBA);

  return {
    id: config.customPaletteId,
    name: "Extracted",
    shortName: "Extracted",
    colors,
  };
}
