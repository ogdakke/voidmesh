import { config, type DragVisualSpringConfig } from "#config";
import { canvasStore } from "./canvas-store.ts";
import {
  scheduler as defaultScheduler,
  type AnimationScheduler,
  type AnimationHandle,
} from "#lib/animation-scheduler.ts";

const enum DragVisualPhase {
  idle,
  possibleDrag,
  dragging,
  releasing,
}

/**
 * Entity drag visual feedback controller.
 * Manages spring-based scale animations for drag gestures.
 * Self-registers with AnimationScheduler (no external tick() needed).
 *
 * Phases:
 *   idle → possibleDrag → dragging → releasing → idle
 *
 * During possibleDrag, the touched entity scales down (spring).
 * On drag activation, all selected entities pop back to normal size (spring with overshoot).
 * On release, entities spring back to exactly 1.0.
 */
class EntityDragVisualController {
  #scheduler: AnimationScheduler;
  #phase = DragVisualPhase.idle;
  #currentScale = 1;
  #targetScale = 1;
  #possibleDragTimerId: ReturnType<typeof setTimeout> | null = null;
  #handle: AnimationHandle | null = null;
  /** Entity IDs with active visual (single entity during possibleDrag, full selection during drag) */
  #entityIds = new Set<string>();

  static readonly #SETTLE_THRESHOLD = 0.0001;

  constructor(scheduler: AnimationScheduler) {
    this.#scheduler = scheduler;
  }

  /** Get visual scale for an entity. Returns 1.0 if entity has no active visual. */
  getScale(entityId: string): number {
    return this.#entityIds.has(entityId) ? this.#currentScale : 1;
  }

  /** Whether any drag visual animation is active. */
  isActive(): boolean {
    return this.#phase !== DragVisualPhase.idle;
  }

  /** Whether we're specifically in the dragging phase (for label state). */
  isDragPhase(): boolean {
    return this.#phase === DragVisualPhase.dragging;
  }

  /**
   * Begin possible-drag phase. Starts a delay timer before the scale-down animation.
   * Called on touch/pointer down when an entity is hit.
   */
  startPossibleDrag(
    entityIds: ReadonlySet<string>,
    { directToDrag = false, delay }: { directToDrag?: boolean; delay?: number } = {},
  ): void {
    // Reset any in-progress animation
    this.#clearTimer();
    this.#cancelAnimation();
    this.#currentScale = 1;
    this.#targetScale = 1;
    this.#entityIds.clear();
    for (const id of entityIds) {
      this.#entityIds.add(id);
    }

    const timeout = delay ?? config.touch.dragVisual.possibleDragDelay;
    this.#possibleDragTimerId = setTimeout(() => {
      this.#possibleDragTimerId = null;
      if (directToDrag) {
        // Desktop: skip scale-down, go directly to dragging phase
        this.#phase = DragVisualPhase.dragging;
        canvasStore.setContainerDirty();
      } else {
        this.#activatePossibleDrag();
      }
    }, timeout);
    // Phase stays idle until timer fires — no visual change during delay
    this.#phase = DragVisualPhase.idle;
    canvasStore.setContainerDirty();
  }

  /**
   * Transition to full drag phase. Pops entities back to normal size with spring overshoot.
   * Called when drag actually activates (long-press on mobile, first movement on desktop).
   */
  activateDrag(selectedEntityIds: ReadonlySet<string>): void {
    this.#clearTimer();

    // Expand tracked entities to the full selection
    this.#entityIds.clear();
    for (const id of selectedEntityIds) {
      this.#entityIds.add(id);
    }

    // Pop-back: animate from current scale to 1.0
    this.#targetScale = 1;
    this.#phase = DragVisualPhase.dragging;
    canvasStore.setContainerDirty();
    this.#registerAnimation(config.touch.dragVisual.popBackSpring);
  }

  /**
   * Begin release animation. Springs back to 1.0 from current scale.
   * Called when drag ends (finger lift or pointer up).
   */
  release(): void {
    this.#clearTimer();

    if (this.#phase === DragVisualPhase.idle) return;

    const distance = this.#currentScale - 1;

    // Already at 1.0 and no velocity — skip animation
    if (Math.abs(distance) < EntityDragVisualController.#SETTLE_THRESHOLD) {
      this.#phase = DragVisualPhase.idle;
      this.#currentScale = 1;
      this.#targetScale = 1;
      this.#entityIds.clear();
      this.#cancelAnimation();
      // Force a render frame so the label can clean up its drag mode class
      canvasStore.setContainerDirty();
      return;
    }

    this.#targetScale = 1;
    this.#phase = DragVisualPhase.releasing;
    this.#registerAnimation(config.touch.dragVisual.releaseSpring);
  }

  /** Immediately reset to idle. Called when gesture is cancelled (pan, multi-touch, etc.). */
  cancel(): void {
    this.#clearTimer();
    const wasActive = this.#phase !== DragVisualPhase.idle;
    this.#phase = DragVisualPhase.idle;
    this.#currentScale = 1;
    this.#targetScale = 1;
    this.#entityIds.clear();
    this.#cancelAnimation();
    // Force a render frame so entities return to normal scale and label cleans up
    if (wasActive) {
      canvasStore.setContainerDirty();
    }
  }

  #activatePossibleDrag(): void {
    this.#possibleDragTimerId = null;

    const { scaleDown, scaleDownSpring } = config.touch.dragVisual;

    // Animate from 1.0 down to scaleDown target
    this.#targetScale = scaleDown;
    this.#phase = DragVisualPhase.possibleDrag;
    this.#registerAnimation(scaleDownSpring);
  }

  #registerAnimation(springConfig: DragVisualSpringConfig): void {
    this.#cancelAnimation();
    const targetScale = this.#targetScale;
    this.#handle = this.#scheduler.spring({
      tag: "drag-visual",
      from: this.#currentScale,
      to: targetScale,
      response: springConfig.response,
      damping: springConfig.damping,
      settleThreshold: EntityDragVisualController.#SETTLE_THRESHOLD,
      onUpdate: (value) => {
        this.#currentScale = Math.max(0.8, Math.min(value, 1.05));
        canvasStore.setContainerDirty();
      },
      onComplete: () => {
        this.#currentScale = targetScale;
        this.#handle = null;
        if (this.#phase === DragVisualPhase.releasing) {
          this.#phase = DragVisualPhase.idle;
          this.#entityIds.clear();
          canvasStore.setContainerDirty();
        }
      },
    });
  }

  #cancelAnimation(): void {
    this.#handle?.cancel();
    this.#handle = null;
  }

  #clearTimer(): void {
    if (this.#possibleDragTimerId !== null) {
      clearTimeout(this.#possibleDragTimerId);
      this.#possibleDragTimerId = null;
    }
  }
}

/** Singleton instance */
export const entityDragVisual = new EntityDragVisualController(defaultScheduler);
