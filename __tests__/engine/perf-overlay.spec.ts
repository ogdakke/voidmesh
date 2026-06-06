import { describe, expect, test } from "vitest";
import { PerfOverlayController } from "../../engine/perf-overlay.ts";

const FRAME_STATS = {
  renderTime: 4,
  entityCount: 2,
  renderedCount: 1,
};

function createController() {
  const controller = new PerfOverlayController();
  const element = document.createElement("div");
  controller.setElement(element);
  return { controller, element };
}

describe("PerfOverlayController", () => {
  test("calculates rAF FPS over a stats.js-style one-second window", () => {
    const { controller } = createController();
    const start = 1000;

    for (let i = 0; i <= 60; i++) {
      controller.onFrame(true, start + i * (1000 / 60));
    }

    const snapshot = controller.getSnapshot();
    expect(snapshot.rafFps).toBeCloseTo(60, 1);
    expect(snapshot.sampleCount).toBe(1);
    controller.destroy();
  });

  test("calculates rendered FPS separately from rAF FPS", () => {
    const { controller, element } = createController();
    const start = 1000;

    element.click();
    for (let i = 0; i <= 30; i++) {
      const timestamp = start + i * (1000 / 30);
      controller.onFrame(true, timestamp);
      controller.onRender(FRAME_STATS, true, timestamp);
    }

    const snapshot = controller.getSnapshot();
    expect(snapshot.mode).toBe("rendered");
    expect(snapshot.renderedFps).toBeCloseTo(30, 1);
    expect(snapshot.sampleCount).toBe(1);
    controller.destroy();
  });

  test("toggles graph mode when clicked", () => {
    const { controller, element } = createController();

    expect(controller.getSnapshot().mode).toBe("raf");
    element.click();
    expect(controller.getSnapshot().mode).toBe("rendered");
    element.click();
    expect(controller.getSnapshot().mode).toBe("raf");
    controller.destroy();
  });

  test("samples graph values once per one-second FPS window", () => {
    const { controller } = createController();

    const start = 1000;
    for (let i = 0; i < 60; i++) {
      controller.onFrame(true, start + i * (1000 / 60));
    }

    expect(controller.getSnapshot().sampleCount).toBe(0);

    controller.onFrame(true, start + 1000);
    const firstWindow = controller.getSnapshot();
    expect(firstWindow.sampleCount).toBe(1);
    expect(firstWindow.rafFps).toBeCloseTo(60, 1);
    expect(controller.getSnapshot().scaleMax).toBe(60);
    controller.destroy();
  });

  test("adds rendered idle samples at one-second cadence", () => {
    const { controller, element } = createController();

    element.click();
    controller.onFrame(true, 1000);
    controller.onRender(FRAME_STATS, true, 1000);
    controller.onFrame(true, 1999);
    expect(controller.getSnapshot().sampleCount).toBe(0);

    controller.onFrame(true, 2000);
    expect(controller.getSnapshot().sampleCount).toBe(1);
    expect(controller.getSnapshot().renderedFps).toBe(0);

    controller.onFrame(true, 2016);
    expect(controller.getSnapshot().sampleCount).toBe(1);

    controller.onFrame(true, 3000);
    expect(controller.getSnapshot().sampleCount).toBe(2);
    controller.destroy();
  });

  test("rescales on large windowed FPS changes and decays after they age out", () => {
    const { controller } = createController();
    let timestamp = 1000;

    controller.onFrame(true, timestamp);
    for (let i = 1; i <= 60; i++) {
      timestamp = 1000 + i * (1000 / 60);
      controller.onFrame(true, timestamp);
    }

    for (let i = 1; i <= 120; i++) {
      timestamp = 2000 + i * (1000 / 120);
      controller.onFrame(true, timestamp);
    }
    const spikeScale = controller.getSnapshot().scaleMax;
    expect(spikeScale).toBeGreaterThanOrEqual(140);

    for (let i = 0; i < 300; i++) {
      timestamp += 1000;
      controller.onFrame(true, timestamp);
    }

    const decayedScale = controller.getSnapshot().scaleMax;
    expect(decayedScale).toBeLessThan(spikeScale);
    expect(decayedScale).toBeGreaterThanOrEqual(60);
    controller.destroy();
  });
});
