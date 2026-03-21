import { SpringBack } from "../lib/touch-scroll/spring-back.ts";
import { config } from "../lib/config/index.ts";
import { canvasStore } from "./canvas-store.ts";
import {
  scheduler as defaultScheduler,
  type AnimationScheduler,
  type AnimationHandle,
} from "../lib/animation-scheduler.ts";

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
  #phase = DragVisualPhase.idle as DragVisualPhase;
  #spring = new SpringBack();
  #springStartTime = 0;
  #currentScale = 1;
  #targetScale = 1;
  #possibleDragTimerId: ReturnType<typeof setTimeout> | null = null;
  #handle: AnimationHandle | null = null;
  /** Entity IDs with active visual (single entity during possibleDrag, full selection during drag) */
  #entityIds = new Set<string>();

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
    this.#spring.reset();
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

    // Get current spring velocity if mid-animation
    const currentVelocity = this.#getSpringVelocity();

    // Pop-back: animate from current scale to 1.0
    this.#targetScale = 1;
    const distance = this.#currentScale - 1;
    this.#spring.absorb(currentVelocity, distance, config.touch.dragVisual.popBackSpring);
    this.#springStartTime = performance.now();
    this.#phase = DragVisualPhase.dragging;
    this.#registerAnimation();
  }

  /**
   * Begin release animation. Springs back to 1.0 from current scale.
   * Called when drag ends (finger lift or pointer up).
   */
  release(): void {
    this.#clearTimer();

    if (this.#phase === DragVisualPhase.idle) return;

    const currentVelocity = this.#getSpringVelocity();
    const distance = this.#currentScale - 1;

    // Already at 1.0 and no velocity — skip animation
    if (Math.abs(distance) < 0.001 && Math.abs(currentVelocity) < 0.001) {
      this.#phase = DragVisualPhase.idle;
      this.#currentScale = 1;
      this.#targetScale = 1;
      this.#entityIds.clear();
      this.#spring.reset();
      this.#cancelAnimation();
      // Force a render frame so the label can clean up its drag mode class
      canvasStore.setContainerDirty();
      return;
    }

    this.#targetScale = 1;
    this.#spring.absorb(currentVelocity, distance, config.touch.dragVisual.releaseSpring);
    this.#springStartTime = performance.now();
    this.#phase = DragVisualPhase.releasing;
    this.#registerAnimation();
  }

  /** Immediately reset to idle. Called when gesture is cancelled (pan, multi-touch, etc.). */
  cancel(): void {
    this.#clearTimer();
    const wasActive = this.#phase !== DragVisualPhase.idle;
    this.#phase = DragVisualPhase.idle;
    this.#currentScale = 1;
    this.#targetScale = 1;
    this.#entityIds.clear();
    this.#spring.reset();
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
    const distance = 1 - scaleDown; // positive distance from target
    this.#spring.absorb(0, distance, scaleDownSpring);
    this.#springStartTime = performance.now();
    this.#phase = DragVisualPhase.possibleDrag;
    this.#registerAnimation();
  }

  #registerAnimation(): void {
    this.#cancelAnimation();
    this.#handle = this.#scheduler.custom({
      tag: "drag-visual",
      tick: (now) => {
        if (this.#phase === DragVisualPhase.idle) return false;

        const elapsed = now - this.#springStartTime;
        const springValue = this.#spring.value(elapsed);

        if (springValue === null) {
          // Spring settled
          this.#currentScale = this.#targetScale;
          if (this.#phase === DragVisualPhase.releasing) {
            this.#phase = DragVisualPhase.idle;
            this.#entityIds.clear();
            canvasStore.setContainerDirty();
            return false;
          }
          // possibleDrag or dragging phase — spring settled but phase continues
          return false;
        }

        // Clamp scale to prevent extreme overshoot from spring dynamics
        const rawScale = this.#targetScale + springValue.offset;
        this.#currentScale = Math.max(0.8, Math.min(rawScale, 1.05));
        return true;
      },
    });
  }

  #cancelAnimation(): void {
    this.#handle?.cancel();
    this.#handle = null;
  }

  /** Get current spring velocity in units/ms (matching SpringBack.absorb's expected input). */
  #getSpringVelocity(): number {
    if (this.#phase === DragVisualPhase.idle) return 0;
    const elapsed = performance.now() - this.#springStartTime;
    const value = this.#spring.value(elapsed);
    // spring.value() returns velocity in units/second, absorb() expects units/ms
    return value ? value.velocity / 1000 : 0;
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
