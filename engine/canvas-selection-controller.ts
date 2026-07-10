import { logger } from "#lib/client.logger.ts";
import {
  DragTargetType,
  isAnimatedEntity,
  type Bounds,
  type Point,
  type ShaderCanvasEntity,
} from "#types/canvas.ts";
import { canvasStore, type CanvasState } from "./canvas-store.ts";
import type { EntityDragTarget } from "./entity-drag-controller.ts";
import { findEntityAtPoint } from "./canvas-hit-testing.ts";

export type DragSelectMode = "replace" | "additive" | "subtractive";

export interface DragSelectState {
  isActive: boolean;
  startPoint: Point;
  currentPoint: Point;
  mode: DragSelectMode;
  previousSelection: Set<string>;
}

interface DragVisualBoundsPort {
  isActive(): boolean;
  getScale(entityId: string): number;
}

export class CanvasSelectionController {
  readonly #spatialQueryEntities: ShaderCanvasEntity[] = [];
  readonly #spatialQueryBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #dragSelectionBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #multiSelectionBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #cachedMultiSelectionBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #intersectingEntityIds: string[] = [];
  #nextSelection = new Set<string>();
  #cachedBoundsEntityIds: ReadonlySet<string> | null = null;
  #cachedBoundsEntityVersion = -1;
  #cachedBoundsGeometryVersion = -1;
  #cachedBoundsHasValue = false;

  isInMultiSelectMode(): boolean {
    return canvasStore.getState().multiSelectMode;
  }

  findEntityAtPoint(worldPoint: Point, _state: CanvasState): string | null {
    const bounds = this.#spatialQueryBounds;
    bounds.x = worldPoint.x;
    bounds.y = worldPoint.y;
    bounds.width = 0;
    bounds.height = 0;
    const candidates = canvasStore.queryEntitiesInBounds(bounds, this.#spatialQueryEntities);
    return findEntityAtPoint(worldPoint, candidates);
  }

  createDragSelect(worldPoint: Point, shiftKey: boolean, state: CanvasState): DragSelectState {
    const hasExistingSelection = state.selectedEntityIds.size > 0;
    let mode: DragSelectMode;
    if (!shiftKey) {
      mode = "replace";
    } else if (hasExistingSelection) {
      mode = "subtractive";
    } else {
      mode = "additive";
    }

    if (mode === "replace") {
      canvasStore.clearSelection();
    }

    return {
      isActive: true,
      startPoint: worldPoint,
      currentPoint: worldPoint,
      mode,
      previousSelection: new Set(state.selectedEntityIds),
    };
  }

  updateDragSelection(dragSelect: DragSelectState): void {
    const selectionRect = this.computeDragSelectBounds(dragSelect);
    const entitiesInRect = this.#findEntitiesIntersectingBounds(selectionRect);

    const newSelection = this.#nextSelection;
    newSelection.clear();
    switch (dragSelect.mode) {
      case "additive":
        for (const entityId of dragSelect.previousSelection) newSelection.add(entityId);
        for (const entityId of entitiesInRect) {
          newSelection.add(entityId);
        }
        break;
      case "subtractive":
        for (const entityId of dragSelect.previousSelection) newSelection.add(entityId);
        for (const entityId of entitiesInRect) {
          newSelection.delete(entityId);
        }
        break;
      case "replace":
      default:
        for (const entityId of entitiesInRect) newSelection.add(entityId);
        break;
    }

    if (!this.#setsEqual(newSelection, canvasStore.getSelectedEntityIds())) {
      this.#nextSelection = canvasStore.replaceTransientSelection(newSelection);
    }
  }

  computeDragSelectBounds(dragSelect: DragSelectState): Bounds {
    const { startPoint, currentPoint } = dragSelect;
    const bounds = this.#dragSelectionBounds;
    bounds.x = Math.min(startPoint.x, currentPoint.x);
    bounds.y = Math.min(startPoint.y, currentPoint.y);
    bounds.width = Math.abs(currentPoint.x - startPoint.x);
    bounds.height = Math.abs(currentPoint.y - startPoint.y);
    return bounds;
  }

  computeMultiSelectBounds(state: CanvasState): Bounds | null {
    return this.#getCachedBoundsForEntityIds(state.selectedEntityIds, state);
  }

  getMultiSelectBounds(
    dragSelect: DragSelectState | null,
    isActionLayerActive: boolean,
    dragVisual: DragVisualBoundsPort,
  ): Bounds | null {
    if (isActionLayerActive) return null;

    if (dragSelect?.isActive && dragSelect.mode === "subtractive") {
      const state = canvasStore.getState();
      return this.#getCachedBoundsForEntityIds(state.selectedEntityIds, state);
    }

    if (dragSelect?.isActive) return null;

    const selectedIds = canvasStore.getSelectedEntityIds();
    if (selectedIds.size <= 1) return null;

    const isDragVisualActive = dragVisual.isActive();
    if (!isDragVisualActive) {
      const state = canvasStore.getState();
      return this.#getCachedBoundsForEntityIds(selectedIds, state);
    }

    const entities = canvasStore.getSelectedEntitiesStable();

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const entity of entities) {
      const scale = dragVisual.getScale(entity.id);
      const offsetX = ((1 - scale) * entity.size.width) / 2;
      const offsetY = ((1 - scale) * entity.size.height) / 2;
      minX = Math.min(minX, entity.position.x + offsetX);
      minY = Math.min(minY, entity.position.y + offsetY);
      maxX = Math.max(maxX, entity.position.x + offsetX + entity.size.width * scale);
      maxY = Math.max(maxY, entity.position.y + offsetY + entity.size.height * scale);
    }

    return this.#setMultiSelectionBounds(minX, minY, maxX, maxY);
  }

