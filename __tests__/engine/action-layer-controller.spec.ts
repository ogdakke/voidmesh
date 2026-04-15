import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ActionLayerController } from "../../engine/action-layer-controller.ts";
import { canvasStore } from "../../engine/canvas-store.ts";
import { config } from "#config";
import { TestClock } from "../helpers/test-clock.ts";

describe("ActionLayerController", () => {
  let clock: TestClock;
  let controller: ActionLayerController;

  beforeEach(() => {
    canvasStore.reset();
    clock = new TestClock();
    controller = new ActionLayerController(clock.scheduler);
  });

  afterEach(() => {
    clock.restore();
  });

  test("dismiss after spring settles fades blur to 0", () => {
    // Activate the action layer
    controller.activate({ x: 200, y: 200 });
    expect(controller.isActive()).toBe(true);
    expect(clock.scheduler.hasActive).toBe(true);

    // Advance until blur reaches 1.0 and spring settles (finger never moved)
    clock.advanceUntilSettled();

    // Verify: blur is at target, animation has been removed by scheduler
    expect(controller.getBlurIntensity()).toBe(1);

    // Dismiss — this should animate blur back to 0

    controller.dismiss();

    // Advance through blur fade-out duration
    clock.advanceBy(config.actionLayer.blurFadeOutMs + 50);

    expect(controller.getBlurIntensity()).toBe(0);
    // Should have fully settled to idle
    clock.advanceUntilSettled();
    expect(controller.isActive()).toBe(false);
  });

  test("transitionToDrag after spring settles fades blur to 0", () => {
    controller.activate({ x: 200, y: 200 });
    clock.advanceUntilSettled();
    expect(controller.getBlurIntensity()).toBe(1);

    // Transition to drag — blur should fade out

    controller.transitionToDrag();

    clock.advanceBy(config.actionLayer.blurFadeOutMs + 50);

    // BUG: without fix, blur stays at 1.0
    expect(controller.getBlurIntensity()).toBe(0);
    clock.advanceUntilSettled();
    expect(controller.isActive()).toBe(false);
  });

  test("updateFingerPosition after spring settles re-activates spring", () => {
    controller.activate({ x: 200, y: 200 });
    clock.advanceUntilSettled();

    // Entity offset should be at 0 (finger never moved)
    expect(controller.getEntityOffset().x).toBeCloseTo(0, 1);

    // Move finger well beyond deadzone (deadzone is 70px)

    controller.updateFingerPosition({ x: 400, y: 200 }); // 200px to the right

    // Advance several frames — spring should chase the new target
    for (let i = 0; i < 20; i++) {
      clock.advanceBy(16);
    }

    // BUG: without fix, offset stays at 0 because no animation is running
    expect(Math.abs(controller.getEntityOffset().x)).toBeGreaterThan(1);
  });

  test("returning inside deadzone after settling springs back to origin", () => {
    controller.activate({ x: 200, y: 200 });

    controller.updateFingerPosition({ x: 400, y: 200 });
    clock.advanceUntilSettled();
    expect(Math.abs(controller.getEntityOffset().x)).toBeGreaterThan(1);

    controller.updateFingerPosition({ x: 200 + config.actionLayer.deadzone - 1, y: 200 });
    clock.advanceUntilSettled();

    expect(Math.abs(controller.getEntityOffset().x)).toBeLessThan(0.5);
  });

  test("active animation marks render state dirty while values are changing", () => {
    controller.activate({ x: 200, y: 200 });
    canvasStore.clearDirtyFlags();

    clock.advanceBy(16);
    canvasStore.clearDirtyFlags();
    clock.advanceBy(16);

    expect(canvasStore.getRenderState().dirty).toBe(true);
  });

  // ── Core behavior tests ─────────────────────────────────────────────────

  test("activate fades blur in from 0 to 1", () => {
    controller.activate({ x: 200, y: 200 });
    expect(controller.getBlurIntensity()).toBe(0);

    // Advance through blur fade-in
    clock.advanceBy(config.actionLayer.blurFadeInMs + 50);

    expect(controller.getBlurIntensity()).toBe(1);
  });

  test("cancel immediately resets everything", () => {
    controller.activate({ x: 200, y: 200 });

    // Move finger to create offset
    const deadzone = config.actionLayer.deadzone;
    controller.updateFingerPosition({ x: 200 + deadzone + 50, y: 200 });
    clock.advanceBy(100); // let spring start moving

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
      clock.advanceBy(16);
    }
    expect(Math.abs(controller.getEntityOffset().x)).toBeGreaterThan(1);

    // Dismiss — should spring back to origin

    controller.dismiss();

    // Advance enough for dismiss spring to settle
    clock.advanceUntilSettled(3000);

    const offset = controller.getEntityOffset();
    expect(Math.abs(offset.x)).toBeLessThan(0.5);
    expect(Math.abs(offset.y)).toBeLessThan(0.5);
    expect(controller.isActive()).toBe(false);
  });

  test("isInteractive during active, not during dismiss", () => {
    controller.activate({ x: 200, y: 200 });
    expect(controller.isInteractive()).toBe(true);

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

    controller.dismiss();
    clock.advanceUntilSettled();

    expect(controller.hasEntity("entity-1")).toBe(false);
    expect(controller.hasEntity("entity-2")).toBe(false);
  });
});
