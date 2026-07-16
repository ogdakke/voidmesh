import { canvasStore } from "./canvas-store.ts";
import type { Point, Viewport } from "#types/canvas.ts";
import { lerpExp, lerpPoint, easings, type EasingFunction } from "#lib/canvas-math.ts";
import { config } from "#config";
import {
  scheduler as defaultScheduler,
  type AnimationScheduler,
  type AnimationHandle,
} from "#lib/animation-scheduler.ts";

export interface ViewportAnimationOptions {
  /** Animation duration in milliseconds (default: 300) */
  duration?: number;
  /** Zoom easing function (default: easeOutCubic) */
  easing?: EasingFunction;
  /** Screen-space translation easing function (default: easeInOut) */
  positionEasing?: EasingFunction;
  /** Callback when animation completes */
  onComplete?: () => void;
}

export interface ViewportStore {
  setViewport(viewport: Viewport): void;
  getViewport(): Viewport;
}

/**
 * Calculate the world point at the center of the screen.
 * screenCenter is in device pixels (container size * dpr).
 */
function getWorldCenter(viewport: Viewport, screenCenter: Point): Point {
  return {
    x: viewport.offset.x + screenCenter.x / viewport.zoom,
    y: viewport.offset.y + screenCenter.y / viewport.zoom,
  };
}

/** Calculate viewport offset to place a world point at a screen point. */
function getOffsetForWorldPoint(worldPoint: Point, screenPoint: Point, zoom: number): Point {
  return {
    x: worldPoint.x - screenPoint.x / zoom,
    y: worldPoint.y - screenPoint.y / zoom,
  };
}

/**
 * Viewport animation controller.
 * Manages smooth transitions between viewport states.
 *
 * Uses screen-space interpolation: the destination viewport's world center
 * moves from its current screen position to the screen center while zoom is
 * interpolated separately. Deriving offset from that anchor prevents large
 * zoom changes from bending or reversing the visual flight path.
 *
 * Delegates timing to AnimationScheduler (no tick() method).
 */
export class ViewportAnimationController {
  #scheduler: AnimationScheduler;
  #store: ViewportStore;
  #handle: AnimationHandle | null = null;
  #container: HTMLElement | null = null;

  constructor(scheduler: AnimationScheduler, store: ViewportStore) {
    this.#scheduler = scheduler;
    this.#store = store;
  }

  /**
   * Set the container element (needed for screen size calculations).
   * Should be called once during initialization.
   */
  setContainer(container: HTMLElement): void {
    this.#container = container;
  }

  /**
   * Start animating to a target viewport.
   * Cancels any in-progress animation.
   */
  animateTo(target: Viewport, options: ViewportAnimationOptions = {}): void {
    const {
      duration = config.canvas.animation.centerCanvasDuration,
      easing = easings[config.canvas.animation.easing],
      positionEasing = easings.easeInOut,
      onComplete,
    } = options;

    // Cancel any existing animation
    this.cancel();

    if (!this.#container) {
      // No container set, fall back to instant update
      this.#store.setViewport(target);
      onComplete?.();
      return;
    }

    const currentViewport = this.#store.getViewport();

    // Skip animation if already at target
    if (viewportsEqual(currentViewport, target)) {
      onComplete?.();
      return;
    }

    const dpr = window.devicePixelRatio;
    const screenCenter: Point = {
      x: (this.#container.clientWidth * dpr) / 2,
      y: (this.#container.clientHeight * dpr) / 2,
    };

    const endWorldCenter = getWorldCenter(target, screenCenter);
    const startEndCenterScreenPosition: Point = {
      x: (endWorldCenter.x - currentViewport.offset.x) * currentViewport.zoom,
      y: (endWorldCenter.y - currentViewport.offset.y) * currentViewport.zoom,
    };
    const startZoom = currentViewport.zoom;
    const endZoom = target.zoom;

    this.#handle = this.#scheduler.tween({
      from: 0,
      to: 1,
      duration,
      tag: "viewport",
      onUpdate: (rawProgress) => {
        const currentZoom = lerpExp(startZoom, endZoom, easing(rawProgress));
        const currentEndCenterScreenPosition = lerpPoint(
          startEndCenterScreenPosition,
          screenCenter,
          positionEasing(rawProgress),
        );
        const currentOffset = getOffsetForWorldPoint(
          endWorldCenter,
          currentEndCenterScreenPosition,
          currentZoom,
        );
        this.#store.setViewport({ offset: currentOffset, zoom: currentZoom });
      },
      onComplete,
    });
  }

  /**
   * Cancel the current animation immediately.
   * Viewport stays at its current position.
   */
  cancel(): void {
    this.#handle?.cancel();
    this.#handle = null;
  }

  /** Check if an animation is currently running. */
  get isAnimating(): boolean {
    return this.#handle?.isActive ?? false;
  }
}

function viewportsEqual(a: Viewport, b: Viewport, epsilon = 0.0001): boolean {
  return (
    Math.abs(a.offset.x - b.offset.x) < epsilon &&
    Math.abs(a.offset.y - b.offset.y) < epsilon &&
    Math.abs(a.zoom - b.zoom) < epsilon
  );
}

// Singleton instance
export const viewportAnimation = new ViewportAnimationController(defaultScheduler, {
  setViewport: (v) => canvasStore.setViewport(v),
  getViewport: () => canvasStore.getViewport(),
});
