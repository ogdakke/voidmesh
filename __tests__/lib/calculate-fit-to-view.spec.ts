import { calculateFitToView, screenToWorld } from "#lib/canvas-math.ts";
import { describe, expect, test } from "vitest";

const entity = { entityPosition: { x: 0, y: 0 }, entitySize: { width: 100, height: 100 } };

/** World point rendered at a given screen (CSS px) location for a fitted viewport. */
function worldAt(viewport: ReturnType<typeof calculateFitToView>, x: number, y: number) {
  return screenToWorld({ x, y }, viewport, new DOMRect(0, 0, 0, 0), 1);
}

describe("calculateFitToView insets", () => {
  test("centers in the full container without insets", () => {
    const viewport = calculateFitToView({ ...entity, containerWidth: 800, containerHeight: 400 });
    expect(worldAt(viewport, 400, 200)).toEqual({ x: 50, y: 50 });
  });

  test("centers left of a right inset and fits its narrower width", () => {
    const viewport = calculateFitToView({
      ...entity,
      containerWidth: 800,
      containerHeight: 400,
      padding: 0,
      insets: { bottom: 0, right: 600 },
    });
    expect(worldAt(viewport, 100, 200)).toEqual({ x: 50, y: 50 });
    // 200px visible width / 100px entity
    expect(viewport.zoom).toBe(2);
  });

  test("centers above a bottom inset", () => {
    const viewport = calculateFitToView({
      ...entity,
      containerWidth: 400,
      containerHeight: 800,
      insets: { bottom: 200, right: 0 },
    });
    expect(worldAt(viewport, 200, 300)).toEqual({ x: 50, y: 50 });
  });
});
