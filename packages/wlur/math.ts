import {
  DEFAULT_WLUR_PARAMS,
  DEFAULT_WLUR_QUALITY,
  MAX_WLUR_KAWASE_LEVELS,
  MAX_WLUR_KERNEL_SIZE,
  MIN_WLUR_KERNEL_SIZE,
  type WlurDirection,
  type WlurParams,
  type WlurQuality,
  type WlurTintColor,
  type WlurWorkingDimensions,
} from "./types.ts";
import { createWlurCurveLut, resolveWlurCurve } from "./curve.ts";

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
    algorithm: quality?.algorithm === "kawase" ? "kawase" : "gaussian",
  };
}

/** Full-resolution sigma cap of the hybrid fine layer, in screen pixels. */
export function getWlurFineSigmaCap(fineDepth: number): number {
  return 2 ** (fineDepth + 1) - 1;
}

/**
 * Odd Gaussian kernel covering ±2.5σ of the fine layer's capped sigma. Sized for the next whole
 * depth so dragging a fractional depth reuses at most four compiled pipelines.
 */
export function getWlurFineKernelSize(fineDepth: number): number {
  const cap = getWlurFineSigmaCap(Math.ceil(fineDepth));
  return Math.min(MAX_WLUR_KERNEL_SIZE, 2 * Math.ceil(2.5 * cap) + 1);
}

/** Band textures grow in these steps so tuning the ramp does not reallocate every frame. */
const WLUR_FINE_BAND_STEP_PX = 64;

/**
 * Screen-pixel band the hybrid fine layer must cover: from the ramp start to where the depth
 * passes `fineDepth + 1` (after which the pyramid alone is shown), padded by the kernel and
 * rounded up to a band step. `null` when the fine layer is off.
 */
export function getWlurFineBand(
  width: number,
  height: number,
  params: WlurParams,
): WlurPixelRegion | null {
  const fineDepth = params.fineDepth ?? 0;
  if (fineDepth <= 0) return null;

  const levels = params.levels ?? DEFAULT_WLUR_PARAMS.levels;
  // Curve value where the composite has fully switched to the pyramid.
  const handoff = (2 ** (fineDepth + 1) - 1) / Math.max(2 ** levels - 1, 1e-6);
  let rawEnd = 1;
  if (handoff < 1) {
    const lut = createWlurCurveLut(params.curve, 256);
    const index = lut.findIndex((value) => value >= handoff);
    // Two samples of margin cover the GPU's coarser, 8-bit curve texture.
    rawEnd = index < 0 ? 1 : Math.min(1, (index + 2) / 255);
  }

  const vertical = params.direction === "down" || params.direction === "up";
  const extent = vertical ? height : width;
  const growsForward = params.direction === "down" || params.direction === "right";
  const start = growsForward
    ? params.offset
    : params.offset + (0.5 - rawEnd) * params.interpolation;
  const end = growsForward
    ? params.offset + rawEnd * params.interpolation
    : params.offset + 0.5 * params.interpolation;

  const pad = (getWlurFineKernelSize(fineDepth) - 1) / 2 + 2;
  let from = clamp(Math.floor(Math.min(start, end) * extent) - pad, 0, extent);
  const to = clamp(Math.ceil(Math.max(start, end) * extent) + pad, 0, extent);
  const size = Math.min(
    extent,
    Math.max(
      WLUR_FINE_BAND_STEP_PX,
      Math.ceil((to - from) / WLUR_FINE_BAND_STEP_PX) * WLUR_FINE_BAND_STEP_PX,
    ),
  );
  from = Math.min(from, extent - size);

  return vertical ? { x: 0, y: from, width, height: size } : { x: from, y: 0, width: size, height };
}

/** Number of pyramid textures needed for a Kawase blur reaching `levels`. */
export function getWlurKawaseLevelCount(levels: number): number {
  return clamp(Math.ceil(levels), 1, MAX_WLUR_KAWASE_LEVELS);
}

/**
 * Conservative full-resolution reach of a Kawase pyramid: how far a source pixel can move the
 * blurred output. Each downsample reads 2 source texels plus bilinear support; each upsample
 * reads about 1.3 × (1 + spread) texels of the coarser level plus bilinear support.
 */
export function getWlurKawaseReachPx(levels: number, spread: number): number {
  const count = getWlurKawaseLevelCount(levels);
  let reach = 0;
  for (let level = 1; level <= count; level++) {
    reach += 3 * 2 ** (level - 1);
  }
  for (let level = 1; level < count; level++) {
    reach += (1.3 * (1 + spread) + 1) * 2 ** (level + 1);
  }
  // Composite samples the half-resolution result bilinearly.
  return Math.ceil(reach + 2);
}

