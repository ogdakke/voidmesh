import { describe, test, expect, beforeEach } from "vitest";
import { AnimationScheduler } from "#lib/animation-scheduler.ts";
import { easings } from "#lib/canvas-math.ts";
import { ViewportAnimationController, type ViewportStore } from "#engine";
import type { Viewport } from "#types/canvas.ts";

describe("ViewportAnimationController", () => {
  let scheduler: AnimationScheduler;
  let controller: ViewportAnimationController;
  let viewport: Viewport;
  let store: ViewportStore;

  /** Mock container with clientWidth/clientHeight for screen center calculation */
  const mockContainer = {
    clientWidth: 800,
    clientHeight: 600,
  } as HTMLElement;

  beforeEach(() => {
    scheduler = new AnimationScheduler();
    viewport = { offset: { x: 0, y: 0 }, zoom: 1 };
    store = {
      getViewport: () => ({ offset: { ...viewport.offset }, zoom: viewport.zoom }),
      setViewport: (v) => {
        viewport = { offset: { ...v.offset }, zoom: v.zoom };
      },
    };
    controller = new ViewportAnimationController(scheduler, store);
    controller.setContainer(mockContainer);
  });

  test("animateTo transitions viewport over duration", () => {
    const target: Viewport = { offset: { x: 100, y: 100 }, zoom: 2 };
    controller.animateTo(target, { duration: 300 });

    scheduler.tick(0);
    scheduler.tick(300);

    expect(viewport.offset.x).toBeCloseTo(target.offset.x);
    expect(viewport.offset.y).toBeCloseTo(target.offset.y);
    expect(viewport.zoom).toBeCloseTo(2, 1);
  });

  test("destination center follows a straight screen-space path across a large zoom change", () => {
    viewport = { offset: { x: -20_000, y: 8_000 }, zoom: 0.01 };
    const target: Viewport = { offset: { x: 1_200, y: -600 }, zoom: 1.35 };
    const dpr = window.devicePixelRatio;
    const screenCenter = {
      x: (mockContainer.clientWidth * dpr) / 2,
      y: (mockContainer.clientHeight * dpr) / 2,
    };
    const destinationWorldCenter = {
      x: target.offset.x + screenCenter.x / target.zoom,
      y: target.offset.y + screenCenter.y / target.zoom,
    };
    const destinationStartScreenPosition = {
      x: (destinationWorldCenter.x - viewport.offset.x) * viewport.zoom,
      y: (destinationWorldCenter.y - viewport.offset.y) * viewport.zoom,
    };

    controller.animateTo(target, { duration: 300, easing: (t) => t });
    scheduler.tick(0);
    scheduler.tick(150);

    const destinationMidScreenPosition = {
      x: (destinationWorldCenter.x - viewport.offset.x) * viewport.zoom,
      y: (destinationWorldCenter.y - viewport.offset.y) * viewport.zoom,
    };

    expect(destinationMidScreenPosition.x).toBeCloseTo(
      (destinationStartScreenPosition.x + screenCenter.x) / 2,
    );
    expect(destinationMidScreenPosition.y).toBeCloseTo(
      (destinationStartScreenPosition.y + screenCenter.y) / 2,
    );
  });

  test("destination center uses balanced pacing instead of arriving early with zoom", () => {
    viewport = { offset: { x: -20_000, y: 8_000 }, zoom: 0.01 };
    const target: Viewport = { offset: { x: 1_200, y: -600 }, zoom: 1.35 };
    const dpr = window.devicePixelRatio;
    const screenCenter = {
      x: (mockContainer.clientWidth * dpr) / 2,
      y: (mockContainer.clientHeight * dpr) / 2,
    };
    const destinationWorldCenter = {
      x: target.offset.x + screenCenter.x / target.zoom,
      y: target.offset.y + screenCenter.y / target.zoom,
    };
    const destinationStartScreenPosition = {
      x: (destinationWorldCenter.x - viewport.offset.x) * viewport.zoom,
      y: (destinationWorldCenter.y - viewport.offset.y) * viewport.zoom,
    };

    controller.animateTo(target, {
      duration: 400,
      easing: easings.easeOutCubic,
    });
    scheduler.tick(0);
    scheduler.tick(100);

    const destinationScreenPosition = {
      x: (destinationWorldCenter.x - viewport.offset.x) * viewport.zoom,
      y: (destinationWorldCenter.y - viewport.offset.y) * viewport.zoom,
    };
    const expectedPositionProgress = easings.easeInOut(0.25);

    expect(destinationScreenPosition.x).toBeCloseTo(
      destinationStartScreenPosition.x +
        (screenCenter.x - destinationStartScreenPosition.x) * expectedPositionProgress,
    );
    expect(destinationScreenPosition.y).toBeCloseTo(
      destinationStartScreenPosition.y +
        (screenCenter.y - destinationStartScreenPosition.y) * expectedPositionProgress,
    );
  });

  test("animateTo without container sets viewport instantly", () => {
    const noContainerCtrl = new ViewportAnimationController(scheduler, store);
    // No setContainer call
    const target: Viewport = { offset: { x: 50, y: 50 }, zoom: 3 };
    noContainerCtrl.animateTo(target);

    expect(viewport.offset.x).toBeCloseTo(50);
    expect(viewport.offset.y).toBeCloseTo(50);
    expect(viewport.zoom).toBeCloseTo(3);
    expect(noContainerCtrl.isAnimating).toBe(false);
  });

  test("cancel stops animation mid-flight", () => {
    const target: Viewport = { offset: { x: 200, y: 0 }, zoom: 1 };
    controller.animateTo(target, { duration: 300 });

    scheduler.tick(0);
    scheduler.tick(150); // halfway
    controller.cancel();

    expect(controller.isAnimating).toBe(false);

    // Viewport should be frozen at halfway point, not at target
    const frozenZoom = viewport.zoom;
    scheduler.tick(300);
    expect(viewport.zoom).toBe(frozenZoom); // unchanged after cancel
  });

  test("new animateTo cancels previous animation", () => {
    const target1: Viewport = { offset: { x: 100, y: 0 }, zoom: 1 };
    const target2: Viewport = { offset: { x: 200, y: 0 }, zoom: 1 };

    controller.animateTo(target1, { duration: 300 });
    scheduler.tick(0);
    scheduler.tick(100); // partway through first

    controller.animateTo(target2, { duration: 300 });
    scheduler.tick(100); // start second
    scheduler.tick(400); // complete second

    // Should be at target2, not target1
    expect(viewport.zoom).toBeCloseTo(1);
  });

  test("onComplete fires when animation finishes", () => {
    let completed = false;
    const target: Viewport = { offset: { x: 50, y: 50 }, zoom: 2 };
    controller.animateTo(target, { duration: 200, onComplete: () => (completed = true) });

    scheduler.tick(0);
    expect(completed).toBe(false);
    scheduler.tick(200);
    expect(completed).toBe(true);
  });

  test("animateTo to same viewport is a no-op", () => {
    let completed = false;
    const target: Viewport = { offset: { x: 0, y: 0 }, zoom: 1 }; // same as initial
    controller.animateTo(target, { onComplete: () => (completed = true) });

    // onComplete fires immediately, no animation started
    expect(completed).toBe(true);
    expect(controller.isAnimating).toBe(false);
  });

  test("isAnimating reflects animation state", () => {
    expect(controller.isAnimating).toBe(false);

    controller.animateTo({ offset: { x: 100, y: 0 }, zoom: 2 }, { duration: 100 });
    expect(controller.isAnimating).toBe(true);

    scheduler.tick(0);
    scheduler.tick(100);
    expect(controller.isAnimating).toBe(false);
  });
});
