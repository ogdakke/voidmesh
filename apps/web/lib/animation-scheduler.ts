import type { Point } from "#types/canvas.ts";
import { DampedSpring, DampedSpring2D } from "./touch-scroll/damped-spring.ts";

export type EasingFunction = (t: number) => number;

export interface AnimationHandle {
  cancel(): void;
  get isActive(): boolean;
}

// ── Tween ──────────────────────────────────────────────────────────────────

export interface TweenConfig {
  from: number;
  to: number;
  duration: number;
  easing?: EasingFunction;
  tag?: string;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}

// ── Spring2D ───────────────────────────────────────────────────────────────

/**
 * Use `spring()` for animating a single scalar value toward a target.
 * The scheduler owns the spring state and calls `onUpdate(value)` with the absolute value.
 */
export interface SpringConfig {
  from: number;
  to: number;
  /** Initial velocity in units per second. */
  velocity?: number;
  /** Spring response time in seconds (lower = faster) */
  response: number;
  /** Damping ratio (0–1, where 1 = critical damping). Must be < 1. */
  damping: number;
  /** Sleep threshold in value units. Scalar springs default tighter than 2D motion springs. */
  settleThreshold?: number;
  tag?: string;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}

/**
 * Use `spring2D()` for motion that applies per-frame x/y deltas.
 * The scheduler owns the spring state and calls `onUpdate(dx, dy)` with the delta to apply this frame.
 */
export interface Spring2DConfig {
  offset: Point;
  velocity: Point;
  /** Spring response time in seconds (lower = faster) */
  response: number;
  /** Damping ratio (0–1, where 1 = critical). Must be < 1. */
  damping: number;
  /** Sleep threshold: spring settles when offset+velocity drop below this (default 0.01) */
  settleThreshold?: number;
  tag?: string;
  /** Called each step with the delta to apply (scalars, no allocation) */
  onUpdate: (dx: number, dy: number) => void;
  /** Called when settled, with remaining flush delta (scalars, no allocation) */
  onComplete?: (flushX: number, flushY: number) => void;
}

// ── Custom ─────────────────────────────────────────────────────────────────

export interface CustomConfig {
  tag?: string;
  /** Return true while active. Return false to complete. */
  tick: (now: number) => boolean;
  onComplete?: () => void;
}

// ── Internal animation types ───────────────────────────────────────────────

interface TweenAnimation {
  type: "tween";
  id: number;
  tag: string | undefined;
  startTime: number | null;
  duration: number;
  from: number;
  to: number;
  easing: EasingFunction;
  onUpdate: (value: number) => void;
  onComplete: (() => void) | undefined;
  cancelled: boolean;
}

interface Spring2DAnimation {
  type: "spring2d";
  id: number;
  tag: string | undefined;
  spring: DampedSpring2D;
  lastTime: number | null;
  onUpdate: (dx: number, dy: number) => void;
  onComplete: (() => void) | undefined;
  cancelled: boolean;
}

interface SpringAnimation {
  type: "spring";
  id: number;
  tag: string | undefined;
  spring: DampedSpring;
  target: number;
  lastTime: number | null;
  onUpdate: (value: number) => void;
  onComplete: (() => void) | undefined;
  cancelled: boolean;
}

interface CustomAnimation {
  type: "custom";
  id: number;
  tag: string | undefined;
  tick: (now: number) => boolean;
  onComplete: (() => void) | undefined;
  cancelled: boolean;
}

type Animation = TweenAnimation | Spring2DAnimation | SpringAnimation | CustomAnimation;

// ── Scheduler ──────────────────────────────────────────────────────────────

const linear: EasingFunction = (t) => t;

export class AnimationScheduler {
  #animations = new Map<number, Animation>();
  #completed: Animation[] = [];
  #nextId = 0;

  get hasActive(): boolean {
    return this.#animations.size > 0;
  }

  tween(config: TweenConfig): AnimationHandle {
    const id = this.#nextId++;
    const anim: TweenAnimation = {
      type: "tween",
      id,
      tag: config.tag,
      startTime: null,
      duration: config.duration,
      from: config.from,
      to: config.to,
      easing: config.easing ?? linear,
      onUpdate: config.onUpdate,
      onComplete: config.onComplete,
      cancelled: false,
    };
    this.#animations.set(id, anim);
    return this.#makeHandle(id, anim);
  }

