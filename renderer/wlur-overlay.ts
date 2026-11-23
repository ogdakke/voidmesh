import {
  DEFAULT_WLUR_PARAMS,
  WLUR_CURVES,
  clampWlurParams,
  clampWlurQuality,
  type WlurParams,
  type WlurQuality,
  type WlurTintColor,
} from "#wlur";

export interface WlurOverlayLayout {
  /**
   * Optional app-level tint color for the overlay.
   *
   * Each channel is expected in `[0, 1]`.
   */
  tintColor?: WlurTintColor;
  /**
   * Optional app-level tint amount.
   *
   * Expected range: `0..1` for normal use.
   */
  tintAmount?: number;
  /**
   * Screen edge occupied by the mobile controls. The overlay blurs toward it.
   *
   * @default "bottom"
   */
  edge?: "bottom" | "right";
}

/** Phone landscape: controls form a right-side rail roughly the last quarter of the width. */
const RIGHT_EDGE_OVERLAY_PARAMS = Object.freeze({
  direction: "right",
  offset: 0.6,
} satisfies Partial<WlurParams>);

export interface WlurOverlayConfig {
  /** Enables or disables the overlay. */
  enabled?: boolean;
  /** Reuse the previous wlur output when content and params have not changed. */
  cache?: boolean;
  /** Direct wlur parameter overrides layered on top of the app preset. */
  params?: Partial<WlurParams>;
  /** Direct wlur quality overrides layered on top of the app preset. */
  quality?: Partial<WlurQuality>;
  /** App/layout context used to derive the preset. */
  layout?: WlurOverlayLayout;
}

export interface ResolvedWlurOverlayConfig {
  cache: boolean;
  params: WlurParams;
  quality: WlurQuality;
}

export const DEFAULT_WLUR_OVERLAY_PARAMS = Object.freeze({
  ...DEFAULT_WLUR_PARAMS,
  offset: 0.58,
  interpolation: 0.65,
  direction: "down",
  radius: 160,
  noise: 0.45,
  // Kawase mode only (debug toggle for now); see WlurQuality.algorithm.
  levels: 5,
  spread: 1,
  curve: WLUR_CURVES.easeIn,
  mixCurve: WLUR_CURVES.easeIn,
  tint: {
    curve: WLUR_CURVES.easeInOut,
    amount: 0.77,
    color: [0, 0, 0],
  },
} satisfies WlurParams);

export const DEFAULT_WLUR_OVERLAY_QUALITY = Object.freeze({
  kernelSize: 101,
  resolutionScale: 0.54,
  algorithm: "gaussian",
} satisfies WlurQuality);

export function createDefaultWlurOverlayConfig(layout: WlurOverlayLayout = {}): WlurOverlayConfig {
  const tint =
    layout.tintColor != null
      ? {
          color: layout.tintColor,
          amount: layout.tintAmount ?? 1,
          curve: WLUR_CURVES.easeInOut,
        }
      : undefined;

  return {
    enabled: true,
    cache: true,
    layout,
    params: {
      ...DEFAULT_WLUR_OVERLAY_PARAMS,
      ...(layout.edge === "right" ? RIGHT_EDGE_OVERLAY_PARAMS : null),
      tint,
    },
    quality: DEFAULT_WLUR_OVERLAY_QUALITY,
  };
}

/** The overlay the mobile layout renders behind its controls. */
export function createMobileWlurOverlayConfig({
  darkTheme,
  edge,
}: {
  darkTheme: boolean;
  edge: NonNullable<WlurOverlayLayout["edge"]>;
}): WlurOverlayConfig {
  return createDefaultWlurOverlayConfig({
    // Mirrors `--studio-background` (styles/variables.css): the canvas is transparent over it,
    // and iOS Safari tints its toolbar from it, so the blur must fade to the same colour.
    tintColor: darkTheme ? [6 / 255, 6 / 255, 8 / 255] : [250 / 255, 250 / 255, 250 / 255],
    tintAmount: darkTheme ? 1.5 : 1.41,
    edge,
  });
}

export function resolveWlurOverlayRuntimeConfig(
  config: WlurOverlayConfig | null,
  canvasHeightPx: number,
  devicePixelRatio: number,
): ResolvedWlurOverlayConfig | null {
  if (!config || config.enabled === false) {
    return null;
  }

  if (Math.max(1, canvasHeightPx) <= 1 || Math.max(devicePixelRatio, 1) <= 0) {
    return null;
  }

  const preset = createDefaultWlurOverlayConfig(config.layout);
  const presetParams = preset.params ?? DEFAULT_WLUR_OVERLAY_PARAMS;
  const presetQuality = preset.quality ?? DEFAULT_WLUR_OVERLAY_QUALITY;

  const mergedTint =
    config.params?.tint === undefined
      ? presetParams.tint
      : {
          ...presetParams.tint,
          ...config.params.tint,
        };

  return {
    cache: config.cache !== false,
    params: clampWlurParams({
      ...presetParams,
      ...config.params,
      tint: mergedTint,
    }),
    quality: clampWlurQuality({
      ...presetQuality,
      ...config.quality,
    }),
  };
}
