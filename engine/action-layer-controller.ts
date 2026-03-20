import { SpringBack } from "#lib/touch-scroll/spring-back.ts";
import { config } from "#config";
import { canvasStore } from "./canvas-store.ts";
import type { Point } from "#types/canvas.ts";
import {
  scheduler as defaultScheduler,
  type AnimationScheduler,
  type AnimationHandle,
} from "../lib/animation-scheduler.ts";

const enum ActionLayerPhase {
  idle,
  active,
  transitioning_to_drag,
  dismissing,
}

/**
 * Controls entity rubber-banding and blur animation for the mobile action layer.
 * Self-registers with AnimationScheduler (no external tick() needed).
 *
 * Phases:
 *   idle → active → transitioning_to_drag | dismissing → idle
 */
export class ActionLayerController {
  #scheduler: AnimationScheduler;
  #phase = ActionLayerPhase.idle as ActionLayerPhase;
  #handle: AnimationHandle | null = null;

  // Dismiss springs (screen-space offsets, one-shot spring-back to 0)
  #dismissSpringX = new SpringBack();
  #dismissSpringY = new SpringBack();
  #dismissSpringStartTime = 0;

  // Active-phase spring simulation (continuously chases target)
  #targetOffsetX = 0;
  #targetOffsetY = 0;
  #velocityX = 0;
  #velocityY = 0;
  #currentOffsetX = 0;
  #currentOffsetY = 0;
  #lastTickTime = 0;

  // Pre-computed spring constants (set on activate, derived from config)
  #omega = 0; // natural frequency (rad/s)
  #zeta = 0; // damping ratio
  #zetaOmega = 0; // ζ·ω (decay rate)
  #omegaD = 0; // damped frequency ω·√(1-ζ²)

  // Blur intensity (0-1), animated via linear interpolation
  #blurIntensity = 0;
  #blurTarget = 0;
  #blurStartTime = 0;
  #blurStartValue = 0;

  // Touch tracking
  #touchOrigin: Point = { x: 0, y: 0 };
  #fingerPosition: Point = { x: 0, y: 0 };

  // Entity IDs targeted by this activation (persists through dismiss for renderer)
  #entityIds: ReadonlySet<string> = new Set();

  constructor(scheduler: AnimationScheduler) {
    this.#scheduler = scheduler;
  }

  /** Activate the action layer. */
  activate(touchScreenPoint: Point, entityIds?: ReadonlySet<string>): void {
    this.#phase = ActionLayerPhase.active;
    this.#touchOrigin = { ...touchScreenPoint };
    this.#fingerPosition = { ...touchScreenPoint };
    this.#entityIds = entityIds ?? new Set();

    // Pre-compute spring constants from config
    const { entitySpringResponse, entitySpringDamping } = config.actionLayer;
    this.#omega = (2 * Math.PI) / entitySpringResponse;
    this.#zeta = entitySpringDamping;
    this.#zetaOmega = this.#zeta * this.#omega;
    this.#omegaD = this.#omega * Math.sqrt(1 - this.#zeta * this.#zeta);

    // Reset active spring state
    this.#targetOffsetX = 0;
    this.#targetOffsetY = 0;
    this.#velocityX = 0;
    this.#velocityY = 0;
    this.#currentOffsetX = 0;
    this.#currentOffsetY = 0;
    this.#lastTickTime = 0;

    // Reset dismiss springs
    this.#dismissSpringX.reset();
    this.#dismissSpringY.reset();

    // Start blur fade-in
    this.#blurStartValue = this.#blurIntensity;
    this.#blurTarget = 1;
    this.#blurStartTime = performance.now();

    this.#registerAnimation();
  }

