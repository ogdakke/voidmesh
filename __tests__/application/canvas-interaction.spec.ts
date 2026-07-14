import { createCanvasInteractionService } from "#application/canvas/canvas-interaction.ts";
import { CanvasStore, type GameLoop, type ViewportAnimationController } from "#engine";
import { calculateFitToView } from "#lib/canvas-math.ts";
import { createTestEntity } from "../helpers/test-entity.ts";
import { describe, expect, it, vi } from "vitest";

function createHarness() {
  const store = new CanvasStore();
  const gameLoop = {
    stopMomentum: vi.fn<GameLoop["stopMomentum"]>(),
    setSpaceHeld: vi.fn<GameLoop["setSpaceHeld"]>(),
    spacePanMode: "idle",
  } as unknown as GameLoop;
  const animateTo = vi.fn<ViewportAnimationController["animateTo"]>();
  const viewportAnimation = { animateTo } as unknown as ViewportAnimationController;
  const service = createCanvasInteractionService({ store, gameLoop, viewportAnimation });
  return { store, gameLoop, animateTo, service };
}

describe("CanvasInteractionService", () => {
  it("initializes the viewport from surface metrics", () => {
    const { store, service } = createHarness();
    service.initializeViewport({ width: 800, height: 600, dpr: 2 });
    expect(store.getViewport()).toEqual({ offset: { x: -800, y: -600 }, zoom: 1 });
  });

  it("fits the complete selection and stops momentum", () => {
    const { store, gameLoop, animateTo, service } = createHarness();
    const first = createTestEntity({
      id: "first",
      position: { x: 10, y: 20 },
      size: { width: 100, height: 50 },
    });
    const second = createTestEntity({
      id: "second",
      position: { x: 200, y: 100 },
      size: { width: 40, height: 80 },
    });
    store.addEntity(first);
    store.addEntity(second);
    store.replaceSelection([first.id, second.id]);

    const metrics = { width: 1000, height: 800, dpr: 1 };
    expect(service.fitSelection(metrics, { padding: 0.1, bottomInset: 30 })).toBe(true);
    expect(gameLoop.stopMomentum).toHaveBeenCalledOnce();
    expect(animateTo).toHaveBeenCalledWith(
      calculateFitToView({
        entityPosition: { x: 10, y: 20 },
        entitySize: { width: 230, height: 160 },
        containerWidth: metrics.width,
        containerHeight: metrics.height,
        dpr: metrics.dpr,
        padding: 0.1,
        minZoom: undefined,
        maxZoom: undefined,
        bottomInset: 30,
      }),
      expect.objectContaining({ duration: expect.any(Number), easing: expect.any(Function) }),
    );
  });

  it("does not animate without a selection", () => {
    const { animateTo, service } = createHarness();
    expect(
      service.fitSelection({ width: 1000, height: 800, dpr: 1 }, { padding: 0.1, bottomInset: 0 }),
    ).toBe(false);
    expect(animateTo).not.toHaveBeenCalled();
  });
});
