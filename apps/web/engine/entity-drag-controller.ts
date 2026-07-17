import { SNAP_GRID_SIZE, snapToGrid } from "#lib/canvas-math.ts";
import { DragTargetType, type Point } from "#types/canvas.ts";
import type { AnimationHandle, AnimationScheduler } from "#lib/animation-scheduler.ts";
import { canvasStore } from "./canvas-store.ts";

export type EntityDragTarget = { type: DragTargetType; entityId?: string } | null;

export class EntityDragController {
  readonly #scheduler: AnimationScheduler;
  #dragTarget: EntityDragTarget = null;
  #snapAccumulator: Point | null = null;
  #dragCatchUpHandle: AnimationHandle | null = null;
  #snapSettleHandle: AnimationHandle | null = null;
  #springEntityIds: ReadonlySet<string> | null = null;
  readonly #moveDelta: Point = { x: 0, y: 0 };
  readonly #transientOffset: Point = { x: 0, y: 0 };
  #transientEntityIds: ReadonlySet<string> | null = null;

  constructor(scheduler: AnimationScheduler) {
    this.#scheduler = scheduler;
  }

  get target(): EntityDragTarget {
    return this.#dragTarget;
  }

  setTarget(target: EntityDragTarget): void {
    if (target !== this.#dragTarget) this.commitTransientTranslation();
    this.#dragTarget = target;
  }

  clear(): void {
    this.commitTransientTranslation();
    this.#dragTarget = null;
    this.#snapAccumulator = null;
  }

  cancel(): void {
    this.#dragCatchUpHandle?.cancel();
    this.#snapSettleHandle?.cancel();
    this.#dragCatchUpHandle = null;
    this.#snapSettleHandle = null;
    this.#dragTarget = null;
    this.#snapAccumulator = null;
    this.#springEntityIds = null;
    this.#transientEntityIds = null;
    this.#transientOffset.x = 0;
    this.#transientOffset.y = 0;
    canvasStore.resetTransientEntityDragOffset();
  }

  startSpringTracking(entityIds: ReadonlySet<string>): void {
    this.#springEntityIds = new Set(entityIds);
  }

  hasActiveSpring(): boolean {
    return this.#dragCatchUpHandle?.isActive === true || this.#snapSettleHandle?.isActive === true;
  }

  isSnapSettleActive(): boolean {
    return this.#snapSettleHandle?.isActive === true;
  }

  cancelSnapSettleAndResetSnap(): void {
    this.#snapSettleHandle?.cancel();
    this.#snapAccumulator = null;
  }

  clearSpringTrackingIfIdle(): void {
    if (!this.hasActiveSpring()) {
      this.#springEntityIds = null;
    }
  }

  startCatchUp(offset: Point, response: number, damping: number): void {
    this.#dragCatchUpHandle?.cancel();
    this.#dragCatchUpHandle = this.#scheduler.spring2D({
      offset,
      velocity: { x: 0, y: 0 },
      response,
      damping,
      settleThreshold: canvasStore.getState().snapToGrid ? 1 : undefined,
      tag: "drag-catchup",
      onUpdate: (dx, dy) => this.moveRaw(dx, dy),
      onComplete: (flushX, flushY) => {
        this.moveRaw(flushX, flushY);
        if (canvasStore.getState().snapToGrid) {
          this.#initSnapSettle();
        }
      },
    });
  }

  moveRaw(dx: number, dy: number): void {
    this.#moveDelta.x = dx;
    this.#moveDelta.y = dy;
    if (this.#dragTarget?.type === DragTargetType.multiSelection) {
      this.#moveSelectedTransientOrCommitted(canvasStore.getSelectedEntityIds(), this.#moveDelta);
    } else if (this.#dragTarget?.type === DragTargetType.entity && this.#dragTarget.entityId) {
      this.#moveEntityTransientOrCommitted(this.#dragTarget.entityId, this.#moveDelta);
    } else if (this.#springEntityIds) {
      this.commitTransientTranslation();
      canvasStore.moveEntities(this.#springEntityIds, this.#moveDelta);
    }
  }

  moveTarget(delta: Point): void {
    if (this.#dragTarget?.type === DragTargetType.multiSelection) {
      this.moveSelected(delta);
    } else if (this.#dragTarget?.type === DragTargetType.entity && this.#dragTarget.entityId) {
      const selectedIds = canvasStore.getSelectedEntityIds();
      if (selectedIds.size === 1 && selectedIds.has(this.#dragTarget.entityId)) {
        this.moveSelected(delta);
      } else if (canvasStore.getState().snapToGrid) {
        this.#moveEntitySnapped(this.#dragTarget.entityId, delta);
      } else {
        canvasStore.moveEntity(this.#dragTarget.entityId, delta);
      }
    }
  }

  moveSelected(delta: Point): void {
    const state = canvasStore.getState();
    const selectedIds = canvasStore.getSelectedEntityIds();

    if (state.snapToGrid) {
      const anchorId = selectedIds.values().next().value;
      if (!anchorId) return;
      const anchor = state.entities.get(anchorId);
      if (!anchor) return;
      if (!this.#snapAccumulator) this.#snapAccumulator = { ...anchor.position };
      this.#snapAccumulator.x += delta.x;
      this.#snapAccumulator.y += delta.y;
      const snapped = snapToGrid(this.#snapAccumulator, SNAP_GRID_SIZE);
      const offset = canvasStore.getTransientEntityDragOffset();
      const snappedDelta = {
        x: snapped.x - (anchor.position.x + offset.x),
        y: snapped.y - (anchor.position.y + offset.y),
      };
      if (snappedDelta.x === 0 && snappedDelta.y === 0) return;
      this.#moveSelectedTransientOrCommitted(selectedIds, snappedDelta);
      return;
    }

    this.#moveSelectedTransientOrCommitted(selectedIds, delta);
  }

  commitTransientTranslation(): void {
    const entityIds = this.#transientEntityIds;
    if (!entityIds) return;
    canvasStore.resetTransientEntityDragOffset();
    canvasStore.moveEntities(entityIds, this.#transientOffset);
    this.#transientOffset.x = 0;
    this.#transientOffset.y = 0;
    this.#transientEntityIds = null;
  }

  #moveSelectedTransientOrCommitted(selectedIds: ReadonlySet<string>, delta: Point): void {
    if (selectedIds.size === 0) return;
    this.#transientEntityIds ??= selectedIds;
    this.#transientOffset.x += delta.x;
    this.#transientOffset.y += delta.y;
    canvasStore.setTransientEntityDragOffset(this.#transientOffset);
  }

  #moveEntityTransientOrCommitted(entityId: string, delta: Point): void {
    const selectedIds = canvasStore.getSelectedEntityIds();
    if (selectedIds.size === 1 && selectedIds.has(entityId)) {
      this.#moveSelectedTransientOrCommitted(selectedIds, delta);
      return;
    }
    canvasStore.moveEntity(entityId, delta);
  }

  #moveEntitySnapped(entityId: string, delta: Point): void {
    const entity = canvasStore.getState().entities.get(entityId);
    if (!entity) return;
    if (!this.#snapAccumulator) this.#snapAccumulator = { ...entity.position };
    this.#snapAccumulator.x += delta.x;
    this.#snapAccumulator.y += delta.y;
    const snapped = snapToGrid(this.#snapAccumulator, SNAP_GRID_SIZE);
    const snappedDelta = { x: snapped.x - entity.position.x, y: snapped.y - entity.position.y };
    if (snappedDelta.x === 0 && snappedDelta.y === 0) return;
    canvasStore.moveEntity(entityId, snappedDelta);
  }

  #getAnchorEntityId(): string | undefined {
    if (this.#dragTarget?.type === DragTargetType.multiSelection) {
      return canvasStore.getSelectedEntityIds().values().next().value;
    }
    if (this.#dragTarget?.type === DragTargetType.entity) return this.#dragTarget.entityId;
    return this.#springEntityIds?.values().next().value;
  }

  #initSnapSettle(): void {
    const anchorId = this.#getAnchorEntityId();
    if (!anchorId) return;
    const anchor = canvasStore.getState().entities.get(anchorId);
    if (!anchor) return;
    const snapped = snapToGrid(anchor.position, SNAP_GRID_SIZE);
    const dx = snapped.x - anchor.position.x;
    const dy = snapped.y - anchor.position.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      this.#snapAccumulator = { ...snapped };
      this.#springEntityIds = null;
      return;
    }
    this.#snapSettleHandle?.cancel();
    this.#snapSettleHandle = this.#scheduler.spring2D({
      offset: { x: dx, y: dy },
      velocity: { x: 0, y: 0 },
      response: 0.1,
      damping: 0.9,
      tag: "snap-settle",
      onUpdate: (sdx, sdy) => this.moveRaw(sdx, sdy),
      onComplete: (flushX, flushY) => {
        this.moveRaw(flushX, flushY);
        const settleAnchorId = this.#getAnchorEntityId();
        if (settleAnchorId) {
          const settleAnchor = canvasStore.getState().entities.get(settleAnchorId);
          if (settleAnchor) this.#snapAccumulator = { ...settleAnchor.position };
        }
        this.#springEntityIds = null;
      },
    });
  }
}
