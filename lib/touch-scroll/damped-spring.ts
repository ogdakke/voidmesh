import type { Point } from "#types/canvas.ts";

/**
 * 1D underdamped harmonic oscillator.
 *
 * Decays toward zero with configurable response time and damping ratio.
 * Used for scalar value animations where callers care about the current value,
 * not just per-frame deltas.
 */
export class DampedSpring {
  static readonly DEFAULT_THRESHOLD = 0.0001;

  #offset = 0;
  #velocity = 0;
  #zetaOmega = 0;
  #omegaD = 0;
  #threshold = DampedSpring.DEFAULT_THRESHOLD;

  /** Whether the spring has meaningful motion (below sleep threshold = settled) */
  get active(): boolean {
    const t = this.#threshold;
    return Math.abs(this.#offset) > t || Math.abs(this.#velocity) > t;
  }

  /** Current offset from the target value */
  get offset(): number {
    return this.#offset;
  }

  /**
   * Configure spring parameters and set initial state.
   * @param offset Initial displacement from target
   * @param velocity Initial velocity (units per second)
   * @param response Spring response time in seconds (lower = faster)
   * @param damping Damping ratio (0-1, where 1 = critical damping). Must be < 1.
   */
  start(
    offset: number,
    velocity: number,
    response: number,
    damping: number,
    threshold = DampedSpring.DEFAULT_THRESHOLD,
  ): void {
    this.#threshold = threshold;
    const omega = (2 * Math.PI) / response;
    this.#zetaOmega = damping * omega;
    this.#omegaD = omega * Math.sqrt(1 - damping * damping);
    this.#offset = offset;
    this.#velocity = velocity;
  }

  /** Advance the spring by dt seconds. */
  step(dt: number): void {
    if (dt <= 0) {
      return;
    }

    const zetaOmega = this.#zetaOmega;
    const omegaD = this.#omegaD;
    const decay = Math.exp(-zetaOmega * dt);
    const cosD = Math.cos(omegaD * dt);
    const sinD = Math.sin(omegaD * dt);

    const a = this.#offset;
    const b = (this.#velocity + zetaOmega * a) / omegaD;
    this.#offset = decay * (a * cosD + b * sinD);
    this.#velocity =
      decay * ((b * omegaD - a * zetaOmega) * cosD - (a * omegaD + b * zetaOmega) * sinD);
  }

  /** Snap to the target value. */
  flush(): void {
    this.#offset = 0;
    this.#velocity = 0;
  }

  /** Reset all state */
  reset(): void {
    this.#offset = 0;
    this.#velocity = 0;
    this.#zetaOmega = 0;
    this.#omegaD = 0;
  }
}

/**
 * 2D underdamped harmonic oscillator.
 *
 * Decays toward zero with configurable response time and damping ratio.
 * Each call to `step(dt)` advances the simulation and stores the delta
 * in `deltaX`/`deltaY`, so callers can apply it however they want.
 *
 * Used for catch-up springs, snap-settle animations, and rubber-band returns.
 */
export class DampedSpring2D {
  #offsetX = 0;
  #offsetY = 0;
  #velocityX = 0;
  #velocityY = 0;
  #zetaOmega = 0;
  #omegaD = 0;
  #deltaX = 0;
  #deltaY = 0;
  #threshold = 0.01;

  /** Whether the spring has meaningful motion (below sleep threshold = settled) */
  get active(): boolean {
    const t = this.#threshold;
    return (
      Math.abs(this.#offsetX) > t ||
      Math.abs(this.#offsetY) > t ||
      Math.abs(this.#velocityX) > t ||
      Math.abs(this.#velocityY) > t
    );
  }

  /** X component of the last step/flush result */
  get deltaX(): number {
    return this.#deltaX;
  }

  /** Y component of the last step/flush result */
  get deltaY(): number {
    return this.#deltaY;
  }

  /**
   * Configure spring parameters and set initial state.
   * @param offset Initial displacement from target
   * @param velocity Initial velocity (world units per second)
   * @param response Spring response time in seconds (lower = faster)
   * @param damping Damping ratio (0-1, where 1 = critical damping). Must be < 1.
   */
  start(offset: Point, velocity: Point, response: number, damping: number, threshold = 0.01): void {
    this.#threshold = threshold;
    const omega = (2 * Math.PI) / response;
    this.#zetaOmega = damping * omega;
    this.#omegaD = omega * Math.sqrt(1 - damping * damping);
    this.#offsetX = offset.x;
    this.#offsetY = offset.y;
    this.#velocityX = velocity.x;
    this.#velocityY = velocity.y;
  }

  /**
   * Advance the spring by dt seconds.
   * Result available via `deltaX`/`deltaY` (previous offset minus new offset).
   */
  step(dt: number): void {
    if (dt <= 0) {
      this.#deltaX = 0;
      this.#deltaY = 0;
      return;
    }

    const zetaOmega = this.#zetaOmega;
    const omegaD = this.#omegaD;
    const decay = Math.exp(-zetaOmega * dt);
    const cosD = Math.cos(omegaD * dt);
    const sinD = Math.sin(omegaD * dt);

    const prevX = this.#offsetX;
    const prevY = this.#offsetY;

    // X axis
    const aX = this.#offsetX;
    const bX = (this.#velocityX + zetaOmega * aX) / omegaD;
    this.#offsetX = decay * (aX * cosD + bX * sinD);
    this.#velocityX =
      decay * ((bX * omegaD - aX * zetaOmega) * cosD - (aX * omegaD + bX * zetaOmega) * sinD);

    // Y axis
    const aY = this.#offsetY;
    const bY = (this.#velocityY + zetaOmega * aY) / omegaD;
    this.#offsetY = decay * (aY * cosD + bY * sinD);
    this.#velocityY =
      decay * ((bY * omegaD - aY * zetaOmega) * cosD - (aY * omegaD + bY * zetaOmega) * sinD);

    this.#deltaX = prevX - this.#offsetX;
    this.#deltaY = prevY - this.#offsetY;
  }

  /** Flush remaining offset and reset to zero. Result available via `deltaX`/`deltaY`. */
  flush(): void {
    this.#deltaX = this.#offsetX;
    this.#deltaY = this.#offsetY;
    this.#offsetX = 0;
    this.#offsetY = 0;
    this.#velocityX = 0;
    this.#velocityY = 0;
  }

  /** Reset all state */
  reset(): void {
    this.#offsetX = 0;
    this.#offsetY = 0;
    this.#velocityX = 0;
    this.#velocityY = 0;
    this.#zetaOmega = 0;
    this.#omegaD = 0;
    this.#deltaX = 0;
    this.#deltaY = 0;
  }
}
