import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canvasStore } from "#engine";
import { undo } from "#lib/undo.ts";
import { createTestEntity } from "../helpers/test-entity.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { clearUndoHistory, performUndo } from "../helpers/undo-helpers.ts";

const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
  clearUndoHistory();
});

afterEach(() => {
  clearUndoHistory();
  cleanup();
});

describe("CanvasCommands.deleteSelection", () => {
  test("deletes and restores a large selection as one store mutation and undo command", () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    const entities = Array.from({ length: 1_000 }, (_, index) =>
      createTestEntity({ id: `bulk-delete-${index}`, zIndex: index }),
    );
    canvasStore.addEntities(entities);
    canvasStore.replaceSelection(entities.map(({ id }) => id));
    canvasStore.setFancyDelete(false);
    let notifications = 0;
    const unsubscribe = canvasStore.subscribe(() => notifications++);

    act(() => canvas.deleteSelection());

    expect(notifications).toBe(1);
    expect(canvasStore.getState().entities.size).toBe(0);
    expect(undo.canUndo()).toBe(true);

    performUndo();

    expect(canvasStore.getState().entities.size).toBe(1_000);
    expect(canvasStore.getState().entityIds).toEqual(entities.map(({ id }) => id));
    unsubscribe();
  });
});
