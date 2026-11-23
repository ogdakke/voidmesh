import { WLUR_CURVES, type WlurAlgorithm, type WlurCurve, type WlurTintColor } from "#wlur";
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

export const WLUR_DEBUG_ALGORITHM_OPTIONS = [
  { value: "gaussian", label: "Gaussian", shortLabel: "Gauss" },
  { value: "kawase", label: "Dual Kawase", shortLabel: "Kawase" },
] as const satisfies readonly { value: WlurAlgorithm; label: string; shortLabel: string }[];

/** Every tunable overlay value, in the units the debug panel edits. */
export interface WlurOverlayDebugConfig {
  enabled: boolean;
  cache: boolean;
  radius: number;
  offset: number;
  interpolation: number;
  noise: number;
  tintAmount: number;
  /** `#rrggbb`, written straight into canvas colour values. */
  tintColor: string;
  kernelSize: number;
  resolutionScale: number;
  blurCurve: WlurDebugCurvePreset;
  mixCurve: WlurDebugCurvePreset;
  tintCurve: WlurDebugCurvePreset;
  algorithm: WlurAlgorithm;
  /** Kawase pyramid depth at full ramp. */
  levels: number;
  /** Kawase per-pass sample offset. */
  spread: number;
}

/** Debug edits layered over the live overlay config; absent keys follow production. */
export type WlurOverlayDebugOverrides = Partial<WlurOverlayDebugConfig>;

function getWlurDebugCurvePreset(preset: WlurDebugCurvePreset): WlurCurve {
  return WLUR_CURVES[preset];
}

function findWlurDebugCurvePreset(curve: WlurCurve): WlurDebugCurvePreset {
  const option = WLUR_DEBUG_CURVE_OPTIONS.find((entry) =>
    WLUR_CURVES[entry.value].every((value, index) => value === curve[index]),
  );
  if (!option) {
    throw new Error(`Wlur overlay curve [${curve.join(", ")}] has no debug preset`);
  }
  return option.value;
}

function tintColorToHex(color: WlurTintColor): string {
  return `#${color
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function hexToTintColor(hex: string): WlurTintColor {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) {
    throw new Error(`Invalid wlur tint color "${hex}"`);
  }
  return [
    parseInt(match[1]!, 16) / 255,
    parseInt(match[2]!, 16) / 255,
    parseInt(match[3]!, 16) / 255,
  ];
}

/** Reads the values the live overlay renders with, then applies debug overrides. */
export function resolveWlurOverlayDebugConfig(
  baseConfig: WlurOverlayConfig,
  overrides: WlurOverlayDebugOverrides,
): WlurOverlayDebugConfig {
  const params = { ...DEFAULT_WLUR_OVERLAY_PARAMS, ...baseConfig.params };
  const quality = { ...DEFAULT_WLUR_OVERLAY_QUALITY, ...baseConfig.quality };
  const curve = params.curve ?? WLUR_CURVES.linear;
  const mixCurve = params.mixCurve ?? curve;
  const tint = params.tint ?? DEFAULT_WLUR_OVERLAY_PARAMS.tint;

  return {
    enabled: baseConfig.enabled !== false,
    cache: baseConfig.cache !== false,
    radius: params.radius,
    offset: params.offset,
    interpolation: params.interpolation,
    noise: params.noise,
    tintAmount: tint.amount,
    tintColor: tintColorToHex(tint.color),
    kernelSize: quality.kernelSize,
    resolutionScale: quality.resolutionScale,
    blurCurve: findWlurDebugCurvePreset(curve),
    mixCurve: findWlurDebugCurvePreset(mixCurve),
    tintCurve: findWlurDebugCurvePreset(tint.curve ?? curve),
    algorithm: quality.algorithm,
    levels: params.levels,
    spread: params.spread,
    ...overrides,
  };
}

export function applyWlurOverlayDebugConfig(
  baseConfig: WlurOverlayConfig,
  overrides: WlurOverlayDebugOverrides,
): WlurOverlayConfig {
  const debugConfig = resolveWlurOverlayDebugConfig(baseConfig, overrides);
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
      levels: debugConfig.levels,
      spread: debugConfig.spread,
      tint: {
        color: hexToTintColor(debugConfig.tintColor),
        amount: debugConfig.tintAmount,
        curve: getWlurDebugCurvePreset(debugConfig.tintCurve),
      },
    },
    quality: {
      ...baseConfig.quality,
      kernelSize: debugConfig.kernelSize,
      resolutionScale: debugConfig.resolutionScale,
      algorithm: debugConfig.algorithm,
    },
  };
}
