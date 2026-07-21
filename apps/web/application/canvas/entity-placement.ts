import type { Point, Size, ShaderCanvasEntity } from "#types/canvas.ts";
import { calculateFitToView, easings, snapToGrid, SNAP_GRID_SIZE } from "#lib/canvas-math.ts";
import { canvasStore, gameLoop, viewportAnimation } from "#engine";
import { loadMediaFile, loadMediaFromBlob } from "#lib/media-loader.ts";
import { config } from "#config";
import { logger } from "#lib/client.logger.ts";
import { mapSettledWithConcurrency } from "#lib/async-concurrency.ts";

const MAX_CONCURRENT_MEDIA_LOADS = 4;

type EntityData = Omit<ShaderCanvasEntity, "id" | "zIndex" | "name"> & { name?: string };
type AddEntityFn = (entity: EntityData, filename?: string) => string;
type LoadedEntity = { data: EntityData; filename?: string };

interface LayoutOptions {
  gap: number;
  maxColumns: number;
}

export type LayoutAlgorithm = (sizes: Size[], options: LayoutOptions) => Point[];

export interface ImportPlacementOptions {
  anchor: Point;
  select: boolean;
  fitToView: boolean;
  bottomInset: number;
  onLoadFailure?: (failures: MediaLoadFailure[]) => void;
  onLoadProgress?: (completed: number, total: number) => void;
}

export interface MediaLoadFailure {
  file: File;
  reason: unknown;
  mediaKind: "video" | "image" | "unknown";
}

/**
 * Shelf-packing layout: pack items left-to-right into rows.
 * Wraps to a new row after maxColumns items.
 * Items are top-aligned within each row.
 */
export const shelfLayout: LayoutAlgorithm = (sizes, { gap, maxColumns }) => {
  const positions: Point[] = [];
  let x = 0;
  let y = 0;
  let shelfHeight = 0;
  let colCount = 0;

  for (const size of sizes) {
    if (colCount > 0 && colCount >= maxColumns) {
      y += shelfHeight + gap;
      x = 0;
      shelfHeight = 0;
      colCount = 0;
    }
    positions.push({ x, y });
    x += size.width + gap;
    shelfHeight = Math.max(shelfHeight, size.height);
    colCount++;
  }

  return positions;
};

/**
 * Calculate layout positions for multiple entities.
 * Sorts by area (biggest first), runs shelf-packing, then centers around anchor.
 * Returns positions in the same order as input sizes.
 */
export function calculateLayout(
  sizes: Size[],
  anchor: Point,
  options?: { gap?: number; maxColumns?: number; algorithm?: LayoutAlgorithm },
): Point[] {
  if (sizes.length === 0) return [];

  const gap = options?.gap ?? config.canvas.layoutGap;
  const maxColumns = options?.maxColumns ?? config.canvas.maxGridColumns;
  const algorithm = options?.algorithm ?? shelfLayout;

  if (sizes.length === 1) {
    return [
      {
        x: anchor.x - sizes[0]!.width / 2,
        y: anchor.y - sizes[0]!.height / 2,
      },
    ];
  }

  // Sort indices by area descending (biggest first)
  const indices = Array.from({ length: sizes.length }, (_, i) => i);
  indices.sort((a, b) => {
    const areaA = sizes[a]!.width * sizes[a]!.height;
    const areaB = sizes[b]!.width * sizes[b]!.height;
    return areaB - areaA;
  });

  const sortedSizes = indices.map((i) => sizes[i]!);

  const effectiveColumns = Math.min(maxColumns, sizes.length);

  // Run layout algorithm (produces positions relative to 0,0)
  const sortedPositions = algorithm(sortedSizes, { gap, maxColumns: effectiveColumns });

  // Compute bounding box
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < sortedPositions.length; i++) {
    const pos = sortedPositions[i]!;
    const size = sortedSizes[i]!;
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + size.width);
    maxY = Math.max(maxY, pos.y + size.height);
  }

  // Translate so bounding box center = anchor
  const offsetX = anchor.x - (minX + maxX) / 2;
  const offsetY = anchor.y - (minY + maxY) / 2;

  // Un-shuffle back to original input order
  const result: Point[] = new Array(sizes.length);
  for (let i = 0; i < indices.length; i++) {
    result[indices[i]!] = {
      x: sortedPositions[i]!.x + offsetX,
      y: sortedPositions[i]!.y + offsetY,
    };
  }

  return result;
}

/**
 * Animate viewport to fit given entity IDs.
 * Computes bounding box of all entities and transitions viewport to show them all.
 */
