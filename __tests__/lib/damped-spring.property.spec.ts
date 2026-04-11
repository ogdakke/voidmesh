/**
 * Property-based tests for DampedSpring2D physics simulation.
 *
 * Tests energy decay, zero-input behavior, flush semantics,
 * and convergence properties.
 */
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { DampedSpring2D } from "#lib/touch-scroll/damped-spring.ts";

// ── Arbitraries ─────────────────────────────────────────────────────

const coordinate = () => fc.double({ min: -1000, max: 1000, noNaN: true });

const point = () => fc.record({ x: coordinate(), y: coordinate() });

/** Response time in seconds (reasonable physics range) */
const response = () => fc.double({ min: 0.05, max: 2, noNaN: true });

/** Damping ratio (must be < 1 for underdamped) */
const damping = () => fc.double({ min: 0.1, max: 0.99, noNaN: true });

/** Time step in seconds */
const dt = () => fc.double({ min: 0.001, max: 0.1, noNaN: true });

// ── Properties ──────────────────────────────────────────────────────

describe("DampedSpring2D (property-based)", () => {
  test("zero offset and velocity → inactive immediately", () => {
    fc.assert(
      fc.property(response(), damping(), (resp, damp) => {
        const spring = new DampedSpring2D();
        spring.start({ x: 0, y: 0 }, { x: 0, y: 0 }, resp, damp);
        expect(spring.active).toBe(false);
      }),
    );
  });

  test("step(0) produces zero delta", () => {
    fc.assert(
      fc.property(point(), point(), response(), damping(), (offset, velocity, resp, damp) => {
        const spring = new DampedSpring2D();
        spring.start(offset, velocity, resp, damp);
        spring.step(0);
        expect(spring.deltaX).toBe(0);
        expect(spring.deltaY).toBe(0);
      }),
    );
  });

  test("negative dt produces zero delta", () => {
    fc.assert(
      fc.property(point(), point(), response(), damping(), (offset, velocity, resp, damp) => {
        const spring = new DampedSpring2D();
        spring.start(offset, velocity, resp, damp);
        spring.step(-0.016);
        expect(spring.deltaX).toBe(0);
        expect(spring.deltaY).toBe(0);
      }),
    );
  });

  test("spring eventually settles (becomes inactive after enough steps)", () => {
    fc.assert(
      fc.property(
        point(),
        response(),
        // Use higher minimum damping — very low damping with long response
        // can take thousands of frames to settle
        fc.double({ min: 0.3, max: 0.99, noNaN: true }),
        (offset, resp, damp) => {
          const spring = new DampedSpring2D();
          spring.start(offset, { x: 0, y: 0 }, resp, damp);

          // Step for ~30 simulated seconds (1875 frames @ 60fps)
          for (let i = 0; i < 1875; i++) {
            spring.step(0.016);
            if (!spring.active) break;
          }

          expect(spring.active).toBe(false);
        },
      ),
    );
  });

  test("flush extracts remaining offset and zeroes state", () => {
    fc.assert(
      fc.property(point(), response(), damping(), (offset, resp, damp) => {
        const spring = new DampedSpring2D();
        spring.start(offset, { x: 0, y: 0 }, resp, damp);

        // Take a few steps to get some partial state
        spring.step(0.016);
        spring.step(0.016);

        // Flush should extract whatever offset remains
        spring.flush();
        // After flush, spring should be inactive (offset and velocity are zero)
        expect(spring.active).toBe(false);
      }),
    );
  });

  test("reset zeroes all state", () => {
    fc.assert(
      fc.property(point(), point(), response(), damping(), (offset, velocity, resp, damp) => {
        const spring = new DampedSpring2D();
        spring.start(offset, velocity, resp, damp);
        spring.step(0.016);
        spring.reset();

        expect(spring.active).toBe(false);
        expect(spring.deltaX).toBe(0);
        expect(spring.deltaY).toBe(0);
      }),
    );
  });

  test("higher damping settles faster", () => {
    fc.assert(
      fc.property(fc.double({ min: 10, max: 500, noNaN: true }), response(), (offsetMag, resp) => {
        const offset = { x: offsetMag, y: 0 };
        const velocity = { x: 0, y: 0 };

        // Low damping
        const springLow = new DampedSpring2D();
        springLow.start(offset, velocity, resp, 0.3);

        // High damping
        const springHigh = new DampedSpring2D();
        springHigh.start(offset, velocity, resp, 0.9);

        // Step both for same time
        let lowSteps = 0;
        let highSteps = 0;
        const maxSteps = 2000;

        for (let i = 0; i < maxSteps; i++) {
          if (springLow.active) {
            springLow.step(0.016);
            lowSteps = i + 1;
          }
          if (springHigh.active) {
            springHigh.step(0.016);
            highSteps = i + 1;
          }
          if (!springLow.active && !springHigh.active) break;
        }

        // Higher damping should settle in fewer or equal steps
        expect(highSteps).toBeLessThanOrEqual(lowSteps);
      }),
    );
  });

  test("delta sum approximates initial offset (with zero initial velocity)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        response(),
        damping(),
        (ox, oy, resp, damp) => {
          const spring = new DampedSpring2D();
          spring.start({ x: ox, y: oy }, { x: 0, y: 0 }, resp, damp);

          let totalDeltaX = 0;
          let totalDeltaY = 0;

          // Step until settled
          for (let i = 0; i < 2000; i++) {
            spring.step(0.016);
            totalDeltaX += spring.deltaX;
            totalDeltaY += spring.deltaY;
            if (!spring.active) break;
          }

          // Flush any remaining
          spring.flush();
          totalDeltaX += spring.deltaX;
          totalDeltaY += spring.deltaY;

          // Total delta should approximately equal initial offset
          // (spring decays toward 0, so total correction ≈ initial offset)
          expect(totalDeltaX).toBeCloseTo(ox, 0);
          expect(totalDeltaY).toBeCloseTo(oy, 0);
        },
      ),
    );
  });
});
