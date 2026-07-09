import { logger } from "#lib/client.logger.ts";
import { boundsIntersect, createBounds } from "#lib/canvas-math.ts";
import { DragTargetType, isAnimatedEntity, type Bounds, type Point } from "#types/canvas.ts";
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
  isInMultiSelectMode(): boolean {
    return canvasStore.getState().multiSelectMode;
  }

  findEntityAtPoint(worldPoint: Point, state: CanvasState): string | null {
    return findEntityAtPoint(worldPoint, state);
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
    const state = canvasStore.getState();
    const selectionRect = this.computeDragSelectBounds(dragSelect);
    const entitiesInRect = this.#findEntitiesIntersectingBounds(selectionRect, state);

    let newSelection: Set<string>;
    switch (dragSelect.mode) {
      case "additive":
        newSelection = new Set(dragSelect.previousSelection);
        for (const entityId of entitiesInRect) {
          newSelection.add(entityId);
        }
        break;
      case "subtractive":
        newSelection = new Set(dragSelect.previousSelection);
        for (const entityId of entitiesInRect) {
          newSelection.delete(entityId);
        }
        break;
      case "replace":
      default:
        newSelection = new Set(entitiesInRect);
        break;
    }

    if (!this.#setsEqual(newSelection, canvasStore.getSelectedEntityIds())) {
      canvasStore.replaceSelection([...newSelection]);
    }
  }

  computeDragSelectBounds(dragSelect: DragSelectState): Bounds {
    const { startPoint, currentPoint } = dragSelect;
    return {
      x: Math.min(startPoint.x, currentPoint.x),
      y: Math.min(startPoint.y, currentPoint.y),
      width: Math.abs(currentPoint.x - startPoint.x),
      height: Math.abs(currentPoint.y - startPoint.y),
    };
  }

  computeMultiSelectBounds(state: CanvasState): Bounds | null {
    return this.#computeBoundsForEntityIds(state.selectedEntityIds, state);
  }

  getMultiSelectBounds(
    dragSelect: DragSelectState | null,
    isActionLayerActive: boolean,
    dragVisual: DragVisualBoundsPort,
  ): Bounds | null {
    if (isActionLayerActive) return null;

    if (dragSelect?.isActive && dragSelect.mode === "subtractive") {
      return this.#computeBoundsForEntityIds(new Set(canvasStore.getSelectedEntityIds()));
    }

    if (dragSelect?.isActive) return null;

    const selectedIds = canvasStore.getSelectedEntityIds();
    if (selectedIds.size <= 1) return null;

    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return null;

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    const isDragVisualActive = dragVisual.isActive();

    for (const entity of entities) {
      if (isDragVisualActive) {
        const scale = dragVisual.getScale(entity.id);
        const offsetX = ((1 - scale) * entity.size.width) / 2;
        const offsetY = ((1 - scale) * entity.size.height) / 2;
        minX = Math.min(minX, entity.position.x + offsetX);
        minY = Math.min(minY, entity.position.y + offsetY);
        maxX = Math.max(maxX, entity.position.x + offsetX + entity.size.width * scale);
        maxY = Math.max(maxY, entity.position.y + offsetY + entity.size.height * scale);
      } else {
        minX = Math.min(minX, entity.position.x);
        minY = Math.min(minY, entity.position.y);
        maxX = Math.max(maxX, entity.position.x + entity.size.width);
        maxY = Math.max(maxY, entity.position.y + entity.size.height);
      }
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
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

  #findEntitiesIntersectingBounds(bounds: Bounds, state: CanvasState): string[] {
    const result: string[] = [];

    for (const [id, entity] of state.entities) {
      if (entity.locked) continue;

      const entityBounds = createBounds(entity.position, entity.size);
      if (boundsIntersect(bounds, entityBounds)) {
        result.push(id);
      }
    }

    return result;
  }

  #computeBoundsForEntityIds(
    entityIds: ReadonlySet<string>,
    state = canvasStore.getState(),
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

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  #setsEqual<T>(a: Set<T>, b: ReadonlySet<T>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }
}
