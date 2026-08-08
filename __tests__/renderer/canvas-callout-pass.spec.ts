import { describe, expect, test } from "vitest";
import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import { resolveEntityVisualBounds } from "#renderer/canvas-callout-pass.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("resolveEntityVisualBounds", () => {
  test("tracks the action-layer spring offset in world space", () => {
    const entity = createTestEntity({
      id: "starter",
      position: { x: 100, y: 200 },
      size: { width: 80, height: 40 },
    });

    expect(
      resolveEntityVisualBounds(
        entity,
        createActionLayer({ x: 24, y: -12 }),
        createDragVisual(),
        2,
        4,
      ),
    ).toEqual({ x: 112, y: 194, width: 80, height: 40 });
  });

  test("tracks centered drag scaling and the trailing drag offset", () => {
    const entity = createTestEntity({
      id: "starter",
      position: { x: 100, y: 200 },
      size: { width: 80, height: 40 },
    });

    expect(
      resolveEntityVisualBounds(
        entity,
        createActionLayer({ x: 20, y: -10 }),
        createDragVisual({ active: true, scale: 0.75, offset: { x: 30, y: 15 } }),
        2,
        2,
      ),
    ).toEqual({ x: 160, y: 210, width: 60, height: 30 });
  });

  test("ignores transient state that does not target the anchored entity", () => {
    const entity = createTestEntity({
      id: "other",
      position: { x: 100, y: 200 },
      size: { width: 80, height: 40 },
    });

    expect(
      resolveEntityVisualBounds(
        entity,
        createActionLayer({ x: 20, y: -10 }),
        createDragVisual({ active: true, scale: 0.75, offset: { x: 30, y: 15 } }),
        2,
        2,
      ),
    ).toEqual({ x: 100, y: 200, width: 80, height: 40 });
  });
});

function createActionLayer(entityOffset: { x: number; y: number }): ActionLayerRenderState {
  return {
    active: true,
    entityIds: new Set(["starter"]),
    entityOffset,
    blurIntensity: 1,
  };
}

function createDragVisual(overrides: Partial<DragVisualRenderState> = {}): DragVisualRenderState {
  return {
    active: false,
    isDragPhase: false,
    entityIds: new Set(["starter"]),
    scale: 1,
    offset: { x: 0, y: 0 },
    appliesToSelection: true,
    ...overrides,
  };
}
