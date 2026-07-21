import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canvasStore, EntityDragController } from "#engine";
import { AnimationScheduler } from "#lib/animation-scheduler.ts";
import { DragTargetType } from "#types/canvas.ts";
import { createTestEntity } from "../helpers/test-entity.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
});

afterEach(() => {
  cleanup();
});

describe("EntityDragController", () => {
  test("keeps a selected singleton drag transient until release", () => {
    const entity = createTestEntity({ id: "singleton-drag" });
    canvasStore.addEntity(entity);
    canvasStore.replaceSelection([entity.id]);
    const controller = new EntityDragController(new AnimationScheduler());
    const initialGeometryVersion = canvasStore.getState().geometryVersion;
    controller.setTarget({ type: DragTargetType.entity, entityId: entity.id });

    controller.moveTarget({ x: 12, y: -4 });
    controller.moveTarget({ x: 8, y: 10 });

    expect(entity.position).toEqual({ x: 0, y: 0 });
    expect(canvasStore.getTransientEntityDragOffset()).toEqual({ x: 20, y: 6 });
    expect(canvasStore.getEntityPositionWithTransientDrag(entity.id)).toEqual({ x: 20, y: 6 });
    expect(canvasStore.getState().geometryVersion).toBe(initialGeometryVersion);

    controller.clear();

    expect(entity.position).toEqual({ x: 20, y: 6 });
    expect(canvasStore.getTransientEntityDragOffset()).toEqual({ x: 0, y: 0 });
    expect(canvasStore.getEntityPositionWithTransientDrag(entity.id)).toEqual({ x: 20, y: 6 });
    expect(canvasStore.getState().geometryVersion).toBe(initialGeometryVersion + 1);
  });
});
