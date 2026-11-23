import { WLUR_CURVES, type WlurCurve, type WlurTintColor } from "#wlur";
import {
  DEFAULT_WLUR_OVERLAY_PARAMS,
  DEFAULT_WLUR_OVERLAY_QUALITY,
  type WlurOverlayConfig,
} from "./wlur-overlay.ts";

export const WLUR_DEBUG_CURVE_OPTIONS = [
  { value: "linear", label: "Linear", shortLabel: "Lin" },
  { value: "ease", label: "Ease", shortLabel: "Ease" },
  { value: "easeIn", label: "Ease In", shortLabel: "In" },
  { value: "easeOut", label: "Ease Out", shortLabel: "Out" },
  { value: "easeInOut", label: "Ease In Out", shortLabel: "InOut" },
  { value: "overlayQuickFade", label: "Quick Fade", shortLabel: "QF" },
  { value: "overlayEdgeHold", label: "Edge Hold", shortLabel: "EH" },
  { value: "overlaySoftMix", label: "Soft Mix", shortLabel: "SM" },
] as const;

export type WlurDebugCurvePreset = (typeof WLUR_DEBUG_CURVE_OPTIONS)[number]["value"];

export interface WlurOverlayDebugConfig {
  enabled: boolean;
  cache: boolean;
  radius: number;
  offset: number;
  interpolation: number;
  noise: number;
  tintAmount: number;
  /** `#rrggbb` written straight into canvas colour values; `null` follows the theme. */
  tintColor: string | null;
  kernelSize: number;
  resolutionScale: number;
  blurCurve: WlurDebugCurvePreset;
  mixCurve: WlurDebugCurvePreset;
  tintCurve: WlurDebugCurvePreset;
}

export function createDefaultWlurOverlayDebugConfig(): WlurOverlayDebugConfig {
  return {
    enabled: true,
    cache: true,
    radius: DEFAULT_WLUR_OVERLAY_PARAMS.radius,
    offset: DEFAULT_WLUR_OVERLAY_PARAMS.offset,
    interpolation: DEFAULT_WLUR_OVERLAY_PARAMS.interpolation,
    noise: DEFAULT_WLUR_OVERLAY_PARAMS.noise,
    tintAmount: 0.77,
    tintColor: null,
    kernelSize: DEFAULT_WLUR_OVERLAY_QUALITY.kernelSize,
    resolutionScale: DEFAULT_WLUR_OVERLAY_QUALITY.resolutionScale,
    blurCurve: "overlayQuickFade",
    mixCurve: "overlaySoftMix",
    tintCurve: "easeIn",
  };
}

export const DEFAULT_WLUR_OVERLAY_DEBUG_CONFIG = Object.freeze(
  createDefaultWlurOverlayDebugConfig(),
);

export function getWlurDebugCurvePreset(
  preset: WlurDebugCurvePreset | string | undefined,
): WlurCurve {
  if (preset && preset in WLUR_CURVES) {
    return WLUR_CURVES[preset as keyof typeof WLUR_CURVES];
  }

  return WLUR_CURVES.linear;
}

function parseHexTintColor(hex: string): WlurTintColor | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return null;
  return [
    parseInt(match[1]!, 16) / 255,
    parseInt(match[2]!, 16) / 255,
    parseInt(match[3]!, 16) / 255,
  ];
}

export function applyWlurOverlayDebugConfig(
  baseConfig: WlurOverlayConfig,
  debugConfig: WlurOverlayDebugConfig,
  tintColor: WlurTintColor,
): WlurOverlayConfig {
  return {
    ...baseConfig,
    enabled: debugConfig.enabled,
    cache: debugConfig.cache,
    params: {
      ...baseConfig.params,
      radius: debugConfig.radius,
      offset: debugConfig.offset,
      interpolation: debugConfig.interpolation,
      noise: debugConfig.noise,
      curve: getWlurDebugCurvePreset(debugConfig.blurCurve),
      mixCurve: getWlurDebugCurvePreset(debugConfig.mixCurve),
      tint: {
        color: (debugConfig.tintColor && parseHexTintColor(debugConfig.tintColor)) || tintColor,
        amount: debugConfig.tintAmount,
        curve: getWlurDebugCurvePreset(debugConfig.tintCurve),
      },
    },
    quality: {
      ...baseConfig.quality,
      kernelSize: debugConfig.kernelSize,
      resolutionScale: debugConfig.resolutionScale,
    },
  };
}
