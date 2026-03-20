import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { AnimationScheduler } from "#lib/animation-scheduler.ts";
import { MomentumController, type MomentumDeps } from "../../engine/momentum-controller.ts";
import { config } from "#config";

describe("MomentumController", () => {
  let scheduler: AnimationScheduler;
  let controller: MomentumController;
  let deps: MomentumDeps;
  let viewport: { offset: { x: number; y: number }; zoom: number };
  let perfSpy: ReturnType<typeof vi.spyOn>;
  let now: number;

  function advanceBy(ms: number): void {
    now += ms;
    perfSpy.mockReturnValue(now);
    scheduler.tick(now);
  }

  beforeEach(() => {
    now = 1000;
    perfSpy = vi.spyOn(performance, "now").mockReturnValue(now);
    scheduler = new AnimationScheduler();
    viewport = { offset: { x: 0, y: 0 }, zoom: 1 };

    deps = {
      panBy: vi.fn((delta) => {
        viewport.offset.x += delta.x;
        viewport.offset.y += delta.y;
      }),
      getViewport: vi.fn(() => ({ ...viewport, offset: { ...viewport.offset } })),
      setViewport: vi.fn((v) => {
        viewport = { offset: { ...v.offset }, zoom: v.zoom };
      }),
      getContainerRect: vi.fn(() => new DOMRect(0, 0, 800, 600)),
      getDpr: vi.fn(() => 1),
    };

    controller = new MomentumController(scheduler, deps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Pan momentum ────────────────────────────────────────────────────────

  describe("triggerScroll", () => {
    test("calls panBy over time with sufficient velocity", () => {
      const threshold = config.touch.velocityThreshold;
      controller.triggerScroll({ x: threshold + 1, y: 0 });

      expect(scheduler.hasActive).toBe(true);

      // Advance a few frames
      advanceBy(16);
      advanceBy(16);
      advanceBy(16);

      expect(deps.panBy).toHaveBeenCalled();
    });

    test("does nothing when velocity is below threshold", () => {
      const threshold = config.touch.velocityThreshold;
      controller.triggerScroll({ x: threshold * 0.5, y: threshold * 0.5 });

      expect(scheduler.hasActive).toBe(false);
      expect(deps.panBy).not.toHaveBeenCalled();
    });

    test("stopScroll cancels active momentum", () => {
      const threshold = config.touch.velocityThreshold;
      controller.triggerScroll({ x: threshold + 1, y: 0 });
      expect(scheduler.hasActive).toBe(true);

      controller.stopScroll();
      expect(scheduler.hasActive).toBe(false);

      // Advance more — panBy should not be called after stop
      (deps.panBy as ReturnType<typeof vi.fn>).mockClear();
      advanceBy(16);
      expect(deps.panBy).not.toHaveBeenCalled();
    });

    test("momentum eventually settles on its own", () => {
      const threshold = config.touch.velocityThreshold;
      controller.triggerScroll({ x: threshold + 0.5, y: 0 });

      // Advance many frames until settled
      for (let i = 0; i < 500; i++) {
        advanceBy(16);
        if (!scheduler.hasActive) break;
      }

      expect(scheduler.hasActive).toBe(false);
    });
  });

  // ── Zoom momentum ──────────────────────────────────────────────────────

  describe("triggerZoom", () => {
    test("zoom fling calls setViewport when velocity exceeds threshold", () => {
      const threshold = config.touch.zoomMomentum.velocityThreshold;
      controller.triggerZoom(threshold + 1, { x: 400, y: 300 });

      expect(scheduler.hasActive).toBe(true);

      advanceBy(16);
      expect(deps.setViewport).toHaveBeenCalled();
    });

    test("does nothing when velocity is below threshold and zoom is in bounds", () => {
      const threshold = config.touch.zoomMomentum.velocityThreshold;
      controller.triggerZoom(threshold * 0.5, { x: 400, y: 300 });

      expect(scheduler.hasActive).toBe(false);
    });

    test("springs back when zoom is out of bounds", () => {
      // Set zoom beyond max
      viewport.zoom = config.canvas.maxZoom * 1.5;

      // Even with zero velocity, should spring back
      controller.triggerZoom(0, { x: 400, y: 300 });

      expect(scheduler.hasActive).toBe(true);

      // Advance until settled
      for (let i = 0; i < 500; i++) {
        advanceBy(16);
        if (!scheduler.hasActive) break;
      }

      expect(scheduler.hasActive).toBe(false);
      // Zoom should have converged toward the boundary
      expect(viewport.zoom).toBeCloseTo(config.canvas.maxZoom, 0);
    });

    test("stopZoom cancels active zoom momentum", () => {
      const threshold = config.touch.zoomMomentum.velocityThreshold;
      controller.triggerZoom(threshold + 1, { x: 400, y: 300 });
      expect(scheduler.hasActive).toBe(true);

      controller.stopZoom();
      expect(scheduler.hasActive).toBe(false);
    });
  });

  // ── Combined ────────────────────────────────────────────────────────────

  describe("stopAll", () => {
    test("cancels both scroll and zoom", () => {
      const scrollThreshold = config.touch.velocityThreshold;
      const zoomThreshold = config.touch.zoomMomentum.velocityThreshold;

      controller.triggerScroll({ x: scrollThreshold + 1, y: 0 });
      controller.triggerZoom(zoomThreshold + 1, { x: 400, y: 300 });
      expect(scheduler.hasActive).toBe(true);

      controller.stopAll();
      expect(scheduler.hasActive).toBe(false);
    });
  });
});
