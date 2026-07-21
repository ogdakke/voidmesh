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

/** Velocity threshold below which spring is considered settled */
const VELOCITY_THRESHOLD = 0.01;

/** Offset threshold below which spring is considered settled */
const VALUE_THRESHOLD = 0.1;

/** Default spring response time in seconds */
const DEFAULT_RESPONSE = 0.575;

/** Value returned by springBack.value() during animation */
export interface SpringBackValue {
  /** Current offset from the boundary (approaches 0 as spring settles) */
  offset: number;
  /** Current velocity */
  velocity: number;
}

/**
 * Handles spring-back animation with damped harmonic oscillation.
 *
 * Usage:
 * 1. Create a SpringBack instance
 * 2. Call absorb(velocity, distance) when an overshoot is detected
 * 3. Call value(elapsedTime) each frame to get the current offset
 * 4. When value() returns null, the animation is complete
 */
export class SpringBack {
  #lambda = 0;
  #c1 = 0;
  #c2 = 0;

  /**
   * Start a spring-back animation.
   * @param velocity Current velocity at the moment of overshoot (units per millisecond)
   * @param distance Distance past the boundary (positive = past boundary)
   * @param response Spring response time in seconds (lower = snappier). Default: 0.575
   */
  absorb(velocity: number, distance: number, response: number = DEFAULT_RESPONSE): void {
    this.#lambda = (2 * Math.PI) / response;
    this.#c1 = distance;
    // Convert velocity from units/ms to units/s for the spring equation
    this.#c2 = velocity * 1000 + this.#lambda * distance;
  }

  /**
   * Get the current spring state at the given time.
   * @param time Elapsed time in milliseconds since absorb() was called
   * @returns Current offset and velocity, or null if spring has settled
   */
  value(time: number): SpringBackValue | null {
    const t = time / 1000; // Convert ms to seconds for the equation
    const expTerm = Math.exp(-this.#lambda * t);

    const offset = (this.#c1 + this.#c2 * t) * expTerm;
    // Derivative: velocity = (c2 - λ·(c1 + c2·t)) · e^(-λ·t)
    const velocity = (this.#c2 - this.#lambda * (this.#c1 + this.#c2 * t)) * expTerm;

    // Settled when both offset and velocity are below thresholds
    if (Math.abs(offset) < VALUE_THRESHOLD && Math.abs(velocity) < VELOCITY_THRESHOLD) {
      return null;
    }

    return { offset, velocity };
  }

  /**
   * Reset the spring, stopping any animation.
   */
  reset(): void {
    this.#lambda = 0;
    this.#c1 = 0;
    this.#c2 = 0;
  }
}
