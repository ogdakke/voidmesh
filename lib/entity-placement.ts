import type { Point, Size, ShaderCanvasEntity } from "#types/canvas.ts";
import {
  calculateFitToView,
  getViewportCenter,
  easings,
  snapToGrid,
  SNAP_GRID_SIZE,
} from "./canvas-math.ts";
import { canvasStore } from "../engine/canvas-store.ts";
import { viewportAnimation } from "../engine/viewport-animation.ts";
import { gameLoop } from "../engine/game-loop.ts";
import { loadMediaFile, loadMediaFromBlob } from "./media-loader.ts";
import { config } from "./config/index.ts";
import { logger } from "./client.logger.ts";

type EntityData = Omit<ShaderCanvasEntity, "id" | "zIndex" | "name"> & { name?: string };
type AddEntityFn = (entity: EntityData, filename?: string) => string;

interface LayoutOptions {
  gap: number;
  maxColumns: number;
}

export type LayoutAlgorithm = (sizes: Size[], options: LayoutOptions) => Point[];

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

/**
 * Load files, lay them out in a grid, add to canvas, select all, and fit-to-view.
 */
export async function addFilesToCanvas(
  files: File[],
  addEntity: AddEntityFn,
  container: HTMLElement,
  bottomInset: number = 0,
): Promise<string[]> {
  if (files.length === 0) return [];

  // 1. Load all files in parallel (position at origin, will be repositioned)
  const results = await Promise.allSettled(files.map((file) => loadMediaFile(file)));

  // 2. Collect successful loads (preserve original order)
  const loaded: { data: EntityData; filename: string }[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled" && result.value) {
      loaded.push({ data: result.value, filename: files[i]!.name });
    }
  }

  if (loaded.length === 0) return [];

  // 3. Calculate grid positions centered at viewport center
  const viewport = canvasStore.getViewport();
  const rect = container.getBoundingClientRect();
  const centerWorld = getViewportCenter(viewport, rect, window.devicePixelRatio);

  const positions = calculateLayout(
    loaded.map((l) => l.data.size),
    centerWorld,
  );

  // 4. Add entities with calculated positions (snap if enabled)
  const snapEnabled = canvasStore.getState().snapToGrid;
  const entityIds: string[] = [];
  for (let i = 0; i < loaded.length; i++) {
    loaded[i]!.data.position = snapEnabled
      ? snapToGrid(positions[i]!, SNAP_GRID_SIZE)
      : positions[i]!;
    const id = addEntity(loaded[i]!.data, loaded[i]!.filename);
    entityIds.push(id);
  }

  // 5. Select all new entities and fit-to-view
  canvasStore.replaceSelection(entityIds);
  fitEntitiesToView(entityIds, container, bottomInset);

  return entityIds;
}

/**
 * Load an image from a URL, add to canvas, select, and fit-to-view.
 */
export async function addUrlToCanvas(
  url: string,
  addEntity: AddEntityFn,
  container: HTMLElement,
  bottomInset: number = 0,
): Promise<string | null> {
  try {
    const response = await fetch(url);
    const blob = await response.blob();

    // Resolve MIME type: prefer Content-Type header, fall back to blob.type
    const rawContentType = response.headers.get("content-type") ?? "";
    const mimeType = (rawContentType.split(";")[0]?.trim() || blob.type).toLowerCase();

    // Extract filename from URL
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

    // Calculate centered position
    const viewport = canvasStore.getViewport();
    const rect = container.getBoundingClientRect();
    const centerWorld = getViewportCenter(viewport, rect, window.devicePixelRatio);

    let position: Point = {
      x: centerWorld.x - entityData.size.width / 2,
      y: centerWorld.y - entityData.size.height / 2,
    };
    if (canvasStore.getState().snapToGrid) {
      position = snapToGrid(position, SNAP_GRID_SIZE);
    }
    entityData.position = position;

    const entityId = addEntity(entityData, filename);

    canvasStore.replaceSelection([entityId]);
    fitEntitiesToView([entityId], container, bottomInset);

    return entityId;
  } catch (err) {
    logger.error("Failed to load media from URL:", err);
    return null;
  }
}
