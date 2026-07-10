import { config } from "#config";
import { MediaType, type ShaderCanvasEntity, type Viewport } from "#types/canvas.ts";

export function getEntityRenderSize(
  entity: ShaderCanvasEntity,
  viewport: Viewport,
  devicePixelRatio: number,
): { width: number; height: number } {
  const original = entity.originalSize;
  const originalMax = Math.max(original.width, original.height);
  const projectedMax =
    Math.max(entity.size.width, entity.size.height) *
    viewport.zoom *
    devicePixelRatio *
    config.rendering.imageLodOverscan;
  if (projectedMax >= originalMax) return original;

  const tier =
    config.rendering.imageLodTiers.find((candidate) => candidate >= projectedMax) ?? originalMax;
  const targetMax = Math.min(originalMax, tier);
  const scale = targetMax / originalMax;
  return {
    width: Math.max(1, Math.round(original.width * scale)),
    height: Math.max(1, Math.round(original.height * scale)),
  };
}

export function shouldUseLiveVideo(
  entity: ShaderCanvasEntity,
  viewport: Viewport,
  devicePixelRatio: number,
): boolean {
  return (
    entity.mediaSource.type !== MediaType.video ||
    Math.max(entity.size.width, entity.size.height) * viewport.zoom * devicePixelRatio >=
      config.rendering.liveVideoMinProjectedPixels
  );
}
