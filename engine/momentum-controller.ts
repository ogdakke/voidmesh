import { Scroller, SpringBack } from "#lib/touch-scroll/index.ts";
import { clampZoom, screenToWorld } from "#lib/canvas-math.ts";
import { config, type TouchConfig } from "#config";
import type { Point, Viewport } from "#types/canvas.ts";
import type { AnimationScheduler, AnimationHandle } from "#lib/animation-scheduler.ts";

export interface MomentumDeps {
  panBy(delta: Point): void;
  getViewport(): Viewport;
  setViewport(v: Viewport): void;
  getContainerRect(): DOMRect | null;
  getDpr(): number;
}

/**
 * Momentum physics for pan and zoom flings.
 *
 * Pan fling: exponential deceleration via Scroller along a fixed release vector.
 * Zoom fling: exponential deceleration in log(zoom) space, with elastic
 * spring-back (via SpringBack) when overshooting zoom boundaries.
 *
 * Constructed with injectable deps for testability.
 */
export class MomentumController {
  #scheduler: AnimationScheduler;
  #deps: MomentumDeps;

  #scrollerPan = new Scroller(config.touch.decelerationRate);
  #scrollerZoom = new Scroller(config.touch.zoomMomentum.decelerationRate, 0.0001);
  #springBackZoom = new SpringBack();

  #scrollHandle: AnimationHandle | null = null;
  #zoomHandle: AnimationHandle | null = null;
  #zoomFocalPoint: Point | null = null;
  readonly #scrollWorldDelta: Point = { x: 0, y: 0 };

  #touchConfig: TouchConfig;

  constructor(scheduler: AnimationScheduler, deps: MomentumDeps) {
    this.#scheduler = scheduler;
    this.#deps = deps;
    this.#touchConfig = { ...config.touch };
  }

  // ── Pan Fling ──────────────────────────────────────────────────────────

  /**
   * Start momentum scrolling if velocity exceeds threshold.
   * Called when a pan gesture ends.
   */
  triggerScroll(velocity: Point): void {
    const { velocityThreshold, maxVelocity, velocityScale } = this.#touchConfig;

    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed <= velocityThreshold) {
      return;
    }

    const clampedSpeed = Math.min(speed, maxVelocity);
    const directionX = velocity.x / speed;
    const directionY = velocity.y / speed;

    // Cancel previous handle before setting up new fling
    // (stopScroll resets scrollers, so it must come before fling)
    this.stopScroll();

    this.#scrollerPan.fling(clampedSpeed * velocityScale);

    const startTime = performance.now();
    let lastOffset = 0;

