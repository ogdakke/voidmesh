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

interface DataPoint {
  time: number; // milliseconds
  value: number; // position in pixels
}

const HISTORY_SIZE = 20;
const DEFAULT_REGRESSION_HORIZON_MS = 100;
const DEFAULT_MIN_REGRESSION_SPAN_MS = 32;
const DEFAULT_TERMINAL_MIN_DELTA_MS = 8;
const DEFAULT_TERMINAL_MAX_DELTA_MS = 40;

/**
 * Tracks touch position samples and calculates velocity using
 * a weighted recurrence relation algorithm.
 */
export class VelocityTracker {
  #samples: (DataPoint | null)[] = Array(HISTORY_SIZE).fill(null);
  #index = 0;

  /**
   * Add a new data point for velocity calculation.
   * @param time Time in milliseconds (e.g., performance.now())
   * @param position Position in screen pixels
   */
  addDataPoint(time: number, position: number): void {
    this.#index = (this.#index + 1) % HISTORY_SIZE;
    this.#samples[this.#index] = { time, value: position };
  }

  /**
   * Calculate the estimated velocity at the time of the last data point.
   * Uses the Recurrence strategy with weighted averaging.
   * @returns Velocity in pixels per millisecond
   */
  calculate(): number {
    // Collect valid samples starting from newest
    const samples: DataPoint[] = [];
    let index = this.#index;

    for (let i = 0; i < HISTORY_SIZE; i++) {
      const sample = this.#samples[index];
      if (!sample) break;
      samples.push(sample);
      index = index === 0 ? HISTORY_SIZE - 1 : index - 1;
    }

    // Need at least 2 samples to calculate velocity
    if (samples.length < 2) {
      return 0;
    }

    // Reverse to get oldest-to-newest order, then take last 4 samples
    samples.reverse();
    const recentSamples = samples.slice(-4);

    // Calculate velocity between consecutive sample pairs
    const velocities: number[] = [];
    for (let i = 0; i < recentSamples.length - 1; i++) {
      const s0 = recentSamples[i]!;
      const s1 = recentSamples[i + 1]!;
      const deltaTime = s1.time - s0.time;

      if (deltaTime > 0) {
        velocities.push((s1.value - s0.value) / deltaTime);
      }
    }

    if (velocities.length === 0) {
      return 0;
    }

    if (velocities.length === 1) {
      // Dampen single-velocity results — with only 2 samples, the raw value
      // is unreliable (especially on iOS where touch event timing is irregular)
      return velocities[0]! * 0.7;
    }

    // Apply recurrence relation with weighted averaging
    let previousVelocity: number | null = null;
    let currentVelocity: number | null = null;

    for (let i = 0; i < velocities.length - 1; i++) {
      // Weighted blend of consecutive velocities (40/60)
      const blended = velocities[i]! * 0.4 + velocities[i + 1]! * 0.6;

      if (currentVelocity !== null) {
        previousVelocity = currentVelocity;
        // Smoothing with previous (80/20)
        currentVelocity = currentVelocity * 0.8 + blended * 0.2;
      } else {
        currentVelocity = blended;
      }
    }

    if (currentVelocity === null) {
      return velocities[0]!;
    }

    // Final blend with previous velocity (75/25)
    if (previousVelocity !== null) {
      return previousVelocity * 0.75 + currentVelocity * 0.25;
    }

    return currentVelocity;
  }

  /**
   * Estimate release velocity from a recent sample window using linear least squares.
   *
   * This is intended for fling handoff, where very small touch event intervals can
   * create unrealistic pairwise velocities. The fit uses recent position history
   * instead of the last one or two deltas.
   */
  calculateLinearRegression(
    horizonMs: number = DEFAULT_REGRESSION_HORIZON_MS,
    minSpanMs: number = DEFAULT_MIN_REGRESSION_SPAN_MS,
  ): number {
    const samples = this.#getSamplesOldestFirst();
    if (samples.length < 2) return 0;

    const newest = samples.at(-1)!;
    let windowStart = samples.length - 1;

    for (let i = samples.length - 2; i >= 0; i--) {
      const age = newest.time - samples[i]!.time;
      if (age > horizonMs) break;
      windowStart = i;
      if (age >= minSpanMs) {
        break;
      }
    }

    const window = samples.slice(windowStart);
    if (window.length < 2) return this.calculate();

    const first = window[0]!;
    const last = window.at(-1)!;
    const span = last.time - first.time;
    if (span <= 0) return 0;

    const meanTime = window.reduce((sum, sample) => sum + sample.time, 0) / window.length;
    const meanValue = window.reduce((sum, sample) => sum + sample.value, 0) / window.length;

    let numerator = 0;
    let denominator = 0;

    for (const sample of window) {
      const dt = sample.time - meanTime;
      numerator += dt * (sample.value - meanValue);
      denominator += dt * dt;
    }

    return denominator > 0 ? numerator / denominator : 0;
  }

  /**
   * Return the last pairwise velocity backed by a plausible frame interval.
   *
   * This is not the primary fling estimator; it is a handoff guard. iOS can
   * emit tiny 1-3ms touch intervals near release, so this skips intervals that
   * are too short to represent a visible finger-to-frame movement.
   */
  calculateTerminalVelocity(
    minDeltaMs: number = DEFAULT_TERMINAL_MIN_DELTA_MS,
    maxDeltaMs: number = DEFAULT_TERMINAL_MAX_DELTA_MS,
  ): number | null {
    const samples = this.#getSamplesOldestFirst();
    if (samples.length < 2) return null;

    for (let i = samples.length - 1; i > 0; i--) {
      const current = samples[i]!;
      const previous = samples[i - 1]!;
      const deltaTime = current.time - previous.time;

      if (deltaTime >= minDeltaMs && deltaTime <= maxDeltaMs) {
        return (current.value - previous.value) / deltaTime;
      }
    }

    return null;
  }

  #getSamplesOldestFirst(): DataPoint[] {
    const samples: DataPoint[] = [];
    let index = this.#index;

    for (let i = 0; i < HISTORY_SIZE; i++) {
      const sample = this.#samples[index];
      if (!sample) break;
      samples.push(sample);
      index = index === 0 ? HISTORY_SIZE - 1 : index - 1;
    }

    samples.reverse();
    return samples;
  }

  /**
   * Reset the tracker, clearing all samples.
   * Call this at the start of each new gesture.
   */
  reset(): void {
    this.#samples.fill(null);
    this.#index = 0;
  }

  /**
   * Check if the velocity is approaching halt (near zero).
   * Useful for determining if momentum should be triggered.
   */
  static approachingHalt(horizontalVelocity: number, verticalVelocity: number): boolean {
    return horizontalVelocity * horizontalVelocity + verticalVelocity * verticalVelocity < 0.0625;
  }
}
