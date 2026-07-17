import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { canvasStore } from "#engine";
import { getImageAssetReferenceCount } from "#lib/media-assets.ts";
import { undo } from "#lib/undo.ts";
import { createEntityInput, createTestEntity } from "../helpers/test-entity.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { clearUndoHistory, performRedo, performUndo } from "../helpers/undo-helpers.ts";

let cleanup: () => void;

const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

beforeEach(() => {
  cleanup = setupCanvasTest();
  clearUndoHistory();
  vi.restoreAllMocks();
});

afterEach(() => {
  clearUndoHistory();
  cleanup();
  vi.restoreAllMocks();
});

describe("CanvasCommands.addEntity", () => {
  test("does not reuse a hydrated entity ID or z-index", () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    const hydrated = createTestEntity({ id: "entity-1", name: "Image 1", zIndex: 27 });
    canvasStore.addEntity(hydrated);

    let id = "";
    act(() => {
      id = canvas.addEntity(createEntityInput());
    });

    expect(id).not.toBe(hydrated.id);
    expect(canvasStore.getState().entities.get(hydrated.id)).toBe(hydrated);
    expect(canvasStore.getState().entities.get(id)?.zIndex).toBe(28);
    expect(canvasStore.getState().entities.get(id)?.name).toBe("Image 2");
  });

  test("adds user entities to undo history", () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    let id = "";
    act(() => {
      id = canvas.addEntity(createEntityInput());
    });

    expect(undo.canUndo()).toBe(true);

    performUndo();

    expect(canvasStore.getState().entities.has(id)).toBe(false);
  });

  test("can add onboarding entities without undo history", () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    let id = "";
    act(() => {
      id = canvas.addEntity(createEntityInput(), "favicon.webp", {
        skipUndo: true,
        source: "onboarding",
      });
    });

    expect(canvasStore.getState().entities.has(id)).toBe(true);
    expect(undo.canUndo()).toBe(false);

    act(() => {
      undo.undo();
    });

    expect(canvasStore.getState().entities.has(id)).toBe(true);
  });
});

describe("CanvasCommands.duplicateEntities", () => {
  test("shares nested shader state while retaining mutable time and image ownership", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    const source = createTestEntity();
    source.originalPalette = {
      id: "original",
      name: "Original",
      shortName: "Original",
      colors: [[0, 0, 0, 1]],
    };
    canvasStore.addEntity(source);
    canvasStore.replaceSelection([source.id]);

    let duplicateIds: string[] = [];
    await act(async () => {
      duplicateIds = await canvas.duplicateEntities();
    });

    const duplicate = canvasStore.getState().entities.get(duplicateIds[0]!);
    expect(duplicate?.shaderParams).not.toBe(source.shaderParams);
    expect(duplicate?.shaderParams.adjustments).toBe(source.shaderParams.adjustments);
    duplicate!.shaderParams.time = 42;
    expect(source.shaderParams.time).not.toBe(42);
    expect(duplicate?.originalPalette).toBe(source.originalPalette);
    if (source.mediaSource.type !== "image") throw new Error("Expected image source");
    expect(duplicate?.mediaSource).toEqual({ type: "image", asset: source.mediaSource.asset });
    expect(getImageAssetReferenceCount(source.mediaSource.asset)).toBe(2);

    act(() => canvas.clearWorkspace());
  });

  test("undoes and redoes a duplicate set with one store mutation", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    const first = createTestEntity({ id: "duplicate-batch-first", name: "Repeated" });
    const second = createTestEntity({ id: "duplicate-batch-second", name: "Repeated" });
    canvasStore.addEntities([first, second]);
    canvasStore.replaceSelection([first.id, second.id]);

    let duplicateIds: string[] = [];
    await act(async () => {
      duplicateIds = await canvas.duplicateEntities();
    });
    expect(duplicateIds).toHaveLength(2);
    expect(Array.from(canvasStore.getState().entities.values(), (entity) => entity.name)).toEqual([
      "Repeated",
      "Repeated",
      "Repeated (1)",
      "Repeated (2)",
    ]);

    let notifications = 0;
    const unsubscribe = canvasStore.subscribe(() => notifications++);
    performUndo();
    expect(canvasStore.getState().entities.size).toBe(2);
    expect(notifications).toBe(1);

    performRedo();
    expect(canvasStore.getState().entities.size).toBe(4);
    expect(notifications).toBe(2);
    unsubscribe();

    act(() => canvas.clearWorkspace());
  });
});
