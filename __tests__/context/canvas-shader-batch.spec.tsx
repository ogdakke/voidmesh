import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canvasStore } from "#engine";
import { undo } from "#lib/undo.ts";
import { paletteStore } from "#lib/palette-store.ts";
import { ShaderType, type ColorPalette } from "#types/canvas.ts";
import { createTestEntity } from "../helpers/test-entity.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { clearUndoHistory, performRedo, performUndo } from "../helpers/undo-helpers.ts";

const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

let cleanup: () => void;
let originalPalettes: ColorPalette[];

beforeEach(() => {
  cleanup = setupCanvasTest();
  clearUndoHistory();
  originalPalettes = paletteStore.getPalettes();
});

afterEach(() => {
  clearUndoHistory();
  paletteStore.setPalettes(originalPalettes);
  cleanup();
});

describe("CanvasCommands.changePalette", () => {
  test("applies and restores a custom palette with one store mutation per direction", () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    const customPalette: ColorPalette = {
      id: "cstm_bulk-palette",
      name: "Bulk palette",
      shortName: "Bulk",
      colors: [
        [0, 0, 0, 1],
        [1, 1, 1, 1],
      ],
    };
    paletteStore.setPalettes([...originalPalettes, customPalette]);
    const entities = Array.from({ length: 1_000 }, (_, index) =>
      createTestEntity({ id: `bulk-palette-${index}` }),
    );
    const previousPalettes = new Map(
      entities.map((entity) => [entity.id, entity.shaderParams.palette] as const),
    );
    canvasStore.addEntities(entities);
    canvasStore.replaceSelection(entities.map(({ id }) => id));
    let notifications = 0;
    const unsubscribe = canvasStore.subscribe(() => notifications++);

    act(() => canvas.changePalette(customPalette));

    expect(notifications).toBe(1);
    expect(
      [...canvasStore.getState().entities.values()].every(
        ({ shaderParams }) => shaderParams.palette === customPalette,
      ),
    ).toBe(true);

    performUndo();

    expect(notifications).toBe(2);
    expect(
      [...canvasStore.getState().entities.values()].every(
        ({ id, shaderParams }) => shaderParams.palette === previousPalettes.get(id),
      ),
    ).toBe(true);
    unsubscribe();
  });

  test("deletes an owned palette from every entity and restores it through undo", () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    const ownedPalette: ColorPalette = {
      id: "cstm_delete-everywhere",
      name: "Owned palette",
      shortName: "Owned",
      colors: [
        [0, 0, 0, 1],
        [1, 1, 1, 1],
      ],
    };
    paletteStore.addPalette(ownedPalette);
    const first = createTestEntity({ id: "delete-palette-first" });
    const second = createTestEntity({ id: "delete-palette-second" });
    first.shaderParams.palette = ownedPalette;
    second.shaderParams.palette = ownedPalette;
    canvasStore.addEntities([first, second]);
    canvasStore.replaceSelection([first.id]);

    act(() => canvas.deletePalette(ownedPalette.id!));

    expect(paletteStore.getPalettes()).not.toContainEqual(ownedPalette);
    expect(
      [...canvasStore.getState().entities.values()].every(
        (entity) => entity.shaderParams.palette?.id !== ownedPalette.id,
      ),
    ).toBe(true);

    performUndo();

    expect(paletteStore.isPersonalPalette(ownedPalette.id!)).toBe(true);
    expect(
      [...canvasStore.getState().entities.values()].every(
        (entity) => entity.shaderParams.palette?.id === ownedPalette.id,
      ),
    ).toBe(true);

    performRedo();

    expect(paletteStore.getPalettes()).not.toContainEqual(ownedPalette);
    expect(
      [...canvasStore.getState().entities.values()].every(
        (entity) => entity.shaderParams.palette?.id !== ownedPalette.id,
      ),
    ).toBe(true);
  });
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
