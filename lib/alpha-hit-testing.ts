import type { AlphaHitGrid, Point, ShaderCanvasEntity } from "#types/canvas.ts";
import { MediaType } from "#types/canvas.ts";
import { logger } from "./client.logger.ts";
import { getFrameAtTime } from "./gif-decoder.ts";

export interface AlphaGridBuildOptions {
  cellSizePx: number;
  alphaThreshold: number;
  coverageThreshold: number;
}

type SizedCanvasSource = CanvasImageSource & { width: number; height: number };

let cellSampleCanvas: OffscreenCanvas | null = null;

function getCellSampleCanvas(width: number, height: number): OffscreenCanvas {
  if (!cellSampleCanvas) {
    cellSampleCanvas = new OffscreenCanvas(width, height);
  } else if (cellSampleCanvas.width !== width || cellSampleCanvas.height !== height) {
    cellSampleCanvas.width = width;
    cellSampleCanvas.height = height;
  }

  return cellSampleCanvas;
}

export function createAlphaHitGrid(
  source: SizedCanvasSource,
  options: AlphaGridBuildOptions,
): AlphaHitGrid {
  logger.time("[hit-testing] createAlphaHitGrid");
  const width = Math.max(1, source.width);
  const height = Math.max(1, source.height);
  const cellSize = Math.max(1, Math.floor(options.cellSizePx));
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const cells = new Uint8Array(cols * rows);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Unable to create alpha hit-test canvas context.");
  }

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const alphaThreshold = Math.max(0, Math.min(255, options.alphaThreshold));
  const coverageThreshold = Math.max(0, Math.min(1, options.coverageThreshold));

  let hasTransparentCells = false;
  let hasOpaqueCells = false;

  for (let row = 0; row < rows; row++) {
    const y0 = row * cellSize;
    const y1 = Math.min(y0 + cellSize, height);

    for (let col = 0; col < cols; col++) {
      const x0 = col * cellSize;
      const x1 = Math.min(x0 + cellSize, width);
      const total = (x1 - x0) * (y1 - y0);
      let opaque = 0;

      for (let y = y0; y < y1; y++) {
        let index = (y * width + x0) * 4 + 3;
        for (let x = x0; x < x1; x++) {
          if (data[index]! > alphaThreshold) opaque++;
          index += 4;
        }
      }

      const isOpaque = total > 0 && opaque / total >= coverageThreshold;
      cells[row * cols + col] = isOpaque ? 1 : 0;
      hasOpaqueCells ||= isOpaque;
      hasTransparentCells ||= !isOpaque;
    }
  }

  logger.timeEnd("[hit-testing] createAlphaHitGrid");
  return {
    width,
    height,
    cellSize,
    cols,
    rows,
    cells,
    hasTransparentCells,
    hasOpaqueCells,
  };
}

export function worldPointToEntityLocal(
  worldPoint: Point,
  entity: Pick<ShaderCanvasEntity, "position" | "size" | "rotation">,
): Point | null {
  const centerX = entity.position.x + entity.size.width / 2;
  const centerY = entity.position.y + entity.size.height / 2;
  const dx = worldPoint.x - centerX;
  const dy = worldPoint.y - centerY;
  const radians = (-entity.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localX = dx * cos - dy * sin + entity.size.width / 2;
  const localY = dx * sin + dy * cos + entity.size.height / 2;

  if (localX < 0 || localY < 0 || localX > entity.size.width || localY > entity.size.height) {
    return null;
  }

  return { x: localX, y: localY };
}

export function isAlphaGridCellOpaque(
  grid: AlphaHitGrid,
  localPoint: Point,
  entitySize: { width: number; height: number },
): boolean {
  if (!grid.hasOpaqueCells) return false;
  if (!grid.hasTransparentCells) return true;

  const u = Math.max(0, Math.min(0.999999, localPoint.x / entitySize.width));
  const v = Math.max(0, Math.min(0.999999, localPoint.y / entitySize.height));
  const col = Math.min(grid.cols - 1, Math.floor((u * grid.width) / grid.cellSize));
  const row = Math.min(grid.rows - 1, Math.floor((v * grid.height) / grid.cellSize));

  return grid.cells[row * grid.cols + col] === 1;
}

export function sampleCanvasSourceCellOpacity(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  localPoint: Point,
  entitySize: { width: number; height: number },
  options: AlphaGridBuildOptions,
): boolean {
  logger.time("[hit-testing] sampleCanvasSourceCellOpacity");
  const cellSize = Math.max(1, Math.floor(options.cellSizePx));
  const u = Math.max(0, Math.min(0.999999, localPoint.x / entitySize.width));
  const v = Math.max(0, Math.min(0.999999, localPoint.y / entitySize.height));
  const sourceX = Math.floor(u * sourceWidth);
  const sourceY = Math.floor(v * sourceHeight);
  const cellX = Math.floor(sourceX / cellSize) * cellSize;
  const cellY = Math.floor(sourceY / cellSize) * cellSize;
  const sampleWidth = Math.max(1, Math.min(cellSize, sourceWidth - cellX));
  const sampleHeight = Math.max(1, Math.min(cellSize, sourceHeight - cellY));
  const canvas = getCellSampleCanvas(sampleWidth, sampleHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    // Synchronous alpha inspection is unavailable, so preserve legacy rectangular hit behavior.
    return true;
  }

  ctx.clearRect(0, 0, sampleWidth, sampleHeight);
  ctx.drawImage(source, cellX, cellY, sampleWidth, sampleHeight, 0, 0, sampleWidth, sampleHeight);
  const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
  const alphaThreshold = Math.max(0, Math.min(255, options.alphaThreshold));
  const coverageThreshold = Math.max(0, Math.min(1, options.coverageThreshold));
  let opaque = 0;
  const total = sampleWidth * sampleHeight;

  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! > alphaThreshold) opaque++;
  }

  logger.timeEnd("[hit-testing] sampleCanvasSourceCellOpacity");
  return opaque / total >= coverageThreshold;
}

export function getEntityAlphaGrid(entity: ShaderCanvasEntity): AlphaHitGrid | undefined {
  switch (entity.mediaSource.type) {
    case MediaType.image:
    case MediaType.svg:
      return entity.mediaSource.alphaHitGrid;
    case MediaType.gif: {
      if (!entity.playback) return entity.mediaSource.frames[0]?.alphaHitGrid;
      return getFrameAtTime(
        entity.mediaSource.frames,
        entity.playback.currentTime,
        entity.playback.loop,
      ).alphaHitGrid;
    }
    case MediaType.video:
      return undefined;
  }
}