/** Pyramid level sizes for a Kawase blur: level `i + 1` is `sizes[i]`, each half the previous. */
export function getWlurKawaseLevelSizes(
  width: number,
  height: number,
  levelCount: number,
): { width: number; height: number }[] {
  const sizes: { width: number; height: number }[] = [];
  let w = width;
  let h = height;
  for (let level = 1; level <= levelCount; level++) {
    w = Math.max(1, Math.ceil(w / 2));
    h = Math.max(1, Math.ceil(h / 2));
    sizes.push({ width: w, height: h });
  }
  return sizes;
}

export interface WlurKawaseRegions {
  /** Scissor of each downsample pass; `down[i]` writes pyramid level `i + 1`. */
  down: WlurPixelRegion[];
  /** Scissor of each upsample pass; `up[i]` writes the level `i + 1` upsample. */
  up: WlurPixelRegion[];
}

/**
 * Slack, in texels, on each side of a bilinear footprint. GPUs resolve sample positions to a
 * fixed sub-texel grid (8 bits on common hardware), so a tap computed exactly on a texel
 * boundary may land just across it.
 */
const WLUR_KAWASE_SAMPLE_SLACK = 1 / 16;
/** Down taps reach this many source texels from the fragment (13-tap filter). */
const WLUR_KAWASE_DOWN_REACH = 2;
/** Matches the upsample shader's diagonal tap scale, sqrt(5/3). */
const WLUR_KAWASE_UP_TAP_SCALE = 1.2909944487;

/**
 * Scissor regions that limit every Kawase pyramid pass to the texels the composite can read.
 *
 * The composite only samples the pyramid where the ramp factor is non-zero (the effect
 * region), so walking the dependency chain back from there — composite → upsamples → their
 * detail and coarser inputs → downsamples — gives each pass the interval along the ramp axis
 * whose texels can reach the output. Texels outside it are never sampled, so limiting the
 * passes leaves the rendered result unchanged. Intervals are sample-uv ranges; a pass's
 * scissor covers their bilinear footprint plus sub-texel slack, and mirrored taps past an edge
 * fold back inside the range.
 */
