import type { RGBA } from "#types/canvas.ts";

/**
 * Convert hex color string to normalized RGBA array [0-1]
 * Supports both 6-digit (RRGGBB) and 8-digit (RRGGBBAA) hex strings
 */
export function hexToNormalizedRGBA(hex: string): [number, number, number, number] {
  // Remove # if present
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = Number.parseInt(h.slice(0, 2), 16) / 255;
  const g = Number.parseInt(h.slice(2, 4), 16) / 255;
  const b = Number.parseInt(h.slice(4, 6), 16) / 255;
  // Parse alpha from last 2 chars if present, otherwise default to full opacity
  const a = h.length >= 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}

// Helper functions for color conversion
export function rgbaToHex(rgba: [number, number, number, number]): string {
  const toHex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, "0");
  return `${toHex(rgba[0])}${toHex(rgba[1])}${toHex(rgba[2])}${toHex(rgba[3])}`;
}

export function hexToRgba(hex: string): [number, number, number, number] {
  // Remove # if present
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}

/**
 * Helper to convert hex color to RGBA (normalized 0-1)
 */
export function hex(color: string): RGBA {
  const hex = color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return [r, g, b, 1];
}

/**
 * Calculate luminance using ITU-R BT.601 formula.
 * This matches the luminance calculation used in WGSL shaders.
 * @param r Red channel (0-1)
 * @param g Green channel (0-1)
 * @param b Blue channel (0-1)
 * @returns Luminance value (0-1)
 */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Sort palette colors by luminance (dark to light).
 * This ensures consistent shader behavior regardless of input order.
 * Uses ITU-R BT.601 luminance formula matching the WGSL shaders.
 * @param colors Array of RGBA colors (normalized 0-1)
 * @returns New array sorted by luminance (darkest first)
 */
export function sortPaletteByLuminance<T extends readonly [number, number, number, number]>(
  colors: readonly T[],
): T[] {
  return [...colors].sort((a, b) => {
    const lumA = luminance(a[0], a[1], a[2]);
    const lumB = luminance(b[0], b[1], b[2]);
    return lumA - lumB;
  });
}
