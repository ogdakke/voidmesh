/**
 * Tests for copy/paste effects functionality
 * Tests the clipboard-based effects transfer between entities
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor, act } from "@testing-library/react";
import { canvasStore } from "#engine";
import { createEntityInput } from "../helpers/test-entity.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { ShaderType, type ColorPalette, type ShaderParams } from "#types/canvas.ts";
import { clearUndoHistory, performUndo } from "../helpers/undo-helpers.ts";
import {
  assertShaderType,
  assertEntityParam,
  assertAllSelectedHaveShaderType,
} from "../helpers/assertions.ts";
import { config } from "#config";
import { paletteStore } from "#lib/palette-store.ts";
import { isUserPalette } from "#components/palette-preset/palette-presets.ts";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
  clearUndoHistory();
  paletteStore.setPalettes([]);
  vi.restoreAllMocks();
});

afterEach(() => {
  clearUndoHistory();
  paletteStore.setPalettes([]);
  cleanup();
  vi.restoreAllMocks();
});

const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

const customPalette: ColorPalette = {
  id: "custom",
  name: "Test Custom",
  shortName: "TC",
  colors: [
    [0, 0, 0, 1],
    [1, 0, 0, 1],
    [0, 1, 0, 1],
    [0, 0, 1, 1],
  ],
};

/** Add entity and set its params directly on the store (bypasses URL state override) */
function addEntityWithParams(
  canvas: ReturnType<typeof renderWithCanvas>["canvas"],
  shaderType: ShaderType,
  shaderParams: Partial<ShaderParams>,
): string {
  const id = canvas.addEntity(createEntityInput());
  const entity = canvasStore.getState().entities.get(id);
  if (entity) {
    canvasStore.updateEntity(id, {
      shaderType,
      shaderParams: { ...entity.shaderParams, ...shaderParams },
    });
  }
  return id;
}