  /** Update finger position during active phase. Sets spring target. */
  updateFingerPosition(screenPoint: Point): void {
    if (this.#phase !== ActionLayerPhase.active) return;
    this.#fingerPosition = { ...screenPoint };

    const rawDx = screenPoint.x - this.#touchOrigin.x;
    const rawDy = screenPoint.y - this.#touchOrigin.y;
    const rawDist = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
    const { deadzone, entityRubberBandMax } = config.actionLayer;

    // Inside deadzone: entity stays put (absorbs finger jitter near buttons)
    if (rawDist <= deadzone) {
      this.#targetOffsetX = 0;
      this.#targetOffsetY = 0;
      return;
    }

    // Subtract deadzone from distance, preserve direction
    const effectiveDist = rawDist - deadzone;
    const scale = effectiveDist / rawDist;
    const dx = rawDx * scale;
    const dy = rawDy * scale;

    this.#targetOffsetX = rubberBand(dx, entityRubberBandMax);
    this.#targetOffsetY = rubberBand(dy, entityRubberBandMax);
  }

  /**
   * Update blur intensity based on safe zone progress (0 = center, 1 = edge).
   * Called by React when it computes the progress.
   */
  updateSafeZoneProgress(progress: number): void {
    const { blurFadeStart } = config.actionLayer;
    const newTarget =
      progress > blurFadeStart ? 1 - (progress - blurFadeStart) / (1 - blurFadeStart) : 1;

    if (newTarget === this.#blurTarget) return;

    this.#blurTarget = newTarget;
    this.#blurStartValue = this.#blurIntensity;
    this.#blurStartTime = performance.now();
  }

  /** Get entity offset from rubber-banding (screen-space CSS pixels). */
  getEntityOffset(): Point {
    return { x: this.#currentOffsetX, y: this.#currentOffsetY };
  }

  /** Get current blur intensity (0-1). */
  getBlurIntensity(): number {
    return this.#blurIntensity;
  }

  /** Get the touch origin point. */
  getTouchOrigin(): Point {
    return this.#touchOrigin;
  }

  /** Get current finger position. */
  getFingerPosition(): Point {
    return this.#fingerPosition;
  }

  /** Check if an entity is targeted by the action layer. */
  hasEntity(entityId: string): boolean {
    return this.#entityIds.has(entityId);
  }

  /** Whether the action layer is currently active or animating. */
  isActive(): boolean {
    return this.#phase !== ActionLayerPhase.idle;
  }

  /** Whether we're in the main active phase (not dismissing/transitioning). */
  isInteractive(): boolean {
    return this.#phase === ActionLayerPhase.active;
  }

  /** Transition to entity drag mode. Snap entity and fade blur. */
  transitionToDrag(): void {
    if (this.#phase !== ActionLayerPhase.active) return;
    this.#phase = ActionLayerPhase.transitioning_to_drag;

    // Fade blur out quickly
    this.#blurStartValue = this.#blurIntensity;
    this.#blurTarget = 0;
    this.#blurStartTime = performance.now();

    // No spring-back needed — entity stays at current offset for drag pickup
    this.#dismissSpringX.reset();
    this.#dismissSpringY.reset();
    this.#dismissSpringStartTime = performance.now();

    // Stop active spring
    this.#velocityX = 0;
    this.#velocityY = 0;

    // Ensure animation is running for transition phase (may have been removed
    // by scheduler if active-phase spring settled before transition started)
    if (!this.#handle?.isActive) {
      this.#registerAnimation();
    }
  }

  /** Dismiss the action layer. Spring entity back to origin, fade blur. */
  dismiss(): void {
    if (this.#phase === ActionLayerPhase.idle) return;
    this.#phase = ActionLayerPhase.dismissing;

    // Spring entity back to origin, carrying current velocity for seamless handoff
    const response = config.actionLayer.entityRubberBandSpring;
    this.#dismissSpringX.absorb(this.#velocityX / 1000, this.#currentOffsetX, response);
    this.#dismissSpringY.absorb(this.#velocityY / 1000, this.#currentOffsetY, response);
    this.#dismissSpringStartTime = performance.now();

    // Stop active spring
    this.#velocityX = 0;
    this.#velocityY = 0;
    this.#targetOffsetX = 0;
    this.#targetOffsetY = 0;

    // Fade blur out
    this.#blurStartValue = this.#blurIntensity;
    this.#blurTarget = 0;
    this.#blurStartTime = performance.now();

    // Ensure animation is running for dismiss phase
    if (!this.#handle?.isActive) {
      this.#registerAnimation();
    }
  }

  /** Immediately reset to idle. */
  cancel(): void {
    this.#handle?.cancel();
    this.#handle = null;
    this.#phase = ActionLayerPhase.idle;
    this.#currentOffsetX = 0;
    this.#currentOffsetY = 0;
    this.#targetOffsetX = 0;
    this.#targetOffsetY = 0;
    this.#velocityX = 0;
    this.#velocityY = 0;
    this.#lastTickTime = 0;
    this.#blurIntensity = 0;
    this.#blurTarget = 0;
    this.#entityIds = new Set();
    this.#dismissSpringX.reset();
    this.#dismissSpringY.reset();
  }

  #registerAnimation(): void {
    this.#handle?.cancel();
    this.#handle = this.#scheduler.custom({
      tag: "action-layer",
      tick: (now) => {
        if (this.#phase === ActionLayerPhase.idle) return false;

        // Animate blur intensity toward target
        if (this.#blurIntensity !== this.#blurTarget) {
          const duration =
            this.#blurTarget > this.#blurStartValue
              ? config.actionLayer.blurFadeInMs
              : config.actionLayer.blurFadeOutMs;
          const elapsed = now - this.#blurStartTime;
          const t = Math.min(1, elapsed / Math.max(1, duration));
          this.#blurIntensity =
            this.#blurStartValue + (this.#blurTarget - this.#blurStartValue) * t;
          if (t >= 1) {
            this.#blurIntensity = this.#blurTarget;
          }
        }

        // Active phase: exact analytical damped harmonic oscillator
        if (this.#phase === ActionLayerPhase.active) {
          if (this.#lastTickTime === 0) {
            this.#lastTickTime = now;
            return true;
          }

          const dt = (now - this.#lastTickTime) / 1000;
          this.#lastTickTime = now;

          if (dt > 0) {
            const decay = Math.exp(-this.#zetaOmega * dt);
            const cosD = Math.cos(this.#omegaD * dt);
            const sinD = Math.sin(this.#omegaD * dt);

            const aX = this.#currentOffsetX - this.#targetOffsetX;
            const bX = (this.#velocityX + this.#zetaOmega * aX) / this.#omegaD;
            this.#currentOffsetX = this.#targetOffsetX + decay * (aX * cosD + bX * sinD);
            this.#velocityX =
              decay *
              ((bX * this.#omegaD - aX * this.#zetaOmega) * cosD -
                (aX * this.#omegaD + bX * this.#zetaOmega) * sinD);

            const aY = this.#currentOffsetY - this.#targetOffsetY;
            const bY = (this.#velocityY + this.#zetaOmega * aY) / this.#omegaD;
            this.#currentOffsetY = this.#targetOffsetY + decay * (aY * cosD + bY * sinD);
            this.#velocityY =
              decay *
              ((bY * this.#omegaD - aY * this.#zetaOmega) * cosD -
                (aY * this.#omegaD + bY * this.#zetaOmega) * sinD);
          }

          const dx = this.#targetOffsetX - this.#currentOffsetX;
          const dy = this.#targetOffsetY - this.#currentOffsetY;
          if (
            Math.abs(dx) > 0.05 ||
            Math.abs(dy) > 0.05 ||
            Math.abs(this.#velocityX) > 0.05 ||
            Math.abs(this.#velocityY) > 0.05
          ) {
          }
        }

        // Dismiss/transition phase: one-shot SpringBack to origin
        if (
          this.#phase === ActionLayerPhase.dismissing ||
          this.#phase === ActionLayerPhase.transitioning_to_drag
        ) {
          const elapsed = now - this.#dismissSpringStartTime;
          const valX = this.#dismissSpringX.value(elapsed);
          const valY = this.#dismissSpringY.value(elapsed);

          if (valX !== null) {
            this.#currentOffsetX = valX.offset;
          } else {
            this.#currentOffsetX = 0;
          }

          if (valY !== null) {
            this.#currentOffsetY = valY.offset;
          } else {
            this.#currentOffsetY = 0;
          }

          // If all animations settled, return to idle
          if (valX === null && valY === null && this.#blurIntensity === this.#blurTarget) {
            this.#phase = ActionLayerPhase.idle;
            this.#entityIds = new Set();
            // Trigger one more render so the renderer re-sorts entities
            canvasStore.setContainerDirty();
            return false;
          }
        }

        // Stay alive while phase is non-idle. The old game-loop model called
        // tick() every frame regardless; returning false only skipped rendering.
        // In the scheduler model, returning false REMOVES the animation, which
        // would prevent dismiss/transitionToDrag from being picked up later.
        return true;
      },
    });
  }
}

/** Asymptotic rubber-band: diminishing returns as delta grows. */
function rubberBand(delta: number, max: number): number {
  if (Math.abs(delta) < 0.001) return 0;
  return Math.sign(delta) * max * (1 - Math.exp(-Math.abs(delta) / max));
}

/** Singleton instance */
export const actionLayerController = new ActionLayerController(defaultScheduler);
