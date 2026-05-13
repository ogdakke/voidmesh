// Copyright 2023 ktiays
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Modifications: ported to TypeScript, adapted for voidmesh

/** Deceleration rates for the scroll animation */
export const DecelerationRate = {
  /** iOS-like smooth deceleration (default) */
  NORMAL: 0.998,
  /** Somewhere in between very slow decel and a fairly slow decel, idk this is tough to put into words */
  REASONABLE: 0.995,
  /** Faster deceleration for quicker stops */
  FAST: 0.992,
  /** Even faster decelaration for a more natural feel */
  FASTER: 0.99,
} as const;

export type DecelerationRateValue = (typeof DecelerationRate)[keyof typeof DecelerationRate];

/** Default velocity threshold below which scrolling stops (px/ms) */
const DEFAULT_VELOCITY_THRESHOLD = 0.01;

/** Value returned by scroller.value() during animation */
export interface ScrollerValue {
  /** Total distance traveled since fling started (pixels) */
  offset: number;
  /** Current velocity (pixels per millisecond) */
  velocity: number;
}

/**
 * Handles momentum scrolling with exponential deceleration.
 *
 * Usage:
 * 1. Create a Scroller instance
 * 2. Call fling(velocity) with the initial velocity from VelocityTracker
 * 3. Call value(elapsedTime) each frame to get the current offset
 * 4. When value() returns null, the animation is complete
 */
export class Scroller {
  #decelerationRate: number;
  #velocityThreshold: number;
  #initialVelocity = 0;

  constructor(
    decelerationRate: number = DecelerationRate.NORMAL,
    velocityThreshold: number = DEFAULT_VELOCITY_THRESHOLD,
  ) {
    this.#decelerationRate = decelerationRate;
    this.#velocityThreshold = velocityThreshold;
  }

  /**
   * Set the deceleration rate.
   * Lower values = faster deceleration.
   */
  setDecelerationRate(rate: number): void {
    this.#decelerationRate = rate;
  }

  /**
   * Set the velocity below which the fling is considered settled.
   */
  setVelocityThreshold(threshold: number): void {
    this.#velocityThreshold = threshold;
  }

  /**
   * Start a fling animation with the given initial velocity.
   * @param velocity Initial velocity in pixels per millisecond
   */
  fling(velocity: number): void {
    this.#initialVelocity = velocity;
  }

  /**
   * Get the current scroll state at the given time.
   * @param time Elapsed time in milliseconds since fling() was called
   * @returns Current offset and velocity, or null if animation is complete
   */
  value(time: number): ScrollerValue | null {
    const rate = this.#decelerationRate;
    const coefficient = Math.pow(rate, time);
    const velocity = this.#initialVelocity * coefficient;

    // Offset is the integral of velocity over time
    // v(t) = v0 * r^t
    // x(t) = v0 * (1/ln(r)) * (r^t - 1)
    const offset = this.#initialVelocity * (1 / Math.log(rate)) * (coefficient - 1);

    if (Math.abs(velocity) < this.#velocityThreshold) {
      return null; // Animation complete
    }

    return { offset, velocity };
  }

  /**
   * Reset the scroller, stopping any animation.
   */
  reset(): void {
    this.#initialVelocity = 0;
  }

  /**
   * Get the initial velocity that was set via fling().
   */
  getInitialVelocity(): number {
    return this.#initialVelocity;
  }
}
