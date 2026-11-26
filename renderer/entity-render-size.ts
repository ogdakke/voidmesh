import { config } from "#config";
import type { ShaderCanvasEntity, Viewport } from "#types/canvas.ts";

export function getEntityRenderPixelScale(
  entity: ShaderCanvasEntity,
  renderWidth: number,
  renderHeight: number,
): number {
  return (
    Math.max(renderWidth, renderHeight) /
    Math.max(entity.originalSize.width, entity.originalSize.height)
  );
}

/** Smallest step between continuous output sizes, in device pixels. */
const CONTINUOUS_OUTPUT_MIN_STEP = 32;
/** A step is this fraction of the projected size's power of two, so a zoom reallocates rarely. */
const CONTINUOUS_OUTPUT_STEP_DIVISOR = 4;

/**
 * Output size for an effect processed again every frame: the entity's projection in device
 * pixels, rounded up to a step of 32 px or a quarter of its power of two, and never above
 * the media's own size. Unlike `getEntityRenderSize` it keeps no zoom margin, since the next
 * frame processes it again at the size it then has. `maxSide` bounds it as it does a tier.
 */
export function getContinuousOutputSize(
  entity: ShaderCanvasEntity,
  viewport: Viewport,
  devicePixelRatio: number,
  output: { width: number; height: number } = { width: 0, height: 0 },
  maxSide = Infinity,
): { width: number; height: number } {
  const original = entity.originalSize;
  const originalMax = Math.max(original.width, original.height);
  const projectedMax = Math.min(
    maxSide,
    Math.max(entity.size.width, entity.size.height) * viewport.zoom * devicePixelRatio,
  );
  const step = Math.max(
    CONTINUOUS_OUTPUT_MIN_STEP,
    2 ** Math.floor(Math.log2(Math.max(projectedMax, 1))) / CONTINUOUS_OUTPUT_STEP_DIVISOR,
  );
  const targetMax = Math.ceil(projectedMax / step) * step;
  if (targetMax >= originalMax) {
    output.width = original.width;
    output.height = original.height;
    return output;
  }
  const scale = targetMax / originalMax;
  output.width = Math.max(1, Math.round(original.width * scale));
  output.height = Math.max(1, Math.round(original.height * scale));
  return output;
}

/**
 * Preview size for an entity: the LOD tier covering its projection, or the media's own size
 * when that is smaller. `maxSide` caps the longest side on devices that cannot hold a
 * native-size texture and its effect intermediates; export never uses this size.
 */
export function getEntityRenderSize(
  entity: ShaderCanvasEntity,
  viewport: Viewport,
  devicePixelRatio: number,
  output: { width: number; height: number } = { width: 0, height: 0 },
  maxSide = Infinity,
): { width: number; height: number } {
  const original = entity.originalSize;
  const originalMax = Math.max(original.width, original.height);
  const projectedMax = Math.min(
    maxSide,
    Math.max(entity.size.width, entity.size.height) *
      viewport.zoom *
      devicePixelRatio *
      config.rendering.imageLodOverscan,
  );
  if (projectedMax >= originalMax) {
    output.width = original.width;
    output.height = original.height;
    return output;
  }

  let tier = originalMax;
  for (const candidate of config.rendering.imageLodTiers) {
    if (candidate < projectedMax) continue;
    tier = candidate;
    break;
  }
  const targetMax = Math.min(originalMax, tier, maxSide);
  const scale = targetMax / originalMax;
  output.width = Math.max(1, Math.round(original.width * scale));
  output.height = Math.max(1, Math.round(original.height * scale));
  return output;
}