  choosePointerDownEntityTarget(
    entityId: string,
    shiftKey: boolean,
    state: CanvasState,
  ): EntityDragTarget {
    if (this.isInMultiSelectMode() || shiftKey) {
      canvasStore.toggleSelection(entityId);
      return { type: DragTargetType.entity, entityId };
    }

    if (state.selectedEntityIds.has(entityId) && state.selectedEntityIds.size > 1) {
      return { type: DragTargetType.multiSelection };
    }

    canvasStore.replaceSelection([entityId]);
    return { type: DragTargetType.entity, entityId };
  }

  getDragEntityIds(entityId: string): ReadonlySet<string> {
    const state = canvasStore.getState();
    return state.selectedEntityIds.has(entityId) && state.selectedEntityIds.size > 1
      ? state.selectedEntityIds
      : new Set([entityId]);
  }

  handlePointerEntityClick(
    entityId: string,
    state: CanvasState,
    pointerDownWasSelected: boolean,
  ): void {
    if (
      pointerDownWasSelected &&
      state.selectedEntityIds.size > 1 &&
      state.selectedEntityIds.has(entityId)
    ) {
      canvasStore.replaceSelection([entityId]);
    } else if (pointerDownWasSelected) {
      const entity = state.entities.get(entityId);
      if (entity && isAnimatedEntity(entity)) {
        canvasStore.togglePlayback(entityId).catch((error) => logger.error(error));
      }
    }
  }

  handleContextMenuEntity(entityId: string, state: CanvasState): void {
    if (!state.selectedEntityIds.has(entityId)) {
      canvasStore.setSelectedEntity(entityId);
    }
    canvasStore.setContextOpenEntity(entityId);
  }

  handleContextMenuEmpty(): void {
    canvasStore.setSelectedEntity(null);
    canvasStore.setContextOpenEntity(null);
  }

