import {
  DEFAULT_WLUR_PARAMS,
  DEFAULT_WLUR_QUALITY,
  MAX_WLUR_KERNEL_SIZE,
  MIN_WLUR_KERNEL_SIZE,
  type WlurDirection,
  type WlurParams,
  type WlurQuality,
  type WlurTintColor,
  type WlurWorkingDimensions,
} from "./types.ts";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeWlurKernelSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WLUR_QUALITY.kernelSize;

  let kernelSize = Math.round(value);
  kernelSize = clamp(kernelSize, MIN_WLUR_KERNEL_SIZE, MAX_WLUR_KERNEL_SIZE);

  if (kernelSize % 2 === 0) {
    kernelSize = Math.min(kernelSize + 1, MAX_WLUR_KERNEL_SIZE);
  }

  return kernelSize;
}

export function clampWlurQuality(quality?: Partial<WlurQuality>): WlurQuality {
  return {
    kernelSize: normalizeWlurKernelSize(quality?.kernelSize ?? DEFAULT_WLUR_QUALITY.kernelSize),
    resolutionScale: clamp(
      quality?.resolutionScale ?? DEFAULT_WLUR_QUALITY.resolutionScale,
      0.1,
      1,
    ),
  };
}

export function clampWlurParams(params?: Partial<WlurParams>): WlurParams {
  const direction = params?.direction;
  const resolvedDirection: WlurDirection =
    direction === "down" || direction === "up" || direction === "right" || direction === "left"
      ? direction
      : DEFAULT_WLUR_PARAMS.direction;
  const rawTint = params?.tint;
  const tint =
    rawTint && Array.isArray(rawTint.color) && rawTint.color.length === 3
      ? {
          color: clampWlurTintColor(rawTint.color),
          amount: Math.max(0, rawTint.amount),
        }
      : undefined;

  return {
    radius: Math.max(0, params?.radius ?? DEFAULT_WLUR_PARAMS.radius),
    offset: clamp(params?.offset ?? DEFAULT_WLUR_PARAMS.offset, 0, 1),
    interpolation: clamp(params?.interpolation ?? DEFAULT_WLUR_PARAMS.interpolation, 0, 1),
    direction: resolvedDirection,
    noise: Math.max(0, params?.noise ?? DEFAULT_WLUR_PARAMS.noise),
    ...(tint ? { tint } : {}),
  };
}

export function clampWlurTintColor(color: WlurTintColor): WlurTintColor {
  return [clamp(color[0] ?? 0, 0, 1), clamp(color[1] ?? 0, 0, 1), clamp(color[2] ?? 0, 0, 1)];
}

export function wlurDirectionToIndex(direction: WlurDirection): number {
  switch (direction) {
    case "down":
      return 0;
    case "up":
      return 1;
    case "right":
      return 2;
    case "left":
      return 3;
  }
}

export function mapWlurFactorAtPoint(
  point: { x: number; y: number },
  params: Pick<WlurParams, "direction" | "offset" | "interpolation">,
): number {
  if (params.interpolation <= 0.000001) {
    switch (params.direction) {
      case "down":
        return point.y >= params.offset ? 1 : 0;
      case "up":
        return point.y <= params.offset ? 1 : 0;
      case "right":
        return point.x >= params.offset ? 1 : 0;
      case "left":
        return point.x <= params.offset ? 1 : 0;
    }
  }

  let mapped = 0;

  switch (params.direction) {
    case "down":
      mapped = Math.max((point.y - params.offset) / params.interpolation, 0);
      break;
    case "up":
      mapped = Math.max(0.5 - (point.y - params.offset) / params.interpolation, 0);
      break;
    case "right":
      mapped = Math.max((point.x - params.offset) / params.interpolation, 0);
      break;
    case "left":
      mapped = Math.max(0.5 - (point.x - params.offset) / params.interpolation, 0);
      break;
  }

  return Math.min(mapped, 1);
}

export function getWlurWorkingDimensions(
  width: number,
  height: number,
  resolutionScale: number,
): WlurWorkingDimensions {
  const scale = clampWlurQuality({ resolutionScale }).resolutionScale;
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const workingWidth = Math.max(1, Math.round(safeWidth * scale));
  const workingHeight = Math.max(1, Math.round(safeHeight * scale));
  const actualScale = Math.min(workingWidth / safeWidth, workingHeight / safeHeight);

  return {
    width: workingWidth,
    height: workingHeight,
    scale: actualScale,
  };
}

export function getWlurScratchKey(width: number, height: number, resolutionScale: number): string {
  const working = getWlurWorkingDimensions(width, height, resolutionScale);
  return `${width}x${height}-${working.width}x${working.height}`;
}
