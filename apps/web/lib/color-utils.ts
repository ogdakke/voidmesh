import type { RGBA } from "#types/canvas.ts";
import { ColorSpace } from "#types/enums.ts";

// ── OKLCH types & constants ──────────────────────────────────────────

export interface OklchColor {
  l: number; // 0-1
  c: number; // 0-0.37
  h: number; // 0-360
  a: number; // 0-1
}

/** Maximum OKLCH chroma value for the color picker UI and gamut search bounds */
export const MAX_CHROMA = 0.37;

// ── Shared patterns ─────────────────────────────────────────────────

/** Matches hex digits of valid CSS hex color lengths: 3, 4, 6, or 8 */
const VALID_HEX_RE = /^[0-9a-fA-F]{3}([0-9a-fA-F]([0-9a-fA-F]{2}([0-9a-fA-F]{2})?)?)?$/;

const P3_RE =
  /^color\(display-p3\s+([\d.]+%?|none)\s+([\d.]+%?|none)\s+([\d.]+%?|none)(?:\s*\/\s*([\d.]+%?|none))?\)$/;

/** Check if a CSS string is a valid color we can parse (hex or display-p3) */
export function isValidColorCss(css: string): boolean {
  const trimmed = css.trim();
  if (P3_RE.test(trimmed)) return true;
  const hexStr = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return VALID_HEX_RE.test(hexStr);
}

// ── Color space matrices ─────────────────────────────────────────────
// OKLab ↔ LMS (Björn Ottosson's OKLab)

function oklabToLms(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  return [l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_];
}

