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

export function getEntityRenderSize(
  entity: ShaderCanvasEntity,
  viewport: Viewport,
  devicePixelRatio: number,
  output: { width: number; height: number } = { width: 0, height: 0 },
): { width: number; height: number } {
  const original = entity.originalSize;
  const originalMax = Math.max(original.width, original.height);
  const projectedMax =
    Math.max(entity.size.width, entity.size.height) *
    viewport.zoom *
    devicePixelRatio *
    config.rendering.imageLodOverscan;
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
  const targetMax = Math.min(originalMax, tier);
  const scale = targetMax / originalMax;
  output.width = Math.max(1, Math.round(original.width * scale));
  output.height = Math.max(1, Math.round(original.height * scale));
  return output;
}
