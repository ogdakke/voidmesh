export type WlurDirection = "down" | "up" | "right" | "left";

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

export const DEFAULT_WLUR_PARAMS = Object.freeze({
  radius: 8,
  offset: 0.3,
  interpolation: 0.4,
  direction: "down",
  noise: 0.1,
} satisfies WlurParams);

export const DEFAULT_WLUR_QUALITY = Object.freeze({
  kernelSize: 63,
  resolutionScale: 1,
} satisfies WlurQuality);
