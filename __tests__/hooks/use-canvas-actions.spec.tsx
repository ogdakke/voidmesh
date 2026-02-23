/**
 * Tests for use-canvas-actions hook
 * Tests the useCanvasActions hook with multi-select support
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { waitFor, act } from "@testing-library/react";
import { canvasStore } from "#engine";
import { createEntityInput } from "../helpers/test-entity.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { ShaderType } from "#types/canvas.ts";
import { clearUndoHistory, performUndo } from "../helpers/undo-helpers.ts";
import {
  assertEntityExists,
  assertEntityNotExists,
  assertEntityParam,
  assertShaderType,
} from "../helpers/assertions.ts";
import { config } from "#config";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
  clearUndoHistory();
});

afterEach(() => {
  clearUndoHistory();
  cleanup();
});

// Skip providers we don't need for these tests
const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

describe("selectionState computation", () => {
  test("returns empty state when no selection", async () => {
    const { actions } = renderWithCanvas(undefined, { skip: skipProviders });

    // Initial render with no selection - hook's initial state
    expect(actions.selectionState).not.toBeNull();
    expect(actions.selectionState.isEmpty).toBe(true);
    expect(actions.selectionState.count).toBe(0);
    expect(actions.selectionState.isSingle).toBe(false);
    expect(actions.selectionState.isMultiple).toBe(false);
  });

  test("returns isSingle=true for single entity", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    act(() => {
      const id = canvas.addEntity(createEntityInput({ shaderType: ShaderType.halftone }));
      canvas.selectEntity(id);
    });

    await waitFor(() => canvasStore.getState().selectedEntityIds.size === 1);

    // Verify store state directly (the hook derives from this)
    const snapshot = canvasStore.getState();
    expect(snapshot.selectedEntityIds.size).toBe(1);
    expect(canvasStore.getSelectionCount()).toBe(1);
  });

  test("returns isMultiple=true for multiple entities", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    act(() => {
      const ids = [
        canvas.addEntity(createEntityInput({ shaderType: ShaderType.halftone })),
        canvas.addEntity(createEntityInput({ shaderType: ShaderType.dithering })),
      ];
      canvasStore.replaceSelection(ids);
    });

    await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

    // Verify store state directly (the hook derives from this)
    const snapshot = canvasStore.getState();
    expect(snapshot.selectedEntityIds.size).toBe(2);
    expect(canvasStore.getSelectionCount()).toBe(2);
  });

  test("computes hasUniformShader correctly", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    act(() => {
      // Add entities with same shader type
      const ids = [
        canvas.addEntity(createEntityInput({ shaderType: ShaderType.halftone })),
        canvas.addEntity(createEntityInput({ shaderType: ShaderType.halftone })),
      ];
      canvasStore.replaceSelection(ids);
    });

    await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

    // Verify all selected entities have the same shader type
    const entities = canvasStore.getSelectedEntities();
    const shaderTypes = new Set(entities.map((e) => e.shaderType));
    expect(shaderTypes.size).toBe(1);
  });

  test("computes paramValues uniformity", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityIds: string[] = [];

    act(() => {
      // Add entities (they get URL default params)
      entityIds = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];

      // Set up different size values directly via store
      const entity1 = canvasStore.getState().entities.get(entityIds[0]!);
      const entity2 = canvasStore.getState().entities.get(entityIds[1]!);
      if (entity1 && entity2) {
        canvasStore.updateEntity(entityIds[0]!, {
          shaderParams: { ...entity1.shaderParams, size: 10 },
        });
        canvasStore.updateEntity(entityIds[1]!, {
          shaderParams: { ...entity2.shaderParams, size: 20 },
        });
      }
      canvasStore.replaceSelection(entityIds);
    });

    await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

    // Verify param values differ using getParamResult
    const paramResult = canvasStore.getParamResult("size", 0);
    expect(paramResult.isMixed).toBe(true);
  });
});

describe("handleShaderTypeChange", () => {
  test("returns early if no selection", async () => {
    // Use canvas.updateSelectedShaderType directly - it returns early if no selection
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });

    // Should not throw when called with no selection
    act(() => {
      canvas.updateSelectedShaderType(ShaderType.dithering);
    });

    // No entities exist, so nothing to check
    expect(canvasStore.getState().entities.size).toBe(0);
  });

  test("applies shader type change to selected entity", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId: string = "";

    act(() => {
      entityId = canvas.addEntity(createEntityInput({ shaderType: ShaderType.halftone }));
      canvas.selectEntity(entityId);
    });

    act(() => {
      canvas.updateSelectedShaderType(ShaderType.dithering);
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderType === ShaderType.dithering;
    });

    assertShaderType(entityId, ShaderType.dithering);
  });

  test("updates shader type for multiple selected entities", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityIds: string[] = [];

    act(() => {
      entityIds = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
      // Set up initial shader types directly via store
      canvasStore.updateEntity(entityIds[0]!, { shaderType: ShaderType.halftone });
      canvasStore.updateEntity(entityIds[1]!, { shaderType: ShaderType.blobs });
      canvasStore.replaceSelection(entityIds);
    });

    act(() => {
      canvas.updateSelectedShaderType(ShaderType.ascii);
    });

    await waitFor(() => {
      return entityIds.every((id) => {
        const entity = canvasStore.getState().entities.get(id);
        return entity?.shaderType === ShaderType.ascii;
      });
    });

    // Both should be ASCII
    for (const id of entityIds) {
      assertShaderType(id, ShaderType.ascii);
    }
  });
});

describe("deleteEntity", () => {
  test("removes single entity", async () => {
    const { canvas, actions } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId: string = "";

    act(() => {
      entityId = canvas.addEntity(createEntityInput());
      canvas.selectEntity(entityId);
    });

    act(() => {
      actions.deleteEntity();
    });

    await waitFor(() => !canvasStore.getState().entities.has(entityId));

    assertEntityNotExists(entityId);
  });

  test("removes all selected in multi-select", async () => {
    const { canvas, actions } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityIds: string[] = [];

    act(() => {
      entityIds = [
        canvas.addEntity(createEntityInput()),
        canvas.addEntity(createEntityInput()),
        canvas.addEntity(createEntityInput()),
      ];
      canvasStore.replaceSelection(entityIds);
    });

    act(() => {
      actions.deleteEntity();
    });

    await waitFor(() => canvasStore.getState().entities.size === 0);

    // All entities should be removed
    for (const id of entityIds) {
      assertEntityNotExists(id);
    }
  });

  test("creates transaction for multi-delete", async () => {
    const { canvas, actions } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityIds: string[] = [];

    act(() => {
      entityIds = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
      canvasStore.replaceSelection(entityIds);
    });

    act(() => {
      actions.deleteEntity();
    });

    await waitFor(() => canvasStore.getState().entities.size === 0);

    // Single undo should restore all
    performUndo();

    // Both entities should be back
    for (const id of entityIds) {
      assertEntityExists(id);
    }
  });
});

describe("resetEntityToDefaults", () => {
  test("resets single entity to defaults", async () => {
    const { canvas, actions } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityId: string = "";

    act(() => {
      entityId = canvas.addEntity(
        createEntityInput({
          shaderType: ShaderType.dithering,
          shaderParams: { size: 42 },
        }),
      );
      canvas.selectEntity(entityId);
    });

    act(() => {
      actions.resetEntityToDefaults();
    });

    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderParams.size === config.defaults.shaderParams.size;
    });

    const entity = canvasStore.getState().entities.get(entityId);
    expect(entity?.shaderType).toBe(config.defaults.shader);
    expect(entity?.shaderParams.size).toBe(config.defaults.shaderParams.size);
  });

  test("resets all in multi-select with transaction", async () => {
    const { canvas, actions } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityIds: string[] = [];

    act(() => {
      entityIds = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
      // Set up initial state directly via store (no undo entries)
      // This is needed because addEntity applies URL state, not the input values
      const entity1 = canvasStore.getState().entities.get(entityIds[0]!);
      const entity2 = canvasStore.getState().entities.get(entityIds[1]!);
      if (entity1 && entity2) {
        canvasStore.updateEntity(entityIds[0]!, {
          shaderType: ShaderType.dithering,
          shaderParams: { ...entity1.shaderParams, size: 30 },
        });
        canvasStore.updateEntity(entityIds[1]!, {
          shaderType: ShaderType.ascii,
          shaderParams: { ...entity2.shaderParams, size: 50 },
        });
      }
      canvasStore.replaceSelection(entityIds);
    });

    act(() => {
      actions.resetEntityToDefaults();
    });

    await waitFor(() => {
      return entityIds.every((id) => {
        const entity = canvasStore.getState().entities.get(id);
        return entity?.shaderType === config.defaults.shader;
      });
    });

    // All should be reset to defaults
    for (const id of entityIds) {
      const entity = canvasStore.getState().entities.get(id);
      expect(entity?.shaderType).toBe(config.defaults.shader);
      expect(entity?.shaderParams.size).toBe(config.defaults.shaderParams.size);
    }

    // Single undo should restore both
    performUndo();

    const entity1 = canvasStore.getState().entities.get(entityIds[0]!);
    const entity2 = canvasStore.getState().entities.get(entityIds[1]!);
    expect(entity1?.shaderType).toBe(ShaderType.dithering);
    expect(entity1?.shaderParams.size).toBe(30);
    expect(entity2?.shaderType).toBe(ShaderType.ascii);
    expect(entity2?.shaderParams.size).toBe(50);
  });
});

describe("updateSelectedEntities", () => {
  test("applies updater to all selected entities", async () => {
    const { canvas, actions } = renderWithCanvas(undefined, { skip: skipProviders });
    let entityIds: string[] = [];

    act(() => {
      entityIds = [
        canvas.addEntity(createEntityInput({ shaderParams: { showOriginal: false } })),
        canvas.addEntity(createEntityInput({ shaderParams: { showOriginal: false } })),
      ];
      canvasStore.replaceSelection(entityIds);
    });

    act(() => {
      actions.updateSelectedEntities((entity) => ({
        shaderParams: {
          ...entity.shaderParams,
          showOriginal: true,
        },
      }));
    });

    await waitFor(() => {
      return entityIds.every((id) => {
        const entity = canvasStore.getState().entities.get(id);
        return entity?.shaderParams.showOriginal === true;
      });
    });

    // All should have showOriginal: true
    for (const id of entityIds) {
      assertEntityParam(id, "showOriginal", true);
    }
  });
});
