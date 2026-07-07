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
  /** Easing function (default: easeOutCubic) */
  easing?: EasingFunction;
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

/**
 * Calculate viewport offset to place a world point at screen center.
 */
function getOffsetForWorldCenter(worldCenter: Point, zoom: number, screenCenter: Point): Point {
  return {
    x: worldCenter.x - screenCenter.x / zoom,
    y: worldCenter.y - screenCenter.y / zoom,
  };
}

/**
 * Viewport animation controller.
 * Manages smooth transitions between viewport states.
 *
 * Uses screen-space interpolation: interpolates the world center point
 * and zoom separately, then derives offset. This ensures the viewport
 * follows a straight visual path regardless of zoom changes.
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

    const startWorldCenter = getWorldCenter(currentViewport, screenCenter);
    const endWorldCenter = getWorldCenter(target, screenCenter);
    const startZoom = currentViewport.zoom;
    const endZoom = target.zoom;

    this.#handle = this.#scheduler.tween({
      from: 0,
      to: 1,
      duration,
      easing,
      tag: "viewport",
      onUpdate: (t) => {
        const currentZoom = lerpExp(startZoom, endZoom, t);
        const currentWorldCenter = lerpPoint(startWorldCenter, endWorldCenter, t);
        const currentOffset = getOffsetForWorldCenter(
          currentWorldCenter,
          currentZoom,
          screenCenter,
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
