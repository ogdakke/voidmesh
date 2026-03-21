import { vi, type Mock } from "vitest";
import { AnimationScheduler } from "#lib/animation-scheduler.ts";

/**
 * Deterministic time controller for animation tests.
 * Mocks performance.now() and provides helpers to advance time
 * while ticking an AnimationScheduler.
 *
 * @example
 * let clock: TestClock;
 * beforeEach(() => { clock = new TestClock(); });
 * afterEach(() => { clock.restore(); });
 *
 * test("spring settles", () => {
 *   scheduler.spring2D({ ... });
 *   clock.advanceBy(16);
 *   clock.advanceUntilSettled();
 * });
 */
export class TestClock {
  now: number;
  readonly scheduler: AnimationScheduler;
  #perfSpy: Mock<() => DOMHighResTimeStamp>;

  constructor(startTime = 1000) {
    this.now = startTime;
    this.scheduler = new AnimationScheduler();
    this.#perfSpy = vi.spyOn(performance, "now").mockReturnValue(this.now);
  }

  /** Advance to an absolute timestamp and tick the scheduler */
  advanceTo(time: number): void {
    this.now = time;
    this.#perfSpy.mockReturnValue(this.now);
    this.scheduler.tick(this.now);
  }

  /** Advance by a relative duration (ms) and tick the scheduler */
  advanceBy(ms: number): void {
    this.advanceTo(this.now + ms);
  }

  /** Advance in 16ms steps until scheduler settles or maxMs is reached */
  advanceUntilSettled(maxMs = 5000): void {
    const step = 16;
    for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
      this.advanceBy(step);
      if (!this.scheduler.hasActive) return;
    }
  }

  /** Clean up the performance.now spy */
  restore(): void {
    this.#perfSpy.mockRestore();
  }
}