    this.#scrollHandle = this.#scheduler.custom({
      tag: "momentum",
      tick: (now) => {
        const elapsed = now - startTime;
        const value = this.#scrollerPan.value(elapsed);

        if (value) {
          const delta = -(value.offset - lastOffset);

          const viewport = this.#deps.getViewport();
          const dpr = this.#deps.getDpr();
          this.#scrollWorldDelta.x = (delta * directionX * dpr) / viewport.zoom;
          this.#scrollWorldDelta.y = (delta * directionY * dpr) / viewport.zoom;
          this.#deps.panBy(this.#scrollWorldDelta);

          lastOffset = value.offset;
          return true;
        }

        this.stopScroll();
        return false;
      },
    });
  }

  /** Cancel active pan momentum. */
  stopScroll(): void {
    this.#scrollHandle?.cancel();
    this.#scrollHandle = null;
    this.#scrollerPan.reset();
  }

  // ── Zoom Fling ─────────────────────────────────────────────────────────

  /**
   * Start zoom momentum (fling + spring-back at boundaries).
   * Operates in log(zoom) space for perceptually uniform deceleration.
   *
   * @param velocity Zoom velocity in log-space (from VelocityTracker)
   * @param focalPoint Screen-space focal point (pinch center or double-tap anchor)
   */
  triggerZoom(velocity: number, focalPoint: Point | null): void {
    const zoomConfig = this.#touchConfig.zoomMomentum;

    const currentZoom = this.#deps.getViewport().zoom;
    const boundary = clampZoom(currentZoom);

    // Cancel previous handle before setting up new physics
    // (stopZoom resets scrollers/springs/focalPoint, so it must come before setup)
    this.stopZoom();

    this.#zoomFocalPoint = focalPoint ? { ...focalPoint } : null;

    // State for the custom animation closure
    let isFling = currentZoom === boundary;
    let flingStartTime = performance.now();
    let lastFlingOffset = 0;
    let springStartTime = performance.now();
    let springBoundary = boundary;

    if (currentZoom !== boundary) {
      // Out of bounds — go directly to spring-back toward the nearest limit
      const logOvershoot = Math.log(currentZoom) - Math.log(boundary);
      this.#springBackZoom.absorb(velocity, logOvershoot, zoomConfig.springResponse);
      isFling = false;
      springBoundary = boundary;
    } else if (Math.abs(velocity) > zoomConfig.velocityThreshold) {
      // In bounds — start fling
      const clampedVel = Math.max(
        -zoomConfig.maxVelocity,
        Math.min(zoomConfig.maxVelocity, velocity),
      );
      this.#scrollerZoom.setDecelerationRate(zoomConfig.decelerationRate);
      this.#scrollerZoom.fling(clampedVel * zoomConfig.velocityScale);
      isFling = true;
    } else {
      // No momentum needed
      return;
    }
    this.#zoomHandle = this.#scheduler.custom({
      tag: "zoom-momentum",
      tick: (now) => {
        const fp = this.#zoomFocalPoint;
        const rect = this.#deps.getContainerRect();
        if (!fp || !rect) {
          this.stopZoom();
          return false;
        }

        const dpr = this.#deps.getDpr();

        if (isFling) {
          // Fling phase: exponential deceleration in log-space
          const elapsed = now - flingStartTime;
          const val = this.#scrollerZoom.value(elapsed);

          if (!val) {
            this.stopZoom();
            return false;
          }

          const logDelta = val.offset - lastFlingOffset;
          lastFlingOffset = val.offset;

          const viewport = this.#deps.getViewport();
          const newZoomUnclamped = viewport.zoom * Math.exp(logDelta);
          const newZoom = clampZoom(newZoomUnclamped);

          // Check if fling hit or overshot a boundary
          if (newZoom !== newZoomUnclamped) {
            // Transition to spring-back
            const overshootLog = Math.log(newZoomUnclamped) - Math.log(newZoom);
            this.#springBackZoom.reset();
            this.#springBackZoom.absorb(val.velocity, overshootLog, zoomConfig.springResponse);
            isFling = false;
            springStartTime = now;
            springBoundary = newZoom;

            this.#applyZoomToFocal(fp, viewport, rect, dpr, newZoom);
            return true;
          }

          this.#applyZoomToFocal(fp, viewport, rect, dpr, newZoom);
          return true;
        }

        // Spring-back phase: damped oscillation toward boundary
        const elapsed = now - springStartTime;
        const val = this.#springBackZoom.value(elapsed);

        if (!val) {
          // Spring settled — snap exactly to boundary
          const viewport = this.#deps.getViewport();
          if (viewport.zoom !== springBoundary) {
            this.#applyZoomToFocal(fp, viewport, rect, dpr, springBoundary);
          }
          this.stopZoom();
          return false;
        }

        // Spring offset is in log-space relative to boundary
        const viewport = this.#deps.getViewport();
        const springZoom = springBoundary * Math.exp(val.offset);
        const { minZoom, maxZoom } = config.canvas;
        const clampedZoom =
          springBoundary <= minZoom
            ? Math.max(0, Math.min(maxZoom, springZoom))
            : Math.max(minZoom, springZoom);

        this.#applyZoomToFocal(fp, viewport, rect, dpr, clampedZoom);
        return true;
      },
    });
  }

  /** Cancel active zoom momentum and spring-back. */
  stopZoom(): void {
    this.#zoomHandle?.cancel();
    this.#zoomHandle = null;
    this.#scrollerZoom.reset();
    this.#springBackZoom.reset();
    this.#zoomFocalPoint = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Cancel all active momentum (pan + zoom). */
  stopAll(): void {
    this.stopScroll();
    this.stopZoom();
  }

  get isActive(): boolean {
    return !!this.#scrollHandle?.isActive || !!this.#zoomHandle?.isActive;
  }

  /** Update touch config (e.g. changed deceleration rates). */
  setTouchConfig(touchConfig: Partial<TouchConfig>): void {
    this.#touchConfig = { ...this.#touchConfig, ...touchConfig };
    this.#scrollerPan.setDecelerationRate(this.#touchConfig.decelerationRate);
    if (touchConfig.zoomMomentum) {
      this.#scrollerZoom.setDecelerationRate(this.#touchConfig.zoomMomentum.decelerationRate);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  /** Apply zoom toward focal point, compensating viewport offset so the focal stays fixed. */
  #applyZoomToFocal(
    focalPoint: Point,
    viewport: Viewport,
    rect: DOMRect,
    dpr: number,
    newZoom: number,
  ): void {
    const worldBefore = screenToWorld(focalPoint, viewport, rect, dpr);
    this.#deps.setViewport({ ...viewport, zoom: newZoom });
    const worldAfter = screenToWorld(focalPoint, this.#deps.getViewport(), rect, dpr);
    this.#deps.panBy({ x: worldBefore.x - worldAfter.x, y: worldBefore.y - worldAfter.y });
  }
}