function lmsToOklab(l: number, m: number, s: number): [number, number, number] {
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

// Linear Display-P3 ↔ LMS
function linearP3ToLms(r: number, g: number, b: number): [number, number, number] {
  return [
    0.4813967555 * r + 0.4621183568 * g + 0.0564848877 * b,
    0.2288339282 * r + 0.6532601864 * g + 0.1179058854 * b,
    0.0839251973 * r + 0.2241423464 * g + 0.6919324563 * b,
  ];
}

function lmsToLinearP3(l: number, m: number, s: number): [number, number, number] {
  return [
    3.1277455454 * l - 2.2571357909 * m + 0.1293902455 * s,
    -1.0910086139 * l + 2.0133420547 * m + 0.0776665591 * s,
    -0.0260256887 * l - 0.3541460076 * m + 1.3801716964 * s,
  ];
}

// Linear sRGB ↔ LMS (for hex input parsing)
function linearSrgbToLms(r: number, g: number, b: number): [number, number, number] {
  return [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ];
}

function lmsToLinearSrgb(l: number, m: number, s: number): [number, number, number] {
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// ── Transfer functions ───────────────────────────────────────────────

function gammaToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToGamma(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

// ── OKLCH ↔ OKLab ────────────────────────────────────────────────────

function oklchToOklab(l: number, c: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  return [l, c * Math.cos(hRad), c * Math.sin(hRad)];
}

function oklabToOklch(L: number, a: number, b: number): [number, number, number] {
  const c = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, c, h];
}

// ── Gamut clamping (binary search on chroma) ─────────────────────────

function isInP3Gamut(r: number, g: number, b: number): boolean {
  return r >= -0.001 && r <= 1.001 && g >= -0.001 && g <= 1.001 && b >= -0.001 && b <= 1.001;
}

function clampChromaToP3(l: number, c: number, h: number): number {
  const [L, a, b] = oklchToOklab(l, c, h);
  const [r, g, bv] = lmsToLinearP3(...oklabToLms(L, a, b));
  if (isInP3Gamut(r, g, bv)) return c;

  let lo = 0;
  let hi = c;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    const [mL, mA, mB] = oklchToOklab(l, mid, h);
    const [mr, mg, mb] = lmsToLinearP3(...oklabToLms(mL, mA, mB));
    if (isInP3Gamut(mr, mg, mb)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// ── Public API ────────────────────────────────────────────────────────

/** OKLCH → gamut-clamped Display-P3 RGB (gamma-encoded, 0-1) */
export function oklchToP3Rgb(l: number, c: number, h: number): [number, number, number] {
  const clamped = clampChromaToP3(l, c, h);
  const [L, a, b] = oklchToOklab(l, clamped, h);
  const [lr, lg, lb] = lmsToLinearP3(...oklabToLms(L, a, b));
  return [
    linearToGamma(Math.max(0, Math.min(1, lr))),
    linearToGamma(Math.max(0, Math.min(1, lg))),
    linearToGamma(Math.max(0, Math.min(1, lb))),
  ];
}

/** Display-P3 RGB (gamma-encoded, 0-1) → OKLCH */
export function p3RgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const [L, a, bv] = lmsToOklab(
    ...linearP3ToLms(gammaToLinear(r), gammaToLinear(g), gammaToLinear(b)),
  );
  return oklabToOklch(L, a, bv);
}

/** sRGB hex (gamma-encoded) → OKLCH */
function srgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const [L, a, bv] = lmsToOklab(
    ...linearSrgbToLms(gammaToLinear(r), gammaToLinear(g), gammaToLinear(b)),
  );
  return oklabToOklch(L, a, bv);
}

/** Parse any supported CSS color string → OklchColor */
export function cssToOklch(css: string): OklchColor {
  const trimmed = css.trim();
  // display-p3
  const p3Match = trimmed.match(P3_RE);
  if (p3Match) {
    const r = parseChannel(p3Match[1]!);
    const g = parseChannel(p3Match[2]!);
    const b = parseChannel(p3Match[3]!);
    const a = p3Match[4] ? parseChannel(p3Match[4]) : 1;
    const [l, c, h] = p3RgbToOklch(r, g, b);
    return { l, c, h, a };
  }
  // hex — valid lengths: 3 (#RGB), 4 (#RGBA), 6 (#RRGGBB), 8 (#RRGGBBAA)
  const hexStr = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (VALID_HEX_RE.test(hexStr)) {
    const expanded =
      hexStr.length <= 4
        ? `${hexStr[0]}${hexStr[0]}${hexStr[1]}${hexStr[1]}${hexStr[2]}${hexStr[2]}${hexStr.length === 4 ? `${hexStr[3]}${hexStr[3]}` : ""}`
        : hexStr;
    const rv = parseInt(expanded.slice(0, 2), 16) / 255;
    const gv = parseInt(expanded.slice(2, 4), 16) / 255;
    const bv = parseInt(expanded.slice(4, 6), 16) / 255;
    const av = expanded.length >= 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1;
    const [l, c, h] = srgbToOklch(rv, gv, bv);
    return { l, c, h, a: av };
  }
  return { l: 0, c: 0, h: 0, a: 1 };
}

/** OklchColor → CSS `color(display-p3 ...)` string */
export function oklchToP3Css(oklch: OklchColor): string {
  const [r, g, b] = oklchToP3Rgb(oklch.l, oklch.c, oklch.h);
  const rf = r.toFixed(4);
  const gf = g.toFixed(4);
  const bf = b.toFixed(4);
  if (oklch.a >= 1) return `color(display-p3 ${rf} ${gf} ${bf})`;
  return `color(display-p3 ${rf} ${gf} ${bf} / ${oklch.a.toFixed(4)})`;
}

function isInSrgbGamut(r: number, g: number, b: number): boolean {
  return r >= -0.001 && r <= 1.001 && g >= -0.001 && g <= 1.001 && b >= -0.001 && b <= 1.001;
}

/** OKLCH → sRGB-clamped RGB (for canvas fallback on non-P3 displays) */
export function oklchToSrgbRgb(l: number, c: number, h: number): [number, number, number] {
  // Clamp to sRGB gamut
  let lo = 0;
  let hi = c;
  const [L0, a0, b0] = oklchToOklab(l, c, h);
  const [sr0, sg0, sb0] = lmsToLinearSrgb(...oklabToLms(L0, a0, b0));
  if (!isInSrgbGamut(sr0, sg0, sb0)) {
    // clamp chroma for sRGB
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      const [mL, mA, mB] = oklchToOklab(l, mid, h);
      const [mr, mg, mb] = lmsToLinearSrgb(...oklabToLms(mL, mA, mB));
      if (isInSrgbGamut(mr, mg, mb)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const [cL, cA, cB] = oklchToOklab(l, lo, h);
    const [cr, cg, cb] = lmsToLinearSrgb(...oklabToLms(cL, cA, cB));
    return [
      linearToGamma(Math.max(0, Math.min(1, cr))),
      linearToGamma(Math.max(0, Math.min(1, cg))),
      linearToGamma(Math.max(0, Math.min(1, cb))),
    ];
  }
  return [
    linearToGamma(Math.max(0, Math.min(1, sr0))),
    linearToGamma(Math.max(0, Math.min(1, sg0))),
    linearToGamma(Math.max(0, Math.min(1, sb0))),
  ];
}

/** OKLCH → sRGB CSS hex string */
export function oklchToSrgbCss(oklch: OklchColor): string {
  const [r, g, b] = oklchToSrgbRgb(oklch.l, oklch.c, oklch.h);
  const toHex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, "0");
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  if (oklch.a < 1) return `${hex}${toHex(oklch.a)}`;
  return hex;
}

/** OKLCH → CSS color string for the given color space */
export function oklchToCss(oklch: OklchColor, colorSpace: ColorSpace): string {
  if (colorSpace === ColorSpace.displayP3) return oklchToP3Css(oklch);
  return oklchToSrgbCss(oklch);
}

/** RGBA [0-1] → CSS color string for the given color space */
export function rgbaToCss(rgba: RGBA, colorSpace: ColorSpace): string {
  if (colorSpace === ColorSpace.displayP3) return rgbaToP3Css(rgba);
  const toHex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, "0");
  const [r, g, b, a] = rgba;
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  if (a < 1) return `${hex}${toHex(a)}`;
  return hex;
}

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

/** Parse a CSS channel value: `none` → 0, `50%` → 0.5, `0.5` → 0.5 */
function parseChannel(raw: string): number {
  if (raw === "none") return 0;
  if (raw.endsWith("%")) return parseFloat(raw) / 100;
  return parseFloat(raw);
}

/**
 * Parse a CSS color string to normalized RGBA.
 * Supports color(display-p3 ...), HSL, and hex values.
 */
export function cssColorToRGBA(cssString: string): [number, number, number, number] {
  const trimmed = cssString.trim();
  const p3Match = trimmed.match(
    /color\(display-p3\s+([\d.]+%?|none)\s+([\d.]+%?|none)\s+([\d.]+%?|none)(?:\s*\/\s*([\d.]+%?|none))?\)/,
  );
  if (p3Match) {
    return [
      parseChannel(p3Match[1]!),
      parseChannel(p3Match[2]!),
      parseChannel(p3Match[3]!),
      p3Match[4] ? parseChannel(p3Match[4]) : 1,
    ];
  }
  const hslMatch = trimmed.match(
    /hsl\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*\/\s*|\s*,\s*)?([\d.]+%?)?\s*\)/,
  );
  if (hslMatch) {
    const hue = (((Number.parseFloat(hslMatch[1]!) % 360) + 360) % 360) / 360;
    const saturation = Number.parseFloat(hslMatch[2]!) / 100;
    const lightness = Number.parseFloat(hslMatch[3]!) / 100;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const channel = (offset: number) => {
      const segment = (offset + hue * 12) % 12;
      return lightness - (chroma / 2) * Math.max(-1, Math.min(segment - 3, 9 - segment, 1));
    };
    return [channel(0), channel(8), channel(4), hslMatch[4] ? parseChannel(hslMatch[4]) : 1];
  }
  return hexToNormalizedRGBA(trimmed);
}

