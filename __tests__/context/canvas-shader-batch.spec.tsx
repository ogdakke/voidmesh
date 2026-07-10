import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canvasStore } from "#engine";
import { undo } from "#lib/undo.ts";
import { ShaderType } from "#types/canvas.ts";
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

describe("CanvasCommands.changeShaderType", () => {
  test("changes and restores a large selection with one store mutation per direction", () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    const entities = Array.from({ length: 1_000 }, (_, index) =>
      createTestEntity({
        id: `bulk-shader-${index}`,
        shaderType: ShaderType.dithering,
      }),
    );
    canvasStore.addEntities(entities);
    canvasStore.replaceSelection(entities.map(({ id }) => id));
    let notifications = 0;
    const unsubscribe = canvasStore.subscribe(() => notifications++);

    act(() => canvas.changeShaderType(ShaderType.glitch));

    expect(notifications).toBe(1);
    expect(
      [...canvasStore.getState().entities.values()].every(
        ({ shaderType }) => shaderType === ShaderType.glitch,
      ),
    ).toBe(true);
    expect(undo.canUndo()).toBe(true);

    performUndo();

    expect(notifications).toBe(2);
    expect(
      [...canvasStore.getState().entities.values()].every(
        ({ shaderType }) => shaderType === ShaderType.dithering,
      ),
    ).toBe(true);
    unsubscribe();
  });
});