export function getWlurKawaseRegions(
  width: number,
  height: number,
  levelCount: number,
  params: Pick<WlurParams, "direction" | "offset" | "interpolation" | "spread">,
): WlurKawaseRegions {
  const sizes = getWlurKawaseLevelSizes(width, height, levelCount);
  const vertical = params.direction === "down" || params.direction === "up";
  const axisSize = (size: { width: number; height: number }) =>
    vertical ? size.height : size.width;

  type Interval = [number, number] | null;
  const union = (a: Interval, b: Interval): Interval =>
    !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
  // Mirror addressing reads [0, -lo] for lo < 0 and [2 - hi, 1] for hi > 1.
  const fold = ([lo, hi]: [number, number]): [number, number] => {
    let from = lo;
    let to = hi;
    if (from < 0) {
      to = Math.max(to, -from);
      from = 0;
    }
    if (to > 1) {
      from = Math.min(from, 2 - to);
      to = 1;
    }
    return [Math.max(0, from), Math.min(1, to)];
  };
  /** Texel span `[a, b)` of a texture of `n` texels that bilinear samples in `uv` can touch. */
  const texels = (uv: Interval, n: number): [number, number] => {
    if (!uv) return [0, 0];
    const [lo, hi] = fold(uv);
    // Bilinear taps read texels floor(t) and floor(t) + 1 for t = uv × n − 0.5.
    return [
      Math.max(0, Math.floor(lo * n - 0.5 - WLUR_KAWASE_SAMPLE_SLACK)),
      Math.min(n, Math.floor(hi * n - 0.5 + WLUR_KAWASE_SAMPLE_SLACK) + 2),
    ];
  };
  /** Sample-uv range of the fragment centres in texel span `[a, b)`, widened by `reach` uv. */
  const centres = ([a, b]: [number, number], n: number, reach: number): Interval =>
    b <= a ? null : [(a + 0.5) / n - reach, (b - 0.5) / n + reach];
  const toRegion = ([a, b]: [number, number], size: { width: number; height: number }) =>
    vertical
      ? { x: 0, y: a, width: size.width, height: b - a }
      : { x: a, y: 0, width: b - a, height: size.height };

  // The composite samples the pyramid output at full-resolution pixel centres in the effect region.
  const effect = getWlurEffectRegion(width, height, params);
  const effectFrom = vertical ? effect.y : effect.x;
  const effectSize = vertical ? effect.height : effect.width;
  const fullSize = vertical ? height : width;
  const output: Interval =
    effectSize > 0
      ? [(effectFrom + 0.5) / fullSize, (effectFrom + effectSize - 0.5) / fullSize]
      : null;

  const needDown: Interval[] = Array.from({ length: levelCount }, () => null);
  const needUp: Interval[] = Array.from({ length: Math.max(0, levelCount - 1) }, () => null);
  if (levelCount > 1) needUp[0] = output;
  else needDown[0] = output;

  const upTap = (1 + (params.spread ?? 0)) * WLUR_KAWASE_UP_TAP_SCALE;
  const up: WlurPixelRegion[] = [];
  for (let level = 1; level < levelCount; level++) {
    const size = sizes[level - 1]!;
    const n = axisSize(size);
    const span = texels(needUp[level - 1] ?? null, n);
    up.push(toRegion(span, size));
    needDown[level - 1] = union(needDown[level - 1] ?? null, centres(span, n, 0));
    const coarserSize = axisSize(sizes[level]!);
    const coarser = centres(span, n, upTap / coarserSize);
    if (level === levelCount - 1) needDown[level] = union(needDown[level] ?? null, coarser);
    else needUp[level] = union(needUp[level] ?? null, coarser);
  }

  const down: WlurPixelRegion[] = [];
  for (let level = levelCount; level >= 1; level--) {
    const size = sizes[level - 1]!;
    const n = axisSize(size);
    const span = texels(needDown[level - 1] ?? null, n);
    down[level - 1] = toRegion(span, size);
    if (level > 1) {
      const sourceSize = axisSize(sizes[level - 2]!);
      needDown[level - 2] = union(
        needDown[level - 2] ?? null,
        centres(span, n, WLUR_KAWASE_DOWN_REACH / sourceSize),
      );
    }
  }

  return { down, up };
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
          ...(rawTint.curve !== undefined ? { curve: resolveWlurCurve(rawTint.curve) } : {}),
        }
      : undefined;

  return {
    radius: Math.max(0, params?.radius ?? DEFAULT_WLUR_PARAMS.radius),
    ...(params?.curve !== undefined ? { curve: resolveWlurCurve(params.curve) } : {}),
    ...(params?.mixCurve !== undefined ? { mixCurve: resolveWlurCurve(params.mixCurve) } : {}),
    offset: clamp(params?.offset ?? DEFAULT_WLUR_PARAMS.offset, 0, 1),
    interpolation: clamp(params?.interpolation ?? DEFAULT_WLUR_PARAMS.interpolation, 0, 1),
    direction: resolvedDirection,
    noise: Math.max(0, params?.noise ?? DEFAULT_WLUR_PARAMS.noise),
    levels: clamp(params?.levels ?? DEFAULT_WLUR_PARAMS.levels, 0, MAX_WLUR_KAWASE_LEVELS),
    spread: clamp(params?.spread ?? DEFAULT_WLUR_PARAMS.spread, 0, 4),
    fineDepth: clamp(params?.fineDepth ?? DEFAULT_WLUR_PARAMS.fineDepth, 0, 4),
    fade: clamp(params?.fade ?? DEFAULT_WLUR_PARAMS.fade, 0.001, 1),
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

export interface WlurPixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WlurBlurRegions {
  blurX: WlurPixelRegion;
  blurY: WlurPixelRegion;
  partial: boolean;
}

function intersectPixelRegions(a: WlurPixelRegion, b: WlurPixelRegion): WlurPixelRegion {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

export function getWlurEffectRegion(
  width: number,
  height: number,
  params: Pick<WlurParams, "direction" | "offset" | "interpolation">,
): WlurPixelRegion {
  const interpolation = params.interpolation;
  switch (params.direction) {
    case "down": {
      const y = Math.max(0, Math.floor(params.offset * height) - 1);
      return { x: 0, y, width, height: height - y };
    }
    case "up": {
      const edge = params.offset + (interpolation <= 0.000001 ? 0 : interpolation * 0.5);
      return { x: 0, y: 0, width, height: Math.min(height, Math.ceil(edge * height) + 1) };
    }
    case "right": {
      const x = Math.max(0, Math.floor(params.offset * width) - 1);
      return { x, y: 0, width: width - x, height };
    }
    case "left": {
      const edge = params.offset + (interpolation <= 0.000001 ? 0 : interpolation * 0.5);
      return { x: 0, y: 0, width: Math.min(width, Math.ceil(edge * width) + 1), height };
    }
  }
}

/**
 * Scissor regions needed to refresh the separable Wlur blur after source pixels
 * inside `refreshRegion` changed. The first pass expands horizontally because it
 * samples the source along X. The second also expands vertically because it
 * samples the persistent first-pass result along Y.
 */
export function getWlurBlurRegions(
  width: number,
  height: number,
  params: WlurParams,
  quality: WlurQuality,
  refreshRegion?: WlurPixelRegion,
): WlurBlurRegions {
  const working = getWlurWorkingDimensions(width, height, quality.resolutionScale);
  const blurY = getWlurEffectRegion(working.width, working.height, params);
  const halfKernel = (normalizeWlurKernelSize(quality.kernelSize) - 1) / 2;
  const blurX = {
    x: blurY.x,
    y: Math.max(0, blurY.y - halfKernel),
    width: blurY.width,
    height:
      Math.min(working.height, blurY.y + blurY.height + halfKernel) -
      Math.max(0, blurY.y - halfKernel),
  };
  if (!refreshRegion) return { blurX, blurY, partial: false };

  // Blur X samples the full-resolution source through a linear sampler. Include
  // one working texel around the mapped source change before propagating it
  // through either kernel so fractional source coordinates cannot leave a seam.
  const sourceFilterPadding = 1;
  const dirtyX = Math.max(
    0,
    Math.floor((refreshRegion.x * working.width) / width) - sourceFilterPadding,
  );
  const dirtyY = Math.max(
    0,
    Math.floor((refreshRegion.y * working.height) / height) - sourceFilterPadding,
  );
  const dirtyRight = Math.min(
    working.width,
    Math.ceil(((refreshRegion.x + refreshRegion.width) * working.width) / width) +
      sourceFilterPadding,
  );
  const dirtyBottom = Math.min(
    working.height,
    Math.ceil(((refreshRegion.y + refreshRegion.height) * working.height) / height) +
      sourceFilterPadding,
  );
  const dirtyWidth = Math.max(0, dirtyRight - dirtyX);
  const dirtyHeight = Math.max(0, dirtyBottom - dirtyY);
  const partialBlurX = intersectPixelRegions(blurX, {
    x: Math.max(0, dirtyX - halfKernel),
    y: dirtyY,
    width:
      Math.min(working.width, dirtyX + dirtyWidth + halfKernel) - Math.max(0, dirtyX - halfKernel),
    height: dirtyHeight,
  });
  const partialBlurY = intersectPixelRegions(blurY, {
    x: Math.max(0, dirtyX - halfKernel),
    y: Math.max(0, dirtyY - halfKernel),
    width:
      Math.min(working.width, dirtyX + dirtyWidth + halfKernel) - Math.max(0, dirtyX - halfKernel),
    height:
      Math.min(working.height, dirtyY + dirtyHeight + halfKernel) -
      Math.max(0, dirtyY - halfKernel),
  });
  return { blurX: partialBlurX, blurY: partialBlurY, partial: true };
}

/**
 * Full-resolution source pixels that can contribute to the blurred part of Wlur.
 * The extra texel covers linear-filter support at the edge of the fixed kernel.
 */
export function getWlurSourceDependencyRegion(
  width: number,
  height: number,
  params: WlurParams,
  quality: WlurQuality,
): WlurPixelRegion {
  if (quality.algorithm === "kawase") {
    // The pyramid runs at full resolution scale, so pad the full-size effect region directly.
    const effect = getWlurEffectRegion(width, height, params);
    const reach = getWlurKawaseReachPx(
      params.levels ?? DEFAULT_WLUR_PARAMS.levels,
      params.spread ?? DEFAULT_WLUR_PARAMS.spread,
    );
    const x0 = Math.max(0, effect.x - reach);
    const y0 = Math.max(0, effect.y - reach);
    const x1 = Math.min(width, effect.x + effect.width + reach);
    const y1 = Math.min(height, effect.y + effect.height + reach);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  const working = getWlurWorkingDimensions(width, height, quality.resolutionScale);
  const effect = getWlurEffectRegion(working.width, working.height, params);
  const padding = (normalizeWlurKernelSize(quality.kernelSize) - 1) / 2 + 1;
  const x0 = Math.max(0, effect.x - padding);
  const y0 = Math.max(0, effect.y - padding);
  const x1 = Math.min(working.width, effect.x + effect.width + padding);
  const y1 = Math.min(working.height, effect.y + effect.height + padding);

  const sourceX0 = Math.max(0, Math.floor((x0 * width) / working.width));
  const sourceY0 = Math.max(0, Math.floor((y0 * height) / working.height));
  const sourceX1 = Math.min(width, Math.ceil((x1 * width) / working.width));
  const sourceY1 = Math.min(height, Math.ceil((y1 * height) / working.height));
  return {
    x: sourceX0,
    y: sourceY0,
    width: sourceX1 - sourceX0,
    height: sourceY1 - sourceY0,
  };
}

export function getWlurScratchKey(width: number, height: number, resolutionScale: number): string {
  const working = getWlurWorkingDimensions(width, height, resolutionScale);
  return `${width}x${height}-${working.width}x${working.height}`;
}
