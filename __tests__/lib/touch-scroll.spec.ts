/**
 * Tests for touch scroll utilities (iOS-like momentum scrolling)
 */
import { describe, test, expect, beforeEach } from "vitest";
import { VelocityTracker, Scroller, DecelerationRate } from "#lib/touch-scroll/index.ts";

describe("VelocityTracker", () => {
  let tracker: VelocityTracker;

  beforeEach(() => {
    tracker = new VelocityTracker();
  });

  describe("calculate", () => {
    test("returns 0 with no samples", () => {
      expect(tracker.calculate()).toBe(0);
    });

    test("returns 0 with only one sample", () => {
      tracker.addDataPoint(0, 100);
      expect(tracker.calculate()).toBe(0);
    });

    test("calculates positive velocity for increasing position", () => {
      tracker.addDataPoint(0, 100);
      tracker.addDataPoint(10, 110);
      const velocity = tracker.calculate();
      expect(velocity).toBeGreaterThan(0);
    });

    test("calculates negative velocity for decreasing position", () => {
      tracker.addDataPoint(0, 100);
      tracker.addDataPoint(10, 90);
      const velocity = tracker.calculate();
      expect(velocity).toBeLessThan(0);
    });

    test("dampens velocity when only 2 samples are available", () => {
      // With only 2 samples, raw velocity = (110-100)/10 = 1.0 px/ms
      // Should be dampened by 0.7x to reduce spikes from short gestures
      tracker.addDataPoint(0, 100);
      tracker.addDataPoint(10, 110);
      const velocity = tracker.calculate();
      expect(velocity).toBeCloseTo(0.7, 1);
    });

    test("returns approximately correct velocity for uniform motion", () => {
      // Moving at 1 pixel per millisecond
      tracker.addDataPoint(0, 0);
      tracker.addDataPoint(10, 10);
      tracker.addDataPoint(20, 20);
      tracker.addDataPoint(30, 30);
      const velocity = tracker.calculate();
      // Should be close to 1.0 (might vary due to weighted averaging)
      expect(velocity).toBeCloseTo(1.0, 1);
    });

    test("handles rapid consecutive samples", () => {
      tracker.addDataPoint(0, 0);
      tracker.addDataPoint(1, 2);
      tracker.addDataPoint(2, 4);
      tracker.addDataPoint(3, 6);
      const velocity = tracker.calculate();
      expect(velocity).toBeGreaterThan(0);
    });

    test("handles samples with same timestamp", () => {
      tracker.addDataPoint(0, 0);
      tracker.addDataPoint(0, 10); // Same time, different position
      tracker.addDataPoint(10, 20);
      // Should not throw, should return some velocity
      const velocity = tracker.calculate();
      expect(typeof velocity).toBe("number");
      expect(Number.isFinite(velocity)).toBe(true);
    });

    test("linear regression avoids tiny-interval release spikes", () => {
      // Captured from a fast iOS flick: two 1-2ms intervals produce an
      // unrealistic pairwise release velocity, but the whole gesture is sane.
      tracker.addDataPoint(0, 142.67);
      tracker.addDataPoint(9, 147);
      tracker.addDataPoint(11, 179.33);
      tracker.addDataPoint(24, 189.67);
      tracker.addDataPoint(25, 228);
      tracker.addDataPoint(41, 243.67);

      expect(tracker.calculate()).toBeGreaterThan(10);
      expect(tracker.calculateLinearRegression()).toBeLessThan(4);
    });

    test("terminal velocity skips tiny release intervals", () => {
      tracker.addDataPoint(0, 0);
      tracker.addDataPoint(16, 16);
      tracker.addDataPoint(17, 48);

      expect(tracker.calculateTerminalVelocity()).toBeCloseTo(1);
    });

    test("terminal velocity returns null without a frame-sized interval", () => {
      tracker.addDataPoint(0, 0);
      tracker.addDataPoint(1, 8);
      tracker.addDataPoint(3, 16);

      expect(tracker.calculateTerminalVelocity()).toBeNull();
    });
  });

  describe("reset", () => {
    test("clears all samples", () => {
      tracker.addDataPoint(0, 0);
      tracker.addDataPoint(10, 100);
      tracker.reset();
      expect(tracker.calculate()).toBe(0);
    });

    test("allows adding new samples after reset", () => {
      tracker.addDataPoint(0, 0);
      tracker.addDataPoint(10, 100);
      tracker.reset();

      tracker.addDataPoint(100, 0);
      tracker.addDataPoint(110, 50);
      const velocity = tracker.calculate();
      expect(velocity).toBeGreaterThan(0);
    });
  });

  describe("approachingHalt", () => {
    test("returns true for zero velocity", () => {
      expect(VelocityTracker.approachingHalt(0, 0)).toBe(true);
    });

    test("returns true for very small velocities", () => {
      expect(VelocityTracker.approachingHalt(0.1, 0.1)).toBe(true);
      expect(VelocityTracker.approachingHalt(-0.1, 0.1)).toBe(true);
    });

    test("returns false for significant velocity", () => {
      expect(VelocityTracker.approachingHalt(1, 0)).toBe(false);
      expect(VelocityTracker.approachingHalt(0, 1)).toBe(false);
      expect(VelocityTracker.approachingHalt(0.5, 0.5)).toBe(false);
    });

    test("uses combined magnitude (Pythagorean)", () => {
      // sqrt(0.2^2 + 0.2^2) = sqrt(0.08) ≈ 0.28 > 0.25
      expect(VelocityTracker.approachingHalt(0.2, 0.2)).toBe(false);
      // sqrt(0.15^2 + 0.15^2) = sqrt(0.045) ≈ 0.21 < 0.25
      expect(VelocityTracker.approachingHalt(0.15, 0.15)).toBe(true);
    });
  });

  describe("circular buffer behavior", () => {
    test("handles more than HISTORY_SIZE samples", () => {
      // Add more than 20 samples (HISTORY_SIZE)
      for (let i = 0; i <= 30; i++) {
        tracker.addDataPoint(i * 10, i * 5);
      }
      // Should still calculate correctly using most recent samples
      const velocity = tracker.calculate();
      expect(velocity).toBeGreaterThan(0);
      expect(Number.isFinite(velocity)).toBe(true);
    });
  });
});

