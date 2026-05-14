import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { canvasStore } from "#engine";
import { undo } from "#lib/undo.ts";
import { createEntityInput } from "../helpers/test-entity.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { clearUndoHistory, performUndo } from "../helpers/undo-helpers.ts";

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