describe("copyEntityParams", () => {
  test("writes JSON with __voidmesh discriminant to clipboard", async () => {
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    act(() => {
      const id = addEntityWithParams(canvas, ShaderType.dithering, {
        size: 42,
        preserveColors: true,
      });
      canvas.selectEntity(id);
    });

    act(() => {
      canvas.copySelectionEffects();
    });

    expect(writeTextSpy).toHaveBeenCalledOnce();
    const written = writeTextSpy.mock.calls[0]![0];
    const parsed = JSON.parse(written);

    expect(parsed.__voidmesh).toBe(true);
    expect(parsed.version).toBe(1);
    expect(parsed.shaderType).toBe(ShaderType.dithering);
    expect(parsed.shaderParams.size).toBe(42);
    expect(parsed.shaderParams.preserveColors).toBe(true);
  });

  test("includes full palette with color data", async () => {
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    act(() => {
      const id = addEntityWithParams(canvas, ShaderType.halftone, {
        palette: customPalette,
      });
      canvas.selectEntity(id);
    });

    act(() => {
      canvas.copySelectionEffects();
    });

    const parsed = JSON.parse(writeTextSpy.mock.calls[0]![0]);
    expect(parsed.shaderParams.palette).toEqual(customPalette);
    expect(parsed.shaderParams.palette.colors).toHaveLength(4);
    expect(parsed.shaderParams.palette.colors[1]).toEqual([1, 0, 0, 1]);
  });

  test("includes originalPalette when present", async () => {
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    act(() => {
      const id = canvas.addEntity(createEntityInput());
      canvasStore.updateEntity(id, {
        originalPalette: {
          id: "original",
          name: "Original",
          shortName: "Original",
          colors: Array.from(
            { length: 6 },
            (_, i) => [i / 5, 0, 0, 1] as [number, number, number, number],
          ),
        },
      });
      canvas.selectEntity(id);
    });

    act(() => {
      canvas.copySelectionEffects();
    });

    const parsed = JSON.parse(writeTextSpy.mock.calls[0]![0]);
    expect(parsed.originalPalette).toBeDefined();
    expect(parsed.originalPalette.colors).toHaveLength(6);
    expect(parsed.originalPalette.id).toBe("original");
  });

  test("copies first entity params when multiple selected", async () => {
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    act(() => {
      const id1 = addEntityWithParams(canvas, ShaderType.dithering, { size: 10 });
      const id2 = addEntityWithParams(canvas, ShaderType.ascii, { size: 99 });
      canvasStore.replaceSelection([id1, id2]);
    });

    act(() => {
      canvas.copySelectionEffects();
    });

    expect(writeTextSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(writeTextSpy.mock.calls[0]![0]);
    // First entity's params should be copied
    expect(parsed.shaderType).toBe(ShaderType.dithering);
  });

  test("does nothing when no selection", async () => {
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    act(() => {
      canvas.copySelectionEffects();
    });

    expect(writeTextSpy).not.toHaveBeenCalled();
  });

  test("includes all shader sub-params", async () => {
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    act(() => {
      const id = canvas.addEntity(createEntityInput());
      const entity = canvasStore.getState().entities.get(id)!;
      canvasStore.updateEntity(id, {
        shaderType: ShaderType.glass,
        shaderParams: {
          ...entity.shaderParams,
          glass: {
            kind: "frostedVoronoi",
            angle: 45,
            caustic: 0.8,
            frostiness: 0.5,
            highlight: 0.3,
            dispersion: 0.2,
            flow: 0.1,
          },
          postProcess: {
            enabled: true,
            grain: { enabled: true, size: 2, intensity: 0.5 },
            bloom: {
              enabled: false,
              threshold: 0.8,
              intensity: 1,
              filterRadius: 4,
              softness: 0.5,
            },
            chromaticAberration: { enabled: true, offset: 3 },
          },
          adjustments: { brightness: 1.2, contrast: 0.9, saturation: 1.1, blur: 0 },
        },
      });
      canvas.selectEntity(id);
    });

    act(() => {
      canvas.copySelectionEffects();
    });

    const parsed = JSON.parse(writeTextSpy.mock.calls[0]![0]);
    expect(parsed.shaderParams.glass.kind).toBe("frostedVoronoi");
    expect(parsed.shaderParams.glass.angle).toBe(45);
    expect(parsed.shaderParams.postProcess.enabled).toBe(true);
    expect(parsed.shaderParams.postProcess.grain.intensity).toBe(0.5);
    expect(parsed.shaderParams.postProcess.chromaticAberration.offset).toBe(3);
    expect(parsed.shaderParams.adjustments.brightness).toBe(1.2);
  });
});

describe("pasteEntityParams", () => {
  const makeClipboardData = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      __voidmesh: true,
      version: 1,
      shaderType: ShaderType.dithering,
      shaderParams: {
        ...structuredClone(config.defaults.shaderParams),
        size: 77,
        preserveColors: true,
        palette: customPalette,
      },
      ...overrides,
    });

  test("applies effects from voidmesh JSON to single entity", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(makeClipboardData());

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId = "";

    act(() => {
      entityId = addEntityWithParams(canvas, ShaderType.halftone, { size: 10 });
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderType === ShaderType.dithering;
    });

    assertShaderType(entityId, ShaderType.dithering);
    assertEntityParam(entityId, "size", 77);
    assertEntityParam(entityId, "preserveColors", true);

    const entity = canvasStore.getState().entities.get(entityId)!;
    expect(entity.shaderParams.palette).toEqual(customPalette);
  });

  test("applies effects to all entities in multi-select", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(makeClipboardData());

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityIds: string[] = [];

    act(() => {
      entityIds = [
        addEntityWithParams(canvas, ShaderType.halftone, {}),
        addEntityWithParams(canvas, ShaderType.blobs, {}),
        addEntityWithParams(canvas, ShaderType.ascii, {}),
      ];
      canvasStore.replaceSelection(entityIds);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() =>
      entityIds.every(
        (id) => canvasStore.getState().entities.get(id)?.shaderType === ShaderType.dithering,
      ),
    );

    assertAllSelectedHaveShaderType(ShaderType.dithering);
    for (const id of entityIds) {
      assertEntityParam(id, "size", 77);
    }
  });

  test("supports undo for single entity paste", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(makeClipboardData());

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId = "";

    act(() => {
      entityId = addEntityWithParams(canvas, ShaderType.halftone, { size: 10 });
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderType === ShaderType.dithering;
    });

    performUndo();

    assertShaderType(entityId, ShaderType.halftone);
    assertEntityParam(entityId, "size", 10);
  });

  test("supports undo for multi-select paste (single undo restores all)", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(makeClipboardData());

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityIds: string[] = [];

    act(() => {
      entityIds = [
        addEntityWithParams(canvas, ShaderType.halftone, { size: 10 }),
        addEntityWithParams(canvas, ShaderType.blobs, { size: 20 }),
      ];
      canvasStore.replaceSelection(entityIds);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() =>
      entityIds.every(
        (id) => canvasStore.getState().entities.get(id)?.shaderType === ShaderType.dithering,
      ),
    );

    // Single undo should restore all
    performUndo();

    const entity1 = canvasStore.getState().entities.get(entityIds[0]!);
    const entity2 = canvasStore.getState().entities.get(entityIds[1]!);

    expect(entity1?.shaderType).toBe(ShaderType.halftone);
    expect(entity1?.shaderParams.size).toBe(10);
    expect(entity2?.shaderType).toBe(ShaderType.blobs);
    expect(entity2?.shaderParams.size).toBe(20);
  });

  test("does not overwrite target originalPalette with source data", async () => {
    const sourceOriginalPalette = {
      id: "original",
      name: "Source Original",
      shortName: "Original",
      colors: Array.from(
        { length: 6 },
        (_, i) => [i / 5, 0, 0, 1] as [number, number, number, number],
      ),
    };

    const targetOriginalPalette = {
      id: "original",
      name: "Target Original",
      shortName: "Original",
      colors: Array.from(
        { length: 6 },
        (_, i) => [0, i / 5, 0, 1] as [number, number, number, number],
      ),
    };

    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(
      makeClipboardData({ originalPalette: sourceOriginalPalette }),
    );

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId = "";

    act(() => {
      entityId = canvas.addEntity(createEntityInput());
      canvasStore.updateEntity(entityId, { originalPalette: targetOriginalPalette });
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderType === ShaderType.dithering;
    });

    // Target's own originalPalette must be preserved
    const entity = canvasStore.getState().entities.get(entityId)!;
    expect(entity.originalPalette?.name).toBe("Target Original");
    expect(entity.originalPalette?.colors[0]).toEqual([0, 0, 0, 1]);
  });

  test("falls back to URL-based paste for valid URLs", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(
      "https://example.com/?shader=ascii&size=33",
    );

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId = "";

    act(() => {
      entityId = addEntityWithParams(canvas, ShaderType.halftone, { size: 10 });
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderType === ShaderType.ascii;
    });

    assertShaderType(entityId, ShaderType.ascii);
    assertEntityParam(entityId, "size", 33);
  });

  test("ignores invalid JSON that is not voidmesh data", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue('{"foo": "bar"}');

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId = "";

    act(() => {
      entityId = addEntityWithParams(canvas, ShaderType.halftone, { size: 10 });
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    // Not voidmesh JSON and not a valid URL — entity should be unchanged
    assertShaderType(entityId, ShaderType.halftone);
    assertEntityParam(entityId, "size", 10);
  });

  test("ignores plain text that is not JSON or URL", async () => {
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("hello world");

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId = "";

    act(() => {
      entityId = addEntityWithParams(canvas, ShaderType.halftone, { size: 10 });
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    assertShaderType(entityId, ShaderType.halftone);
    assertEntityParam(entityId, "size", 10);
  });
});

describe("copy-paste round trip", () => {
  test("copy then paste preserves all params exactly", async () => {
    let clipboardContent = "";
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      clipboardContent = text;
    });
    vi.spyOn(navigator.clipboard, "readText").mockImplementation(async () => clipboardContent);

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    let sourceId = "";
    let targetId = "";

    act(() => {
      sourceId = canvas.addEntity(createEntityInput());
      const sourceEntity = canvasStore.getState().entities.get(sourceId)!;
      canvasStore.updateEntity(sourceId, {
        shaderType: ShaderType.glass,
        shaderParams: {
          ...sourceEntity.shaderParams,
          size: 55,
          intensity: 3.5,
          scale: 2.0,
          preserveColors: true,
          reversePalette: true,
          palette: customPalette,
          glass: {
            kind: "flowing",
            angle: 90,
            caustic: 0.7,
            frostiness: 0.3,
            highlight: 0.5,
            dispersion: 0.4,
            flow: 0.6,
          },
          postProcess: {
            enabled: true,
            grain: { enabled: true, size: 3, intensity: 0.8 },
            bloom: {
              enabled: true,
              threshold: 0.5,
              intensity: 2,
              filterRadius: 6,
              softness: 0.7,
            },
            chromaticAberration: { enabled: true, offset: 5 },
          },
          adjustments: { brightness: 1.3, contrast: 0.8, saturation: 1.5, blur: 2 },
        },
      });

      targetId = addEntityWithParams(canvas, ShaderType.halftone, { size: 10 });
    });

    // Copy from source
    act(() => {
      canvas.selectEntity(sourceId);
    });
    act(() => {
      canvas.copySelectionEffects();
    });

    // Paste to target
    act(() => {
      canvas.selectEntity(targetId);
    });
    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(targetId);
      return entity?.shaderType === ShaderType.glass;
    });

    const target = canvasStore.getState().entities.get(targetId)!;

    expect(target.shaderType).toBe(ShaderType.glass);
    expect(target.shaderParams.size).toBe(55);
    expect(target.shaderParams.intensity).toBe(3.5);
    expect(target.shaderParams.scale).toBe(2.0);
    expect(target.shaderParams.preserveColors).toBe(true);
    expect(target.shaderParams.reversePalette).toBe(true);
    expect(target.shaderParams.palette).toEqual(customPalette);
    expect(target.shaderParams.glass?.kind).toBe("flowing");
    expect(target.shaderParams.glass?.angle).toBe(90);
    expect(target.shaderParams.postProcess?.grain?.intensity).toBe(0.8);
    expect(target.shaderParams.postProcess?.chromaticAberration?.offset).toBe(5);
    expect(target.shaderParams.adjustments?.brightness).toBe(1.3);
  });

  test("round-trip with user palette clones it with a new unique ID", async () => {
    let clipboardContent = "";
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      clipboardContent = text;
    });
    vi.spyOn(navigator.clipboard, "readText").mockImplementation(async () => clipboardContent);

    const userPalette: ColorPalette = {
      id: "cstm_source1",
      name: "Custom 1",
      shortName: "Custom 1",
      colors: [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
      ],
    };
    paletteStore.addPalette(userPalette);

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    // Flush CanvasProvider's async palette hydration before operating on the store
    await act(async () => {});

    paletteStore.addPalette(userPalette);

    let sourceId = "";
    let targetId = "";

    act(() => {
      sourceId = addEntityWithParams(canvas, ShaderType.dithering, { palette: userPalette });
      targetId = addEntityWithParams(canvas, ShaderType.halftone, {});
    });

    // Copy from source
    act(() => {
      canvas.selectEntity(sourceId);
    });
    act(() => {
      canvas.copySelectionEffects();
    });

    // Paste to target
    act(() => {
      canvas.selectEntity(targetId);
    });
    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(targetId);
      return entity?.shaderType === ShaderType.dithering;
    });

    const target = canvasStore.getState().entities.get(targetId)!;
    // Palette should have same colors but a NEW unique ID
    expect(target.shaderParams.palette?.colors).toEqual(userPalette.colors);
    expect(target.shaderParams.palette?.id).not.toBe("cstm_source1");
    expect(isUserPalette(target.shaderParams.palette?.id)).toBe(true);
    // New palette should be in the store
    expect(paletteStore.getPalettes().some((p) => p.id === target.shaderParams.palette?.id)).toBe(
      true,
    );
  });

  test("paste does not mutate source entity when target is modified later", async () => {
    let clipboardContent = "";
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      clipboardContent = text;
    });
    vi.spyOn(navigator.clipboard, "readText").mockImplementation(async () => clipboardContent);

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    let sourceId = "";
    let targetId = "";

    act(() => {
      sourceId = addEntityWithParams(canvas, ShaderType.dithering, { size: 42 });
      targetId = canvas.addEntity(createEntityInput());
    });

    // Copy from source
    act(() => {
      canvas.selectEntity(sourceId);
    });
    act(() => {
      canvas.copySelectionEffects();
    });

    // Paste to target
    act(() => {
      canvas.selectEntity(targetId);
    });
    await act(async () => {
      await canvas.pasteEffects();
    });

    // Modify target
    act(() => {
      canvas.updateSelectedEntityParams({ size: 999 });
    });

    // Source should be unaffected (structuredClone prevents reference sharing)
    const source = canvasStore.getState().entities.get(sourceId)!;
    expect(source.shaderParams.size).toBe(42);
  });
});