describe("Scroller", () => {
  describe("constructor", () => {
    test("creates scroller with default deceleration rate", () => {
      const scroller = new Scroller();
      // Initial state should not produce any animation
      expect(scroller.value(0)).toBe(null);
    });

    test("creates scroller with custom deceleration rate", () => {
      const scroller = new Scroller(DecelerationRate.FAST);
      // Should not throw
      scroller.fling(1);
      expect(scroller.value(0)).not.toBe(null);
    });
  });

  describe("fling", () => {
    test("starts animation with given velocity", () => {
      const scroller = new Scroller();
      scroller.fling(1);
      const value = scroller.value(0);
      expect(value).not.toBe(null);
      expect(value?.velocity).toBeCloseTo(1, 5);
    });

    test("handles positive velocity", () => {
      const scroller = new Scroller();
      scroller.fling(2);
      const value = scroller.value(0);
      expect(value?.velocity).toBeGreaterThan(0);
    });

    test("handles negative velocity", () => {
      const scroller = new Scroller();
      scroller.fling(-2);
      const value = scroller.value(0);
      expect(value?.velocity).toBeLessThan(0);
    });
  });

  describe("value", () => {
    test("returns null when not flung", () => {
      const scroller = new Scroller();
      expect(scroller.value(0)).toBe(null);
      expect(scroller.value(100)).toBe(null);
    });

    test("returns offset and velocity at time 0", () => {
      const scroller = new Scroller();
      scroller.fling(1);
      const value = scroller.value(0);
      expect(value).not.toBe(null);
      expect(value?.offset).toBeCloseTo(0, 5);
      expect(value?.velocity).toBeCloseTo(1, 5);
    });

    test("velocity decreases over time", () => {
      const scroller = new Scroller();
      scroller.fling(1);
      const v0 = scroller.value(0)?.velocity ?? 0;
      const v100 = scroller.value(100)?.velocity ?? 0;
      const v500 = scroller.value(500)?.velocity ?? 0;

      expect(Math.abs(v100)).toBeLessThan(Math.abs(v0));
      expect(Math.abs(v500)).toBeLessThan(Math.abs(v100));
    });

    test("offset increases over time (for positive velocity)", () => {
      const scroller = new Scroller();
      scroller.fling(1);
      const o0 = scroller.value(0)?.offset ?? 0;
      const o100 = scroller.value(100)?.offset ?? 0;
      const o500 = scroller.value(500)?.offset ?? 0;

      expect(o100).toBeGreaterThan(o0);
      expect(o500).toBeGreaterThan(o100);
    });

    test("offset decreases over time (for negative velocity)", () => {
      const scroller = new Scroller();
      scroller.fling(-1);
      const o0 = scroller.value(0)?.offset ?? 0;
      const o100 = scroller.value(100)?.offset ?? 0;
      const o500 = scroller.value(500)?.offset ?? 0;

      expect(o100).toBeLessThan(o0);
      expect(o500).toBeLessThan(o100);
    });

    test("returns null when velocity falls below threshold", () => {
      const scroller = new Scroller();
      scroller.fling(0.1); // Small initial velocity

      // At some point, animation should complete
      let completed = false;
      for (let t = 0; t <= 10000; t += 100) {
        if (scroller.value(t) === null) {
          completed = true;
          break;
        }
      }
      expect(completed).toBe(true);
    });

    test("FAST deceleration completes sooner than NORMAL", () => {
      const scrollerFast = new Scroller(DecelerationRate.FAST);
      const scrollerNormal = new Scroller(DecelerationRate.NORMAL);

      scrollerFast.fling(1);
      scrollerNormal.fling(1);

      // Find when each completes
      let fastCompleteTime = -1;
      let normalCompleteTime = -1;

      for (let t = 0; t <= 10000; t += 10) {
        if (fastCompleteTime < 0 && scrollerFast.value(t) === null) {
          fastCompleteTime = t;
        }
        if (normalCompleteTime < 0 && scrollerNormal.value(t) === null) {
          normalCompleteTime = t;
        }
        if (fastCompleteTime >= 0 && normalCompleteTime >= 0) break;
      }

      expect(fastCompleteTime).toBeGreaterThan(0);
      expect(normalCompleteTime).toBeGreaterThan(0);
      expect(fastCompleteTime).toBeLessThan(normalCompleteTime);
    });
  });

  describe("reset", () => {
    test("stops animation", () => {
      const scroller = new Scroller();
      scroller.fling(1);
      expect(scroller.value(0)).not.toBe(null);

      scroller.reset();
      expect(scroller.value(0)).toBe(null);
    });

    test("allows starting new animation after reset", () => {
      const scroller = new Scroller();
      scroller.fling(1);
      scroller.reset();
      scroller.fling(2);

      const value = scroller.value(0);
      expect(value).not.toBe(null);
      expect(value?.velocity).toBeCloseTo(2, 5);
    });
  });

  describe("setDecelerationRate", () => {
    test("changes deceleration rate", () => {
      const scroller = new Scroller(DecelerationRate.NORMAL);
      scroller.setDecelerationRate(DecelerationRate.FAST);
      scroller.fling(1);

      // Velocity should decay faster with FAST rate
      const v500 = scroller.value(500)?.velocity ?? 0;

      const scrollerNormal = new Scroller(DecelerationRate.NORMAL);
      scrollerNormal.fling(1);
      const v500Normal = scrollerNormal.value(500)?.velocity ?? 0;

      expect(Math.abs(v500)).toBeLessThan(Math.abs(v500Normal));
    });
  });

  describe("setVelocityThreshold", () => {
    test("uses updated threshold to settle tiny tail movement", () => {
      const scroller = new Scroller(DecelerationRate.FAST);
      scroller.setVelocityThreshold(0.05);
      scroller.fling(0.04);

      expect(scroller.value(0)).toBe(null);
    });
  });

  describe("getInitialVelocity", () => {
    test("returns the flung velocity", () => {
      const scroller = new Scroller();
      scroller.fling(1.5);
      expect(scroller.getInitialVelocity()).toBe(1.5);
    });

    test("returns 0 before fling", () => {
      const scroller = new Scroller();
      expect(scroller.getInitialVelocity()).toBe(0);
    });

    test("returns 0 after reset", () => {
      const scroller = new Scroller();
      scroller.fling(1);
      scroller.reset();
      expect(scroller.getInitialVelocity()).toBe(0);
    });
  });
});
