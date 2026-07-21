import { act } from "@testing-library/react";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { config } from "#config";
import { canvasStore } from "#engine";
import { getImageAssetReferenceCount } from "#lib/media-assets.ts";
import { disposeEntityMedia } from "#lib/media-resources.ts";
import { CURRENT_VERSION } from "#lib/serialization/version.ts";
import { Command, undo } from "#lib/undo.ts";
import { createEntityInput } from "../helpers/test-entity.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { clearUndoHistory } from "../helpers/undo-helpers.ts";

const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

function createWorkspaceWithCollidingId(): ArrayBuffer {
  const mediaFile = "media/assets/imported.png";
  const archive = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        type: "studio-canvas",
        version: CURRENT_VERSION,
        createdAt: new Date("2026-07-11T10:00:00.000Z").toISOString(),
        viewport: { offset: { x: 25, y: 50 }, zoom: 1.5 },
        entities: [
          {
            id: "entity-1",
            name: "Imported entity",
            mediaType: "image",
            mediaFile,
            position: { x: 10, y: 20 },
            size: { width: 100, height: 100 },
            originalSize: { width: 100, height: 100 },
            zIndex: 1,
            rotation: 0,
            locked: false,
            edited: false,
            shaderType: config.defaults.shader,
            shaderParams: structuredClone(config.defaults.shaderParams),
            originalPalette: structuredClone(config.defaults.shaderParams.palette),
          },
        ],
        palettes: [],
      }),
    ),
    [mediaFile]: new Uint8Array([1, 2, 3]),
  });
  return new Uint8Array(archive).buffer;
}

function createWorkspaceWithMissingMedia(): ArrayBuffer {
  const archive = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        type: "studio-canvas",
        version: CURRENT_VERSION,
        createdAt: new Date("2026-07-11T10:00:00.000Z").toISOString(),
        viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
        entities: [createMissingMediaEntity()],
        palettes: [],
      }),
    ),
  });
  return new Uint8Array(archive).buffer;
}

function createMissingMediaEntity() {
  return {
    id: "entity-50",
    name: "Missing media",
    mediaType: "image",
    mediaFile: "media/missing.png",
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    originalSize: { width: 100, height: 100 },
    zIndex: 50,
    rotation: 0,
    locked: false,
    edited: false,
    shaderType: config.defaults.shader,
    shaderParams: structuredClone(config.defaults.shaderParams),
  };
}

describe("CanvasCommands.deserializeCanvas", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupCanvasTest();
    clearUndoHistory();
  });

  afterEach(() => {
    clearUndoHistory();
    for (const entity of canvasStore.getState().entities.values()) disposeEntityMedia(entity);
    canvasStore.reset();
    cleanup();
    vi.restoreAllMocks();
  });

  test("clears colliding undo ownership and releases the replaced workspace once", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    const oldInput = createEntityInput();
    if (oldInput.mediaSource.type !== "image") throw new Error("Expected image input");
    const oldAsset = oldInput.mediaSource.asset;
    const close = vi.spyOn(oldAsset.imageBitmap, "close");

    let oldId = "";
    act(() => {
      oldId = canvas.addEntity(oldInput, "Old entity");
    });
    expect(oldId).toMatch(/^entity-[0-9a-f-]{36}$/);
    expect(undo.canUndo()).toBe(true);

    await act(async () => {
      await canvas.deserializeCanvas(createWorkspaceWithCollidingId());
    });

    expect(close).toHaveBeenCalledOnce();
    expect(getImageAssetReferenceCount(oldAsset)).toBe(0);
    expect(undo.canUndo()).toBe(false);
    expect(undo.canRedo()).toBe(false);
    expect(canvasStore.getState().entities.get("entity-1")?.name).toBe("Imported entity");

    act(() => undo.undo());
    expect(canvasStore.getState().entities.get("entity-1")?.name).toBe("Imported entity");

    act(() => canvas.clearWorkspace());
  });

  test("preserves live entities when every imported entity fails decoding", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    let firstId = "";
    act(() => {
      firstId = canvas.addEntity(createEntityInput(), "Existing entity");
    });

    let result;
    await act(async () => {
      result = await canvas.deserializeCanvas(createWorkspaceWithMissingMedia());
    });

    let secondId = "";
    act(() => {
      secondId = canvas.addEntity(createEntityInput(), "Second entity");
    });

    expect(result).toMatchObject({ success: false, entityCount: 0 });
    expect(firstId).toMatch(/^entity-[0-9a-f-]{36}$/);
    expect(secondId).toMatch(/^entity-[0-9a-f-]{36}$/);
    expect(secondId).not.toBe(firstId);
    expect(canvasStore.getState().entities.get(firstId)?.name).toBe("Existing entity");

    act(() => canvas.clearWorkspace());
  });

  test("aborts active undo transactions before adopting colliding IDs", async () => {
    const { canvas } = renderWithCanvas(undefined, { skip: skipProviders });
    const onEvict = vi.fn<() => void>();
    act(() => {
      canvas.addEntity(createEntityInput(), "Old entity");
      undo.beginTransaction();
      undo.add(
        Command.create({
          execute: () => canvasStore.updateEntity("entity-1", { name: "Old redo" }),
          undo: () => canvasStore.updateEntity("entity-1", { name: "Old undo" }),
          onEvict,
        }),
      );
    });

    await act(async () => {
      await canvas.deserializeCanvas(createWorkspaceWithCollidingId());
    });
    act(() => {
      undo.commitTransaction();
      undo.undo();
    });

    expect(onEvict).toHaveBeenCalledOnce();
    expect(undo.isInTransaction()).toBe(false);
    expect(canvasStore.getState().entities.get("entity-1")?.name).toBe("Imported entity");

    act(() => canvas.clearWorkspace());
  });
});
