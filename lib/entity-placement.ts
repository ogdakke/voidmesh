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

/**
 * Calculate grid positions for multiple entities.
 * Uses uniform cell sizes based on the largest entity dimensions.
 * Entities are centered within their cells.
 * Grid is centered around the provided anchor point.
 */
export function calculateGridPositions(
  sizes: Size[],
  anchor: Point,
  options?: { gap?: number; maxColumns?: number },
): Point[] {
  const gap = options?.gap ?? config.canvas.gridGap;
  const maxColumns = options?.maxColumns ?? config.canvas.maxGridColumns;

  if (sizes.length === 0) return [];

  if (sizes.length === 1) {
    return [
      {
        x: anchor.x - sizes[0]!.width / 2,
        y: anchor.y - sizes[0]!.height / 2,
      },
    ];
  }

  // Find max dimensions for uniform cell sizing
  let maxWidth = 0;
  let maxHeight = 0;
  for (const size of sizes) {
    maxWidth = Math.max(maxWidth, size.width);
    maxHeight = Math.max(maxHeight, size.height);
  }

  const columns = Math.min(maxColumns, sizes.length);
  const rows = Math.ceil(sizes.length / columns);

  // Total grid dimensions (cells + gaps between them)
  const totalWidth = columns * maxWidth + (columns - 1) * gap;
  const totalHeight = rows * maxHeight + (rows - 1) * gap;

  // Grid top-left so grid is centered on anchor
  const gridOriginX = anchor.x - totalWidth / 2;
  const gridOriginY = anchor.y - totalHeight / 2;

  return sizes.map((size, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);

    // Cell top-left position
    const cellX = gridOriginX + col * (maxWidth + gap);
    const cellY = gridOriginY + row * (maxHeight + gap);

    // Center entity within cell
    return {
      x: cellX + (maxWidth - size.width) / 2,
      y: cellY + (maxHeight - size.height) / 2,
    };
  });
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

  const positions = calculateGridPositions(
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
