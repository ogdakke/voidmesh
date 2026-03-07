import type { Point } from "#types/canvas.ts";

/**
 * 2D underdamped harmonic oscillator.
 *
 * Decays toward zero with configurable response time and damping ratio.
 * Each call to `step(dt)` advances the simulation and returns the delta
 * (how much the offset changed), so callers can apply it however they want.
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

  /** Whether the spring has meaningful motion */
  get active(): boolean {
    return (
      Math.abs(this.#offsetX) > 0.01 ||
      Math.abs(this.#offsetY) > 0.01 ||
      Math.abs(this.#velocityX) > 0.01 ||
      Math.abs(this.#velocityY) > 0.01
    );
  }

  /** Current offset (distance from target) */
  get offset(): Point {
    return { x: this.#offsetX, y: this.#offsetY };
  }

  /**
   * Configure spring parameters and set initial state.
   * @param offset Initial displacement from target
   * @param velocity Initial velocity (world units per second)
   * @param response Spring response time in seconds (lower = faster)
   * @param damping Damping ratio (0-1, where 1 = critical damping). Must be < 1.
   */
  start(offset: Point, velocity: Point, response: number, damping: number): void {
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
   * @returns The delta (previous offset minus new offset) — the movement to apply.
   */
  step(dt: number): Point {
    if (dt <= 0) return { x: 0, y: 0 };

    const { zetaOmega, omegaD } = { zetaOmega: this.#zetaOmega, omegaD: this.#omegaD };
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

    return { x: prevX - this.#offsetX, y: prevY - this.#offsetY };
  }

  /** Flush remaining offset and reset to zero. Returns the final delta. */
  flush(): Point {
    const remaining = { x: this.#offsetX, y: this.#offsetY };
    this.#offsetX = 0;
    this.#offsetY = 0;
    this.#velocityX = 0;
    this.#velocityY = 0;
    return remaining;
  }

  /** Reset all state */
  reset(): void {
    this.#offsetX = 0;
    this.#offsetY = 0;
    this.#velocityX = 0;
    this.#velocityY = 0;
    this.#zetaOmega = 0;
    this.#omegaD = 0;
  }
}
