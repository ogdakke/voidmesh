export type WlurDirection = "down" | "up" | "right" | "left";

/**
 * CSS-compatible cubic-bezier control points.
 *
 * This matches the common `cubic-bezier(x1, y1, x2, y2)` shape used by CSS easing tools.
 * `x1` and `x2` are normalized to `[0, 1]` during resolution.
 */
export type WlurCurve = readonly [number, number, number, number];

/**
 * Curve input accepted by wlur config.
 *
 * Use raw CSS-compatible control points like `[0.55, 0, 1, 0.45]`.
 */
export type WlurCurveInput = WlurCurve;

/**
 * RGB tint color in normalized linear-ish float space.
 *
 * Each channel is expected in the range `[0, 1]`.
 */
export type WlurTintColor = readonly [number, number, number];

export interface WlurTint {
  /**
   * Tint color applied to the blurred portion of the image.
   *
   * Each channel is clamped to `[0, 1]`.
   */
  color: WlurTintColor;
  /**
   * Tint strength.
   *
   * Expected range: `0..1` for normal use.
   * Values above `1` are allowed and produce a stronger push toward `color`.
   * Values below `0` are clamped to `0`.
   */
  amount: number;
  /**
   * Optional curve override for tint intensity.
   *
   * Uses the same CSS-compatible cubic-bezier format as `WlurParams.curve`.
   * When omitted, tint follows the main wlur curve.
   */
  curve?: WlurCurveInput;
}

export interface WlurParams {
  /**
   * Maximum blur radius once the effect has fully ramped in.
   *
   * Expected range: `0..64` for typical use.
   * Values below `0` are clamped to `0`.
   */
  radius: number;
  /**
   * CSS-compatible cubic-bezier curve applied to the base wlur falloff.
   *
   * Accepts `[x1, y1, x2, y2]`.
   * Defaults to linear when omitted.
   */
  curve?: WlurCurveInput;
  /**
   * Optional CSS-compatible cubic-bezier curve for the final composite mix.
   *
   * This controls how quickly the blurred result replaces the original image.
   * When omitted, wlur reuses `curve`.
   */
  mixCurve?: WlurCurveInput;
  /**
   * Normalized point where the directional blur starts.
   *
   * Range: `[0, 1]`.
   * `0` means "start immediately at the origin edge".
   * `1` means "start at the far edge".
   */
  offset: number;
  /**
   * Normalized ramp distance from zero blur to full blur.
   *
   * Range: `[0, 1]`.
   * `0` gives a hard edge.
   * Higher values create a softer falloff.
   */
  interpolation: number;
  /** Direction the blur grows from. */
  direction: WlurDirection;
  /**
   * Post-blur noise strength.
   *
   * Expected range: `0..1` for normal use.
   * Values below `0` are clamped to `0`.
   */
  noise: number;
  /**
   * Optional tint applied to the blurred region.
   *
   * The tint follows the same directional falloff as the blur.
   */
  tint?: WlurTint;
}

export interface WlurQuality {
  /**
   * Gaussian kernel size used by the blur passes.
   *
   * Valid runtime range: odd integers in `[3, 127]`.
   * Even values are rounded up to the next odd value.
   */
  kernelSize: number;
  /**
   * Internal render scale used for the working blur textures.
   *
   * Valid runtime range: `[0.1, 1]`.
   * Lower values are cheaper and softer; `1` keeps full resolution.
   */
  resolutionScale: number;
}

export interface WlurPassConfig {
  /** Optional quality overrides applied to an existing pass. */
  quality?: Partial<WlurQuality>;
}

export interface WlurWorkingDimensions {
  /** Scaled working width in pixels. Always at least `1`. */
  width: number;
  /** Scaled working height in pixels. Always at least `1`. */
  height: number;
  /** Effective scale after rounding to integer pixel dimensions. */
  scale: number;
}

/** Minimum allowed odd kernel size. */
export const MIN_WLUR_KERNEL_SIZE = 3;
/** Maximum allowed odd kernel size. */
export const MAX_WLUR_KERNEL_SIZE = 127;
/** Number of pre-sampled curve points uploaded to the GPU. */
export const WLUR_CURVE_LUT_SIZE = 64;

export const DEFAULT_WLUR_CURVE = Object.freeze([0, 0, 1, 1] as const) satisfies WlurCurve;

/**
 * Common CSS-compatible curve presets for wlur ramps.
 *
 * The first five mirror the familiar CSS timing functions.
 * The overlay presets are tuned for bottom-edge blur/tint overlays:
 * `overlayQuickFade` concentrates strength nearer the edge,
 * `overlayEdgeHold` lets the strong region linger longer before fading,
 * and `overlaySoftMix` keeps the top edge gentler when compositing back over
 * the original image.
 */
export const WLUR_CURVES = Object.freeze({
  linear: DEFAULT_WLUR_CURVE,
  ease: [0.25, 0.1, 0.25, 1] as const,
  easeIn: [0.42, 0, 1, 1] as const,
  easeOut: [0, 0, 0.58, 1] as const,
  easeInOut: [0.42, 0, 0.58, 1] as const,
  overlayQuickFade: [0.55, 0, 1, 0.45] as const,
  overlayEdgeHold: [0.28, 0.78, 0.5, 1] as const,
  overlaySoftMix: [0.55, 0, 0.7, 0.32] as const,
}) satisfies Record<string, WlurCurve>;

export const DEFAULT_WLUR_PARAMS = Object.freeze({
  radius: 8,
  offset: 0.3,
  interpolation: 0.4,
  direction: "down",
  noise: 0.1,
  curve: DEFAULT_WLUR_CURVE,
} satisfies WlurParams);

export const DEFAULT_WLUR_QUALITY = Object.freeze({
  kernelSize: 63,
  resolutionScale: 1,
} satisfies WlurQuality);
