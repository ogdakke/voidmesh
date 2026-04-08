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
  /** Whether the overlay should use the mobile preset instead of the desktop preset. */
  isMobile?: boolean;
  /**
   * Occluded bottom UI height in CSS pixels.
   *
   * Expected range: `>= 0`.
   * Used to resolve wlur defaults against the visible viewport height.
   */
  bottomInsetCssPx?: number;
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
}

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

const MOBILE_OVERLAY_PARAMS = Object.freeze({
  ...DEFAULT_WLUR_PARAMS,
  offset: 0.64,
  interpolation: 0.4,
  direction: "down",
  radius: 80,
  noise: 0,
} satisfies WlurParams);

const DESKTOP_OVERLAY_PARAMS = Object.freeze({
  ...DEFAULT_WLUR_PARAMS,
  offset: 0.95,
  interpolation: 0.4,
  direction: "down",
  radius: 80,
} satisfies WlurParams);

export function createDefaultWlurOverlayConfig(layout: WlurOverlayLayout = {}): WlurOverlayConfig {
  const tint =
    layout.tintColor != null
      ? {
          color: layout.tintColor,
          amount: layout.tintAmount ?? 1,
          curve: WLUR_CURVES.ease,
        }
      : undefined;

  return {
    enabled: true,
    cache: true,
    layout,
    params: {
      tint,
      curve: WLUR_CURVES.overlayQuickFade,
      mixCurve: WLUR_CURVES.overlaySoftMix,
    },
    quality: {
      kernelSize: 25,
      resolutionScale: 0.5,
    },
  };
}

export function resolveWlurOverlayRuntimeConfig(
  config: WlurOverlayConfig | null,
  canvasHeightPx: number,
  devicePixelRatio: number,
): ResolvedWlurOverlayConfig | null {
  if (!config || config.enabled === false) {
    return null;
  }

  const layout = config.layout ?? {};
  const isMobile = layout.isMobile ?? false;
  const heightPx = Math.max(1, canvasHeightPx);
  const dpr = Math.max(devicePixelRatio, 1);
  const bottomInsetPx = Math.max((layout.bottomInsetCssPx ?? 0) * dpr, 0);
  const visibleHeightPx = heightPx - bottomInsetPx;

  if (visibleHeightPx <= 1) {
    return null;
  }

  const visibleFraction = Math.min(Math.max(visibleHeightPx / heightPx, 0), 1);
  const baseParams = isMobile ? MOBILE_OVERLAY_PARAMS : DESKTOP_OVERLAY_PARAMS;
  const scaledDefaults = clampWlurParams({
    ...baseParams,
    offset: baseParams.offset * visibleFraction,
    interpolation: baseParams.interpolation * visibleFraction,
  });

  return {
    cache: config.cache !== false,
    params: clampWlurParams({
      ...scaledDefaults,
      ...config.params,
    }),
    quality: clampWlurQuality(config.quality),
  };
}
