import { describe, test, expect, beforeEach } from "vitest";
import { AnimationScheduler } from "#lib/animation-scheduler.ts";
import type { Point } from "#types/canvas.ts";

describe("AnimationScheduler", () => {
  let s: AnimationScheduler;

  beforeEach(() => {
    s = new AnimationScheduler();
  });

  // ── hasActive ──────────────────────────────────────────────────────────

  test("initially has no active animations", () => {
    expect(s.hasActive).toBe(false);
  });

  // ── Tween ──────────────────────────────────────────────────────────────

  describe("tween", () => {
    test("interpolates linearly from → to", () => {
      const values: number[] = [];
      s.tween({ from: 0, to: 100, duration: 100, onUpdate: (v) => values.push(v) });

      s.tick(0); // start (progress 0)
      s.tick(50); // halfway
      s.tick(100); // complete

      expect(values[0]).toBeCloseTo(0);
      expect(values[1]).toBeCloseTo(50);
      expect(values[2]).toBeCloseTo(100);
    });

    test("applies easing function", () => {
      const values: number[] = [];
      const ease = (t: number) => t * t; // quadratic ease-in
      s.tween({ from: 0, to: 100, duration: 100, easing: ease, onUpdate: (v) => values.push(v) });

      s.tick(0);
      s.tick(50); // raw progress 0.5, eased 0.25
      expect(values[1]).toBeCloseTo(25);
    });

    test("clamps final value to 'to' on completion", () => {
      const values: number[] = [];
      s.tween({ from: 0, to: 100, duration: 100, onUpdate: (v) => values.push(v) });

      s.tick(0);
      s.tick(150); // overshoot duration
      expect(values[1]).toBeCloseTo(100);
    });

    test("fires onComplete when done", () => {
      let completed = false;
      s.tween({
        from: 0,
        to: 1,
        duration: 100,
        onUpdate: () => {},
        onComplete: () => {
          completed = true;
        },
      });

      s.tick(0);
      expect(completed).toBe(false);
      s.tick(100);
      expect(completed).toBe(true);
    });

    test("hasActive is true while running, false after completion", () => {
      s.tween({ from: 0, to: 1, duration: 100, onUpdate: () => {} });
      expect(s.hasActive).toBe(true);

      s.tick(0);
      expect(s.hasActive).toBe(true);

      s.tick(100);
      expect(s.hasActive).toBe(false);
    });

    test("supports negative interpolation (to < from)", () => {
      const values: number[] = [];
      s.tween({ from: 100, to: 0, duration: 100, onUpdate: (v) => values.push(v) });

      s.tick(0);
      s.tick(50);
      s.tick(100);

      expect(values[0]).toBeCloseTo(100);
      expect(values[1]).toBeCloseTo(50);
      expect(values[2]).toBeCloseTo(0);
    });
  });

  // ── Cancel ─────────────────────────────────────────────────────────────

  describe("cancel", () => {
    test("handle.cancel() stops animation", () => {
      const values: number[] = [];
      const handle = s.tween({ from: 0, to: 100, duration: 100, onUpdate: (v) => values.push(v) });

      s.tick(0);
      handle.cancel();
      s.tick(50);

      expect(values).toHaveLength(1); // only the first tick
      expect(s.hasActive).toBe(false);
    });

    test("cancel does not fire onComplete", () => {
      let completed = false;
      const handle = s.tween({
        from: 0,
        to: 1,
        duration: 100,
        onUpdate: () => {},
        onComplete: () => {
          completed = true;
        },
      });

      s.tick(0);
      handle.cancel();
      s.tick(100);

      expect(completed).toBe(false);
    });

    test("handle.isActive reflects state", () => {
      const handle = s.tween({ from: 0, to: 1, duration: 100, onUpdate: () => {} });
      expect(handle.isActive).toBe(true);

      handle.cancel();
      expect(handle.isActive).toBe(false);
    });

    test("handle.isActive becomes false after completion", () => {
      const handle = s.tween({ from: 0, to: 1, duration: 100, onUpdate: () => {} });
      s.tick(0);
      s.tick(100);
      expect(handle.isActive).toBe(false);
    });
  });

  // ── cancelByTag ────────────────────────────────────────────────────────

  describe("cancelByTag", () => {
    test("cancels all animations with matching tag", () => {
      s.tween({ from: 0, to: 1, duration: 100, tag: "viewport", onUpdate: () => {} });
      s.tween({ from: 0, to: 1, duration: 100, tag: "viewport", onUpdate: () => {} });
      s.tween({ from: 0, to: 1, duration: 100, tag: "other", onUpdate: () => {} });

      s.cancelByTag("viewport");

      expect(s.hasActive).toBe(true); // "other" still active
      s.tick(0);
      s.tick(100);
      expect(s.hasActive).toBe(false);
    });

    test("leaves untagged animations intact", () => {
      s.tween({ from: 0, to: 1, duration: 100, onUpdate: () => {} });
      s.tween({ from: 0, to: 1, duration: 100, tag: "remove", onUpdate: () => {} });

      s.cancelByTag("remove");

      // Untagged animation remains
      expect(s.hasActive).toBe(true);
    });

    test("does not fire onComplete for cancelled animations", () => {
      let completed = false;
      s.tween({
        from: 0,
        to: 1,
        duration: 100,
        tag: "x",
        onUpdate: () => {},
        onComplete: () => {
          completed = true;
        },
      });

      s.cancelByTag("x");
      s.tick(0);
      s.tick(100);

      expect(completed).toBe(false);
    });
  });

  // ── Spring2D ───────────────────────────────────────────────────────────

  describe("spring2D", () => {
    test("produces deltas that move toward zero offset", () => {
      const deltas: Point[] = [];
      s.spring2D({
        offset: { x: 100, y: 0 },
        velocity: { x: 0, y: 0 },
        response: 0.1,
        damping: 0.8,
        onUpdate: (dx, dy) => deltas.push({ x: dx, y: dy }),
      });

      s.tick(0); // initializes lastTime
      s.tick(16); // first real step

      expect(deltas.length).toBeGreaterThan(0);
      // Delta should be positive (reducing positive offset toward zero)
      const lastDelta = deltas.at(-1)!;
      expect(lastDelta.x).toBeGreaterThan(0);
    });

    test("eventually settles and fires onComplete with flush", () => {
      let flushed = false;
      s.spring2D({
        offset: { x: 10, y: 0 },
        velocity: { x: 0, y: 0 },
        response: 0.05,
        damping: 0.9,
        onUpdate: () => {},
        onComplete: () => {
          flushed = true;
        },
      });

      // Run many frames until settled
      let now = 0;
      s.tick(now);
      for (let i = 0; i < 200; i++) {
        now += 16;
        s.tick(now);
        if (!s.hasActive) break;
      }

      expect(s.hasActive).toBe(false);
      expect(flushed).toBe(true);
    });

    test("can be cancelled mid-flight", () => {
      const handle = s.spring2D({
        offset: { x: 100, y: 100 },
        velocity: { x: 0, y: 0 },
        response: 0.1,
        damping: 0.8,
        onUpdate: () => {},
      });

      s.tick(0);
      s.tick(16);
      handle.cancel();

      expect(s.hasActive).toBe(false);
      expect(handle.isActive).toBe(false);
    });
  });

  // ── Custom ─────────────────────────────────────────────────────────────

  describe("custom", () => {
    test("ticks until callback returns false", () => {
      let tickCount = 0;
      s.custom({
        tick: () => {
          tickCount++;
          return tickCount < 3;
        },
      });

      s.tick(0);
      s.tick(16);
      s.tick(32);

      expect(tickCount).toBe(3);
      expect(s.hasActive).toBe(false);
    });

    test("fires onComplete when tick returns false", () => {
      let completed = false;
      s.custom({
        tick: () => false,
        onComplete: () => {
          completed = true;
        },
      });

      s.tick(0);
      expect(completed).toBe(true);
    });

    test("passes now to tick callback", () => {
      const times: number[] = [];
      s.custom({
        tick: (now) => {
          times.push(now);
          return times.length < 3;
        },
      });

      s.tick(100);
      s.tick(200);
      s.tick(300);

      expect(times).toEqual([100, 200, 300]);
    });
  });

  // ── onComplete chaining ────────────────────────────────────────────────

  describe("onComplete chaining", () => {
    test("new animation started in onComplete is registered", () => {
      let phase2Ticked = false;

      s.tween({
        from: 0,
        to: 1,
        duration: 50,
        onUpdate: () => {},
        onComplete: () => {
          s.tween({
            from: 0,
            to: 1,
            duration: 50,
            onUpdate: () => {
              phase2Ticked = true;
            },
          });
        },
      });

      s.tick(0);
      s.tick(50); // phase 1 completes, phase 2 starts

      expect(s.hasActive).toBe(true);
      expect(phase2Ticked).toBe(false); // not ticked yet in this cycle

      s.tick(51); // phase 2 gets its first tick
      expect(phase2Ticked).toBe(true);
    });

    test("catch-up → snap-settle handoff pattern", () => {
      let catchUpCount = 0;
      let settleCount = 0;

      // Simulate catch-up spring that completes quickly
      s.spring2D({
        offset: { x: 5, y: 0 },
        velocity: { x: 0, y: 0 },
        response: 0.03,
        damping: 0.95,
        onUpdate: () => catchUpCount++,
        onComplete: () => {
          // Start snap-settle on completion
          s.spring2D({
            offset: { x: 3, y: 0 },
            velocity: { x: 0, y: 0 },
            response: 0.03,
            damping: 0.95,
            tag: "snap-settle",
            onUpdate: () => settleCount++,
          });
        },
      });

      // Run until both settle
      let now = 0;
      for (let i = 0; i < 300; i++) {
        s.tick(now);
        now += 16;
        if (!s.hasActive) break;
      }

      expect(catchUpCount).toBeGreaterThan(0);
      expect(settleCount).toBeGreaterThan(0);
      expect(s.hasActive).toBe(false);
    });
  });

  // ── Multiple concurrent animations ─────────────────────────────────────

  describe("concurrent animations", () => {
    test("ticks all active animations each frame", () => {
      let a = 0;
      let b = 0;

      s.tween({ from: 0, to: 10, duration: 100, onUpdate: (v) => (a = v) });
      s.tween({ from: 0, to: 20, duration: 100, onUpdate: (v) => (b = v) });

      s.tick(0);
      s.tick(50);

      expect(a).toBeCloseTo(5);
      expect(b).toBeCloseTo(10);
    });

    test("animations complete independently", () => {
      s.tween({ from: 0, to: 1, duration: 50, onUpdate: () => {} });
      s.tween({ from: 0, to: 1, duration: 100, onUpdate: () => {} });

      s.tick(0);
      s.tick(50); // first completes
      expect(s.hasActive).toBe(true); // second still running

      s.tick(100); // second completes
      expect(s.hasActive).toBe(false);
    });
  });
});
