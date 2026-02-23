import { canvasStore } from "./canvas-store.ts";
import type { Point, Viewport } from "#types/canvas.ts";
import { lerpExp, lerpPoint, easings, type EasingFunction } from "../lib/canvas-math.ts";
import { config } from "../lib/config/index.ts";

export interface ViewportAnimationOptions {
  /** Animation duration in milliseconds (default: 300) */
  duration?: number;
  /** Easing function (default: easeOutCubic) */
  easing?: EasingFunction;
  /** Callback when animation completes */
  onComplete?: () => void;
}

interface AnimationState {
  /** World point that was at screen center at animation start */
  startWorldCenter: Point;
  /** World point that should be at screen center at animation end */
  endWorldCenter: Point;
  startZoom: number;
  endZoom: number;
  /** Screen center in device pixels (needed to calculate offset from world center) */
  screenCenter: Point;
  startTime: number;
  duration: number;
  easing: EasingFunction;
  onComplete?: () => void;
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
 * Integrates with the game loop for 60fps updates.
 *
 * Uses screen-space interpolation: interpolates the world center point
 * and zoom separately, then derives offset. This ensures the viewport
 * follows a straight visual path regardless of zoom changes.
 */
class ViewportAnimationController {
  #animation: AnimationState | null = null;
  #container: HTMLElement | null = null;

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
      canvasStore.setViewport(target);
      onComplete?.();
      return;
    }

    const currentViewport = canvasStore.getViewport();

    // Skip animation if already at target
    if (this.#viewportsEqual(currentViewport, target)) {
      onComplete?.();
      return;
    }

    const dpr = window.devicePixelRatio;
    const screenCenter: Point = {
      x: (this.#container.clientWidth * dpr) / 2,
      y: (this.#container.clientHeight * dpr) / 2,
    };

    // Calculate world centers for start and end viewports
    const startWorldCenter = getWorldCenter(currentViewport, screenCenter);
    const endWorldCenter = getWorldCenter(target, screenCenter);

    this.#animation = {
      startWorldCenter,
      endWorldCenter,
      startZoom: currentViewport.zoom,
      endZoom: target.zoom,
      screenCenter,
      startTime: performance.now(),
      duration,
      easing,
      onComplete,
    };
  }

  /**
   * Cancel the current animation immediately.
   * Viewport stays at its current position.
   */
  cancel(): void {
    if (this.#animation) {
      this.#animation = null;
    }
  }

  /**
   * Check if an animation is currently running.
   */
  get isAnimating(): boolean {
    return this.#animation !== null;
  }

  /**
   * Update the animation. Called by game loop each frame.
   * @param now Current timestamp (from performance.now())
   * @returns true if animation is active and viewport was updated
   */
  tick(now: number): boolean {
    if (!this.#animation) return false;

    const {
      startWorldCenter,
      endWorldCenter,
      startZoom,
      endZoom,
      screenCenter,
      startTime,
      duration,
      easing,
      onComplete,
    } = this.#animation;

    const elapsed = now - startTime;
    const rawProgress = elapsed / duration;

    if (rawProgress >= 1) {
      // Animation complete - set final viewport
      const finalOffset = getOffsetForWorldCenter(endWorldCenter, endZoom, screenCenter);
      canvasStore.setViewport({ offset: finalOffset, zoom: endZoom });
      this.#animation = null;
      onComplete?.();
      return true;
    }

    // Apply easing
    const t = easing(rawProgress);

    // Interpolate zoom exponentially (perceptually uniform) and world center linearly
    const currentZoom = lerpExp(startZoom, endZoom, t);
    const currentWorldCenter = lerpPoint(startWorldCenter, endWorldCenter, t);

    // Calculate offset from interpolated values
    const currentOffset = getOffsetForWorldCenter(currentWorldCenter, currentZoom, screenCenter);

    canvasStore.setViewport({ offset: currentOffset, zoom: currentZoom });
    return true;
  }

  #viewportsEqual(a: Viewport, b: Viewport, epsilon = 0.0001): boolean {
    return (
      Math.abs(a.offset.x - b.offset.x) < epsilon &&
      Math.abs(a.offset.y - b.offset.y) < epsilon &&
      Math.abs(a.zoom - b.zoom) < epsilon
    );
  }
}

// Singleton instance
export const viewportAnimation = new ViewportAnimationController();