/**
 * Parse a supported CSS color and convert it into normalized RGBA values
 * in the requested target color space.
 */
export function cssColorToRGBAInColorSpace(
  cssString: string,
  colorSpace: ColorSpace,
): [number, number, number, number] {
  const parsed = cssToOklch(cssString);
  const [r, g, b] =
    colorSpace === ColorSpace.displayP3
      ? oklchToP3Rgb(parsed.l, parsed.c, parsed.h)
      : oklchToSrgbRgb(parsed.l, parsed.c, parsed.h);
  return [r, g, b, parsed.a];
}

/**
 * Convert normalized RGBA to CSS color string in display-p3 space.
 * Outputs `color(display-p3 r g b)` or `color(display-p3 r g b / a)` when alpha < 1.
 */
export function rgbaToP3Css(rgba: RGBA): string {
  const [r, g, b, a] = rgba;
  if (a === 1) return `color(display-p3 ${r} ${g} ${b})`;
  return `color(display-p3 ${r} ${g} ${b} / ${a})`;
}

/**
 * Calculate luminance using color-space-appropriate coefficients.
 * Uses Display-P3 coefficients for P3, BT.709/sRGB otherwise.
 * Matches the luminance calculation used in WGSL shaders.
 */
export function luminance(r: number, g: number, b: number, colorSpace: ColorSpace): number {
  return colorSpace === ColorSpace.displayP3
    ? 0.229 * r + 0.6917 * g + 0.0793 * b
    : 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Sort palette colors by luminance (dark to light).
 * This ensures consistent shader behavior regardless of input order.
 * Uses color-space-appropriate luminance coefficients matching the WGSL shaders.
 */
export function sortPaletteByLuminance<T extends readonly [number, number, number, number]>(
  colors: readonly T[],
  colorSpace: ColorSpace,
): T[] {
  return [...colors].sort((a, b) => {
    const lumA = luminance(a[0], a[1], a[2], colorSpace);
    const lumB = luminance(b[0], b[1], b[2], colorSpace);
    return lumA - lumB;
  });
}