export function fitEntitiesToView(
  entityIds: string[],
  container: HTMLElement,
  bottomInset: number = 0,
): void {
  if (entityIds.length === 0) return;

  gameLoop.stopMomentum();

  const state = canvasStore.getState();
  let minX = Infinity,
    minY = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity;

  for (const id of entityIds) {
    const entity = state.entities.get(id);
    if (!entity) continue;
    minX = Math.min(minX, entity.position.x);
    minY = Math.min(minY, entity.position.y);
    maxX = Math.max(maxX, entity.position.x + entity.size.width);
    maxY = Math.max(maxY, entity.position.y + entity.size.height);
  }

  if (minX === Infinity) return;

  const targetViewport = calculateFitToView({
    entityPosition: { x: minX, y: minY },
    entitySize: { width: maxX - minX, height: maxY - minY },
    containerWidth: container.clientWidth,
    containerHeight: container.clientHeight,
    dpr: window.devicePixelRatio,
    padding: config.canvas.fitToViewPadding,
    minZoom: undefined,
    maxZoom: undefined,
    bottomInset,
  });

  viewportAnimation.animateTo(targetViewport, {
    duration: config.canvas.animation.fitToViewDuration,
    easing: easings[config.canvas.animation.easing],
  });
}

function placeLoadedEntities(
  loaded: LoadedEntity[],
  addEntity: AddEntityFn,
  container: HTMLElement,
  options: ImportPlacementOptions,
): string[] {
  if (loaded.length === 0) return [];

  const positions = calculateLayout(
    loaded.map((entity) => entity.data.size),
    options.anchor,
  );

  const snapEnabled = canvasStore.getState().snapToGrid;
  const entityIds: string[] = [];

  for (let i = 0; i < loaded.length; i++) {
    const position = snapEnabled ? snapToGrid(positions[i]!, SNAP_GRID_SIZE) : positions[i]!;
    const entity = loaded[i]!;
    const id = addEntity({ ...entity.data, position }, entity.filename);
    entityIds.push(id);
  }

  if (options.select) {
    canvasStore.replaceSelection(entityIds);
  }
  if (options.fitToView) {
    fitEntitiesToView(entityIds, container, options.bottomInset);
  }

  return entityIds;
}

function getMediaKind(file: File): MediaLoadFailure["mediaKind"] {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  return "unknown";
}

async function loadFilesForCanvas(
  files: File[],
  onProgress?: (completed: number, total: number) => void,
): Promise<{ loaded: LoadedEntity[]; failures: MediaLoadFailure[] }> {
  let completed = 0;
  const results = await mapSettledWithConcurrency(
    files,
    MAX_CONCURRENT_MEDIA_LOADS,
    async (file) => {
      try {
        return await loadMediaFile(file);
      } finally {
        completed++;
        onProgress?.(completed, files.length);
      }
    },
  );

  const loaded: LoadedEntity[] = [];
  const failures: MediaLoadFailure[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled" && result.value) {
      loaded.push({ data: result.value, filename: files[i]!.name });
    } else if (result.status === "rejected") {
      failures.push({
        file: files[i]!,
        reason: result.reason,
        mediaKind: getMediaKind(files[i]!),
      });
    }
  }

  return { loaded, failures };
}

async function loadUrlForCanvas(url: string): Promise<LoadedEntity | null> {
  const response = await fetch(url);
  const blob = await response.blob();

  const rawContentType = response.headers.get("content-type") ?? "";
  const mimeType = (rawContentType.split(";")[0]?.trim() || blob.type).toLowerCase();

  let filename: string | undefined;
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/");
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart && lastPart.includes(".")) {
      filename = decodeURIComponent(lastPart);
    }
  } catch {
    // Ignore URL parsing errors
  }

  const entityData = await loadMediaFromBlob(blob, mimeType, { x: 0, y: 0 }, filename);
  if (!entityData) return null;

  return { data: entityData, filename };
}

/**
 * Load files, lay them out around the provided anchor, then optionally select and fit.
 */
export async function addFilesToCanvas(
  files: File[],
  addEntity: AddEntityFn,
  container: HTMLElement,
  options: ImportPlacementOptions,
): Promise<string[]> {
  if (files.length === 0) return [];

  const { loaded, failures } = await loadFilesForCanvas(files, options.onLoadProgress);
  if (failures.length > 0) {
    options.onLoadFailure?.(failures);
  }
  return placeLoadedEntities(loaded, addEntity, container, options);
}

/**
 * Load media from URLs, lay them out around the provided anchor, then optionally select and fit.
 */
export async function addUrlsToCanvas(
  urls: string[],
  addEntity: AddEntityFn,
  container: HTMLElement,
  options: ImportPlacementOptions,
): Promise<string[]> {
  if (urls.length === 0) return [];

  const results = await Promise.allSettled(urls.map((url) => loadUrlForCanvas(url)));
  const loaded: LoadedEntity[] = [];

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      loaded.push(result.value);
    } else if (result.status === "rejected") {
      logger.error("Failed to load media from URL:", result.reason);
    }
  }

  return placeLoadedEntities(loaded, addEntity, container, options);
}

/**
 * Load media from a URL, add to canvas, and return the new entity ID.
 */
export async function addUrlToCanvas(
  url: string,
  addEntity: AddEntityFn,
  container: HTMLElement,
  options: ImportPlacementOptions,
): Promise<string | null> {
  try {
    const entityIds = await addUrlsToCanvas([url], addEntity, container, options);
    return entityIds[0] ?? null;
  } catch (err) {
    logger.error("Failed to load media from URL:", err);
    return null;
  }
}