  selectForLongPress(entityId: string): EntityDragTarget {
    const state = canvasStore.getState();
    if (this.isInMultiSelectMode() && !state.selectedEntityIds.has(entityId)) {
      canvasStore.addToSelection(entityId);
    }

    const currentState = canvasStore.getState();
    if (
      !(currentState.selectedEntityIds.has(entityId) && currentState.selectedEntityIds.size > 1)
    ) {
      if (!currentState.selectedEntityIds.has(entityId)) {
        canvasStore.replaceSelection([entityId]);
      }
    }

    const afterSelectState = canvasStore.getState();
    if (
      afterSelectState.selectedEntityIds.has(entityId) &&
      afterSelectState.selectedEntityIds.size > 1
    ) {
      return { type: DragTargetType.multiSelection };
    }
    return { type: DragTargetType.entity, entityId };
  }

  handleTouchSingleTap(
    entityId: string | null,
    tappedEntityId: string | null,
    downEntityId: string | null,
  ): void {
    if (this.isInMultiSelectMode()) {
      if (entityId) {
        canvasStore.toggleSelection(entityId);
      }
      return;
    }

    if (entityId) {
      if (canvasStore.getSelectionCount() > 1) {
        canvasStore.replaceSelection([entityId]);
      } else {
        canvasStore.replaceSelection([entityId]);
      }
    } else if (!tappedEntityId && !downEntityId) {
      canvasStore.clearSelection();
    }
  }

  scheduleTouchPlaybackToggle(
    entityId: string,
    delay: number,
    onTimerComplete: () => void,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      onTimerComplete();
      const entity = canvasStore.getState().entities.get(entityId);
      if (entity && isAnimatedEntity(entity)) {
        canvasStore.togglePlayback(entityId).catch((error) => logger.error(error));
      }
    }, delay);
  }

  #findEntitiesIntersectingBounds(bounds: Bounds): string[] {
    const result = this.#intersectingEntityIds;
    result.length = 0;
    const candidates = canvasStore.queryEntitiesInBoundsUnordered(
      bounds,
      this.#spatialQueryEntities,
    );
    for (const entity of candidates) {
      if (entity.locked) continue;
      result.push(entity.id);
    }

    return result;
  }

  #computeBoundsForEntityIds(
    entityIds: ReadonlySet<string>,
    state = canvasStore.getState(),
    output = this.#multiSelectionBounds,
  ): Bounds | null {
    if (entityIds.size <= 1) return null;

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;
    let count = 0;

    for (const id of entityIds) {
      const entity = state.entities.get(id);
      if (!entity) continue;
      minX = Math.min(minX, entity.position.x);
      minY = Math.min(minY, entity.position.y);
      maxX = Math.max(maxX, entity.position.x + entity.size.width);
      maxY = Math.max(maxY, entity.position.y + entity.size.height);
      count++;
    }

    if (count < 2) return null;

    return this.#setBounds(output, minX, minY, maxX, maxY);
  }

  #setMultiSelectionBounds(minX: number, minY: number, maxX: number, maxY: number): Bounds {
    return this.#setBounds(this.#multiSelectionBounds, minX, minY, maxX, maxY);
  }

  #getCachedBoundsForEntityIds(entityIds: ReadonlySet<string>, state: CanvasState): Bounds | null {
    if (
      this.#cachedBoundsEntityIds === entityIds &&
      this.#cachedBoundsEntityVersion === state.entityVersion &&
      this.#cachedBoundsGeometryVersion === state.geometryVersion
    ) {
      return this.#cachedBoundsHasValue ? this.#cachedMultiSelectionBounds : null;
    }

    const bounds = this.#computeBoundsForEntityIds(
      entityIds,
      state,
      this.#cachedMultiSelectionBounds,
    );
    this.#cachedBoundsEntityIds = entityIds;
    this.#cachedBoundsEntityVersion = state.entityVersion;
    this.#cachedBoundsGeometryVersion = state.geometryVersion;
    this.#cachedBoundsHasValue = bounds !== null;
    return bounds;
  }

  #setBounds(bounds: Bounds, minX: number, minY: number, maxX: number, maxY: number): Bounds {
    bounds.x = minX;
    bounds.y = minY;
    bounds.width = maxX - minX;
    bounds.height = maxY - minY;
    return bounds;
  }

  #setsEqual<T>(a: Set<T>, b: ReadonlySet<T>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }
}