describe("paste palette isolation", () => {
  const skipProviders = {
    iconoir: true,
    toast: true,
    keybind: true,
    videoExport: true,
    exportQueue: true,
  };

  test("pasting user palette creates a new custom palette with unique ID", async () => {
    const userPalette: ColorPalette = {
      id: "cstm_abc1234",
      name: "My Custom",
      shortName: "MC",
      colors: [
        [0.1, 0.2, 0.3, 1],
        [0.9, 0.8, 0.7, 1],
      ],
    };
    paletteStore.addPalette(userPalette);

    const clipboardData = JSON.stringify({
      __voidmesh: true,
      version: 1,
      shaderType: ShaderType.dithering,
      shaderParams: { ...structuredClone(config.defaults.shaderParams), palette: userPalette },
    });
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(clipboardData);

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId = "";

    act(() => {
      entityId = addEntityWithParams(canvas, ShaderType.halftone, {});
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderType === ShaderType.dithering;
    });

    const entity = canvasStore.getState().entities.get(entityId)!;
    expect(entity.shaderParams.palette?.id).not.toBe("cstm_abc1234");
    expect(entity.shaderParams.palette?.id?.startsWith("cstm_")).toBe(true);
    expect(entity.shaderParams.palette?.colors).toEqual(userPalette.colors);
  });

  test("pasting async palette converts to custom palette", async () => {
    const asyncPalette: ColorPalette = {
      id: "original",
      name: "Original",
      shortName: "Original",
      colors: Array.from(
        { length: 6 },
        (_, i) => [i / 5, 0, 0, 1] as [number, number, number, number],
      ),
    };

    const clipboardData = JSON.stringify({
      __voidmesh: true,
      version: 1,
      shaderType: ShaderType.dithering,
      shaderParams: { ...structuredClone(config.defaults.shaderParams), palette: asyncPalette },
    });
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(clipboardData);

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId = "";

    act(() => {
      entityId = addEntityWithParams(canvas, ShaderType.halftone, {});
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderType === ShaderType.dithering;
    });

    const entity = canvasStore.getState().entities.get(entityId)!;
    // Should be converted to a custom palette, not "original"
    expect(entity.shaderParams.palette?.id).not.toBe("original");
    expect(entity.shaderParams.palette?.id?.startsWith("cstm_")).toBe(true);
    expect(entity.shaderParams.palette?.colors).toHaveLength(6);
  });

  test("pasting preset palette does NOT clone — shares preset ID", async () => {
    const presetPalette = config.palettes.gameboy;

    const clipboardData = JSON.stringify({
      __voidmesh: true,
      version: 1,
      shaderType: ShaderType.dithering,
      shaderParams: { ...structuredClone(config.defaults.shaderParams), palette: presetPalette },
    });
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(clipboardData);

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId = "";

    act(() => {
      entityId = addEntityWithParams(canvas, ShaderType.halftone, {});
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderType === ShaderType.dithering;
    });

    const entity = canvasStore.getState().entities.get(entityId)!;
    expect(entity.shaderParams.palette?.id).toBe("gameboy");
  });

  test("multi-select paste creates separate palettes per entity", async () => {
    const userPalette: ColorPalette = {
      id: "cstm_multi01",
      name: "Multi Pal",
      shortName: "MP",
      colors: [
        [1, 0, 0, 1],
        [0, 0, 1, 1],
      ],
    };
    paletteStore.addPalette(userPalette);

    const clipboardData = JSON.stringify({
      __voidmesh: true,
      version: 1,
      shaderType: ShaderType.dithering,
      shaderParams: { ...structuredClone(config.defaults.shaderParams), palette: userPalette },
    });
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(clipboardData);

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityIds: string[] = [];

    act(() => {
      entityIds = [
        addEntityWithParams(canvas, ShaderType.halftone, {}),
        addEntityWithParams(canvas, ShaderType.ascii, {}),
        addEntityWithParams(canvas, ShaderType.blobs, {}),
      ];
      canvasStore.replaceSelection(entityIds);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() =>
      entityIds.every(
        (id) => canvasStore.getState().entities.get(id)?.shaderType === ShaderType.dithering,
      ),
    );

    const paletteIds = entityIds.map(
      (id) => canvasStore.getState().entities.get(id)!.shaderParams.palette?.id,
    );

    // Each entity should have a different palette ID
    const uniqueIds = new Set(paletteIds);
    expect(uniqueIds.size).toBe(3);

    // None should be the original source ID
    for (const pid of paletteIds) {
      expect(pid).not.toBe("cstm_multi01");
      expect(pid?.startsWith("cstm_")).toBe(true);
    }

    // All should have the same colors
    for (const id of entityIds) {
      const entity = canvasStore.getState().entities.get(id)!;
      expect(entity.shaderParams.palette?.colors).toEqual(userPalette.colors);
    }
  });

  test("undo paste removes cloned palette from palette store", async () => {
    const userPalette: ColorPalette = {
      id: "cstm_undo123",
      name: "Undo Test",
      shortName: "UT",
      colors: [
        [1, 1, 0, 1],
        [0, 1, 1, 1],
      ],
    };
    const clipboardData = JSON.stringify({
      __voidmesh: true,
      version: 1,
      shaderType: ShaderType.dithering,
      shaderParams: { ...structuredClone(config.defaults.shaderParams), palette: userPalette },
    });
    vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(clipboardData);

    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    // Flush CanvasProvider's async palette hydration before operating on the store
    await act(async () => {});

    paletteStore.addPalette(userPalette);

    let entityId = "";

    act(() => {
      entityId = addEntityWithParams(canvas, ShaderType.halftone, { size: 10 });
      canvas.selectEntity(entityId);
    });

    await act(async () => {
      await canvas.pasteEffects();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderType === ShaderType.dithering;
    });

    const entity = canvasStore.getState().entities.get(entityId)!;
    const clonedId = entity.shaderParams.palette?.id;
    expect(clonedId).not.toBe("cstm_undo123");

    // Cloned palette should be in store
    expect(paletteStore.getPalettes().some((p) => p.id === clonedId)).toBe(true);

    // Undo
    performUndo();

    // Cloned palette should be removed from store
    expect(paletteStore.getPalettes().some((p) => p.id === clonedId)).toBe(false);

    // Entity should be restored
    assertShaderType(entityId, ShaderType.halftone);
    assertEntityParam(entityId, "size", 10);
  });
});
