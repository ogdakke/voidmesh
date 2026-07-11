import { config } from "#config";
import {
  getEntityAlphaGrid,
  isAlphaGridCellOpaque,
  sampleCanvasSourceCellOpacity,
  worldPointToEntityLocal,
} from "#lib/alpha-hit-testing.ts";
import { MediaType, type Point, type ShaderCanvasEntity } from "#types/canvas.ts";

export function findEntityAtPoint(
  worldPoint: Point,
  candidates: readonly ShaderCanvasEntity[],
): string | null {
  for (let i = candidates.length - 1; i >= 0; i--) {
    const entity = candidates[i]!;
    if (entity.locked) continue;

    const localPoint = worldPointToEntityLocal(worldPoint, entity);
    if (!localPoint) continue;

    if (isEntityHitCellOpaque(entity, localPoint)) {
      return entity.id;
    }
  }

  return null;
}

function isEntityHitCellOpaque(entity: ShaderCanvasEntity, localPoint: Point): boolean {
  if (!config.hitTesting.alphaGrid.enabled) return true;

  if (entity.mediaSource.type === MediaType.video) {
    if (entity.mediaSource.alphaMode === "none") return true;
    const video = entity.mediaSource.videoElement;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      // No current frame is synchronously inspectable, so preserve legacy rectangular selection.
      return true;
    }

    return sampleCanvasSourceCellOpacity(
      video,
      video.videoWidth || entity.originalSize.width,
      video.videoHeight || entity.originalSize.height,
      localPoint,
      entity.size,
      config.hitTesting.alphaGrid,
    );
  }

  const grid = getEntityAlphaGrid(entity);
  if (!grid) return true;

  return isAlphaGridCellOpaque(grid, localPoint, entity.size);
}
