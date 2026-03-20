import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { AnimationScheduler } from "#lib/animation-scheduler.ts";
import { ActionLayerController } from "../../engine/action-layer-controller.ts";
import { config } from "#config";

describe("ActionLayerController", () => {
  let scheduler: AnimationScheduler;
  let controller: ActionLayerController;
  let now: number;
  let perfSpy: ReturnType<typeof vi.spyOn>;

  function advanceTo(time: number): void {
    now = time;
    perfSpy.mockReturnValue(now);
    scheduler.tick(now);
  }

  function advanceBy(ms: number): void {
    advanceTo(now + ms);
  }

  /** Advance frames until the scheduler animation dies or maxMs is reached. */
  function advanceUntilSettled(maxMs = 5000): void {
    const step = 16;
    for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
      advanceBy(step);
      if (!scheduler.hasActive) return;
    }
  }

  beforeEach(() => {
    now = 1000; // start at 1s to avoid edge cases near 0
    perfSpy = vi.spyOn(performance, "now").mockReturnValue(now);
    scheduler = new AnimationScheduler();
    controller = new ActionLayerController(scheduler);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Bug reproductions (should FAIL before fix) ──────────────────────────

  test("dismiss after spring settles fades blur to 0", () => {
    // Activate the action layer
    controller.activate({ x: 200, y: 200 });
    expect(controller.isActive()).toBe(true);
    expect(scheduler.hasActive).toBe(true);

    // Advance until blur reaches 1.0 and spring settles (finger never moved)
    advanceUntilSettled();

    // Verify: blur is at target, animation has been removed by scheduler
    expect(controller.getBlurIntensity()).toBe(1);

    // Dismiss — this should animate blur back to 0
    perfSpy.mockReturnValue(now);
    controller.dismiss();

    // Advance through blur fade-out duration
    advanceBy(config.actionLayer.blurFadeOutMs + 50);

    // BUG: without fix, blur stays at 1.0 because no animation is running
    expect(controller.getBlurIntensity()).toBe(0);
    // Should have fully settled to idle
    advanceUntilSettled();
    expect(controller.isActive()).toBe(false);
  });

  test("transitionToDrag after spring settles fades blur to 0", () => {
    controller.activate({ x: 200, y: 200 });
    advanceUntilSettled();
    expect(controller.getBlurIntensity()).toBe(1);

    // Transition to drag — blur should fade out
    perfSpy.mockReturnValue(now);
    controller.transitionToDrag();

    advanceBy(config.actionLayer.blurFadeOutMs + 50);

    // BUG: without fix, blur stays at 1.0
    expect(controller.getBlurIntensity()).toBe(0);
    advanceUntilSettled();
    expect(controller.isActive()).toBe(false);
  });

  test("updateFingerPosition after spring settles re-activates spring", () => {
    controller.activate({ x: 200, y: 200 });
    advanceUntilSettled();

    // Entity offset should be at 0 (finger never moved)
    expect(controller.getEntityOffset().x).toBeCloseTo(0, 1);

    // Move finger well beyond deadzone (deadzone is 70px)
    perfSpy.mockReturnValue(now);
    controller.updateFingerPosition({ x: 400, y: 200 }); // 200px to the right

    // Advance several frames — spring should chase the new target
    for (let i = 0; i < 20; i++) {
      advanceBy(16);
    }

    // BUG: without fix, offset stays at 0 because no animation is running
    expect(Math.abs(controller.getEntityOffset().x)).toBeGreaterThan(1);
  });

  // ── Core behavior tests ─────────────────────────────────────────────────

  test("activate fades blur in from 0 to 1", () => {
    controller.activate({ x: 200, y: 200 });
    expect(controller.getBlurIntensity()).toBe(0);

    // Advance through blur fade-in
    advanceBy(config.actionLayer.blurFadeInMs + 50);

    expect(controller.getBlurIntensity()).toBe(1);
  });

  test("cancel immediately resets everything", () => {
    controller.activate({ x: 200, y: 200 });

    // Move finger to create offset
    const deadzone = config.actionLayer.deadzone;
    controller.updateFingerPosition({ x: 200 + deadzone + 50, y: 200 });
    advanceBy(100); // let spring start moving

    // Cancel
    controller.cancel();

    expect(controller.getBlurIntensity()).toBe(0);
    expect(controller.isActive()).toBe(false);
    expect(controller.getEntityOffset().x).toBe(0);
    expect(controller.getEntityOffset().y).toBe(0);
  });

  test("dismiss springs entity offset back to origin", () => {
    controller.activate({ x: 200, y: 200 });

    // Move finger beyond deadzone
    const deadzone = config.actionLayer.deadzone;
    controller.updateFingerPosition({ x: 200 + deadzone + 80, y: 200 });

    // Let spring track toward target
    for (let i = 0; i < 30; i++) {
      advanceBy(16);
    }
    expect(Math.abs(controller.getEntityOffset().x)).toBeGreaterThan(1);

    // Dismiss — should spring back to origin
    perfSpy.mockReturnValue(now);
    controller.dismiss();

    // Advance enough for dismiss spring to settle
    advanceUntilSettled(3000);

    const offset = controller.getEntityOffset();
    expect(Math.abs(offset.x)).toBeLessThan(0.5);
    expect(Math.abs(offset.y)).toBeLessThan(0.5);
    expect(controller.isActive()).toBe(false);
  });

  test("isInteractive during active, not during dismiss", () => {
    controller.activate({ x: 200, y: 200 });
    expect(controller.isInteractive()).toBe(true);

    perfSpy.mockReturnValue(now);
    controller.dismiss();
    expect(controller.isInteractive()).toBe(false);
  });

  test("hasEntity tracks IDs through lifecycle", () => {
    const ids = new Set(["entity-1", "entity-2"]);
    controller.activate({ x: 200, y: 200 }, ids);

    expect(controller.hasEntity("entity-1")).toBe(true);
    expect(controller.hasEntity("entity-2")).toBe(true);
    expect(controller.hasEntity("other")).toBe(false);

    // Dismiss and settle to idle
    perfSpy.mockReturnValue(now);
    controller.dismiss();
    advanceUntilSettled();

    expect(controller.hasEntity("entity-1")).toBe(false);
    expect(controller.hasEntity("entity-2")).toBe(false);
  });
});