  spring(config: SpringConfig): AnimationHandle {
    const id = this.#nextId++;
    const spring = new DampedSpring();
    spring.start(
      config.from - config.to,
      config.velocity ?? 0,
      config.response,
      config.damping,
      config.settleThreshold,
    );
    const anim: SpringAnimation = {
      type: "spring",
      id,
      tag: config.tag,
      spring,
      target: config.to,
      lastTime: null,
      onUpdate: config.onUpdate,
      onComplete: config.onComplete,
      cancelled: false,
    };
    this.#animations.set(id, anim);
    return this.#makeHandle(id, anim);
  }

  spring2D(config: Spring2DConfig): AnimationHandle {
    const id = this.#nextId++;
    const spring = new DampedSpring2D();
    spring.start(
      config.offset,
      config.velocity,
      config.response,
      config.damping,
      config.settleThreshold,
    );
    const userOnComplete = config.onComplete;
    const anim: Spring2DAnimation = {
      type: "spring2d",
      id,
      tag: config.tag,
      spring,
      lastTime: null,
      onUpdate: config.onUpdate,
      onComplete: userOnComplete
        ? () => {
            spring.flush();
            userOnComplete(spring.deltaX, spring.deltaY);
          }
        : undefined,
      cancelled: false,
    };
    this.#animations.set(id, anim);
    return this.#makeHandle(id, anim);
  }

  custom(config: CustomConfig): AnimationHandle {
    const id = this.#nextId++;
    const anim: CustomAnimation = {
      type: "custom",
      id,
      tag: config.tag,
      tick: config.tick,
      onComplete: config.onComplete,
      cancelled: false,
    };
    this.#animations.set(id, anim);
    return this.#makeHandle(id, anim);
  }

  cancelByTag(tag: string): void {
    for (const anim of this.#animations.values()) {
      if (anim.tag === tag) {
        anim.cancelled = true;
      }
    }
    // Remove immediately (safe: not during iteration of tick)
    for (const [id, anim] of this.#animations) {
      if (anim.cancelled) this.#animations.delete(id);
    }
  }

  tick(now: number): void {
    for (const anim of this.#animations.values()) {
      if (anim.cancelled) {
        this.#animations.delete(anim.id);
        continue;
      }

      let done = false;

      if (anim.type === "tween") {
        done = this.#tickTween(anim, now);
      } else if (anim.type === "spring") {
        done = this.#tickSpring(anim, now);
      } else if (anim.type === "spring2d") {
        done = this.#tickSpring2D(anim, now);
      } else {
        done = !anim.tick(now);
      }

      if (done && !anim.cancelled) {
        this.#completed.push(anim);
        this.#animations.delete(anim.id);
      }
    }

    // Fire onComplete callbacks after iteration (safe to start new animations)
    for (const anim of this.#completed) {
      anim.onComplete?.();
    }
    this.#completed.length = 0;
  }

  #tickTween(anim: TweenAnimation, now: number): boolean {
    if (anim.startTime === null) anim.startTime = now;

    const elapsed = now - anim.startTime;
    const rawProgress = elapsed / anim.duration;

    if (rawProgress >= 1) {
      anim.onUpdate(anim.to);
      return true;
    }

    const t = anim.easing(rawProgress);
    anim.onUpdate(anim.from + (anim.to - anim.from) * t);
    return false;
  }

  #tickSpring(anim: SpringAnimation, now: number): boolean {
    if (anim.lastTime === null) {
      anim.lastTime = now;
      anim.onUpdate(anim.target + anim.spring.offset);
      return false;
    }

    const dt = (now - anim.lastTime) / 1000;
    anim.lastTime = now;

    const spring = anim.spring;
    spring.step(dt);
    anim.onUpdate(anim.target + spring.offset);

    if (spring.active) return false;

    spring.flush();
    anim.onUpdate(anim.target);
    return true;
  }

  #tickSpring2D(anim: Spring2DAnimation, now: number): boolean {
    if (anim.lastTime === null) {
      anim.lastTime = now;
      return false;
    }

    const dt = (now - anim.lastTime) / 1000;
    anim.lastTime = now;

    const spring = anim.spring;
    spring.step(dt);
    anim.onUpdate(spring.deltaX, spring.deltaY);

    return !spring.active;
  }

  #makeHandle(id: number, anim: Animation): AnimationHandle {
    const animations = this.#animations;
    return {
      cancel() {
        anim.cancelled = true;
        animations.delete(id);
      },
      get isActive() {
        return !anim.cancelled && animations.has(id);
      },
    };
  }
}

export const scheduler = new AnimationScheduler();
