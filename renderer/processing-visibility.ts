import type { ShaderOutputRegion } from "./effect-render-entity.ts";

/** Axis-aligned world rectangle as edges; empty when `x1 <= x0` or `y1 <= y0`. */
export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function isEmptyRect(rect: WorldRect): boolean {
  return rect.x1 <= rect.x0 || rect.y1 <= rect.y0;
}

/**
 * Shrink `visible` by an opaque `cover` drawn above it. Only a cover spanning a whole
 * side removes anything, so the result stays one rectangle and never drops a shown pixel;
 * a cover over the middle or a corner leaves it as it was.
 */
export function subtractCoveringRect(visible: WorldRect, cover: WorldRect): void {
  if (isEmptyRect(visible) || isEmptyRect(cover)) return;
  if (
    cover.x0 >= visible.x1 ||
    cover.x1 <= visible.x0 ||
    cover.y0 >= visible.y1 ||
    cover.y1 <= visible.y0
  ) {
    return;
  }
  const spansX = cover.x0 <= visible.x0 && cover.x1 >= visible.x1;
  const spansY = cover.y0 <= visible.y0 && cover.y1 >= visible.y1;
  if (spansX && spansY) {
    visible.x1 = visible.x0;
  } else if (spansY && cover.x0 <= visible.x0) {
    visible.x0 = cover.x1;
  } else if (spansY && cover.x1 >= visible.x1) {
    visible.x1 = cover.x0;
  } else if (spansX && cover.y0 <= visible.y0) {
    visible.y0 = cover.y1;
  } else if (spansX && cover.y1 >= visible.y1) {
    visible.y1 = cover.y0;
  }
}

/**
 * The texels of an unrotated entity's `textureWidth`×`textureHeight` output that cover
 * `visible`, grown by `marginWorld` and `padTexels` for edge filtering. Zero-sized when
 * nothing shows.
 */
export function toOutputRegion(
  visible: WorldRect,
  entityX: number,
  entityY: number,
  entityWidth: number,
  entityHeight: number,
  textureWidth: number,
  textureHeight: number,
  marginWorld: number,
  padTexels: number,
  output: ShaderOutputRegion,
): ShaderOutputRegion {
  if (isEmptyRect(visible) || entityWidth <= 0 || entityHeight <= 0) {
    output.x = 0;
    output.y = 0;
    output.width = 0;
    output.height = 0;
    return output;
  }
  const scaleX = textureWidth / entityWidth;
  const scaleY = textureHeight / entityHeight;
  const x0 = Math.max(0, Math.floor((visible.x0 - marginWorld - entityX) * scaleX) - padTexels);
  const y0 = Math.max(0, Math.floor((visible.y0 - marginWorld - entityY) * scaleY) - padTexels);
  const x1 = Math.min(
    textureWidth,
    Math.ceil((visible.x1 + marginWorld - entityX) * scaleX) + padTexels,
  );
  const y1 = Math.min(
    textureHeight,
    Math.ceil((visible.y1 + marginWorld - entityY) * scaleY) + padTexels,
  );
  output.x = x0;
  output.y = y0;
  output.width = Math.max(0, x1 - x0);
  output.height = Math.max(0, y1 - y0);
  if (output.width === 0 || output.height === 0) {
    output.x = 0;
    output.y = 0;
    output.width = 0;
    output.height = 0;
  }
  return output;
}
