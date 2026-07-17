import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { canvasStore } from "#engine";
import { config } from "#config";
import { provideMockAnalytics } from "#lib/analytics.ts";
import { disposeEntityMedia } from "#lib/media-resources.ts";
import { paletteStore } from "#lib/palette-store.ts";
import { deserialize } from "#lib/serialization/deserialize.ts";
import type {
  DecodedWorkspace,
  DeserializeOptions,
  DeserializeResult,
} from "#lib/serialization/types.ts";
import { CURRENT_VERSION } from "#lib/serialization/version.ts";
import type { ColorPalette } from "#types/canvas.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";

function createImageWorkspace(
  entityCount = 1,
  sharedMedia = false,
  minimalShaderParams = false,
  palettes: ColorPalette[] = [],
): ArrayBuffer {
  const entities = Array.from({ length: entityCount }, (_, index) => ({
    id: `entity-${index + 1}`,
    name: `Image ${index + 1}`,
    mediaType: "image" as const,
    mediaFile: sharedMedia ? "media/assets/shared.png" : `media/image-${index + 1}.png`,
    position: { x: index * 10, y: index * 20 },
    size: { width: 100, height: 100 },
    originalSize: { width: 100, height: 100 },
    zIndex: index,
    rotation: 0,
    locked: false,
    edited: false,
    shaderType: config.defaults.shader,
    shaderParams: minimalShaderParams ? {} : structuredClone(config.defaults.shaderParams),
  }));

  const archive = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        type: "studio-canvas",
        version: CURRENT_VERSION,
        createdAt: new Date("2026-04-15T10:00:00.000Z").toISOString(),
        viewport: {
          offset: { x: 42, y: 24 },
          zoom: 1.5,
        },
        entities,
        palettes,
      }),
    ),
    ...Object.fromEntries(entities.map((entity) => [entity.mediaFile, new Uint8Array([1, 2, 3])])),
  });

  return new Uint8Array(archive).buffer;
}

function commitToCanvas(workspace: DecodedWorkspace): void {
  const previousEntities = [...canvasStore.getState().entities.values()];
  workspace.adopt((entities, viewport) => canvasStore.restoreWorkspace(entities, viewport));
  for (const entity of previousEntities) disposeEntityMedia(entity);
  paletteStore.mergePalettes(workspace.palettes);
}

function deserializeIntoCanvas(
  source: Blob | ArrayBuffer,
  options: DeserializeOptions = {},
): Promise<DeserializeResult> {
  return deserialize(source, commitToCanvas, options);
}

describe("deserialize workspace", () => {
  let cleanup: () => void;
  let cleanupAnalytics: (() => void) | undefined;
  let originalPalettes: ColorPalette[];

  beforeEach(() => {
    cleanup = setupCanvasTest();
    cleanupAnalytics = undefined;
    originalPalettes = paletteStore.getPalettes();
  });

  afterEach(() => {
    for (const entity of canvasStore.getState().entities.values()) disposeEntityMedia(entity);
    canvasStore.reset();
    paletteStore.setPalettes(originalPalettes);
    cleanupAnalytics?.();
    cleanupAnalytics = undefined;
    cleanup();
    vi.restoreAllMocks();
  });

  test("reports import progress stages in order", async () => {
    const { mock, cleanup: nextCleanupAnalytics } = provideMockAnalytics();
    cleanupAnalytics = nextCleanupAnalytics;
    const stages: string[] = [];
    const progressEvents: Array<{ stage: string; entityIndex?: number; entityName?: string }> = [];

    const result = await deserializeIntoCanvas(createImageWorkspace(), {
      onProgress: (progress) => {
        stages.push(progress.stage);
        progressEvents.push({
          stage: progress.stage,
          entityIndex: progress.entityIndex,
          entityName: progress.entityName,
        });
      },
    });

    expect(result.success).toBe(true);
    expect(result.entityCount).toBe(1);
    expect(stages).toEqual(["reading", "unzipping", "parsing", "decoding", "restoring", "done"]);
    expect(progressEvents[3]).toEqual({
      stage: "decoding",
      entityIndex: 1,
      entityName: "Image 1",
    });
    expect(canvasStore.getState().entities.size).toBe(1);
    expect(mock.calls).toContainEqual({
      event: "deserialization.import_summary",
      properties: expect.objectContaining({
        workspaceEntityCount: 1,
        videoEntityCount: 0,
        videoSeekTimeoutCount: 0,
        errorCount: 0,
        success: true,
      }),
    });
  });

  test("aborting during decode disposes staged media and defers palettes", async () => {
    canvasStore.setViewport({ offset: { x: 900, y: 450 }, zoom: 3 });
    const importedPalette: ColorPalette = {
      id: "cstm_cancelled-import",
      name: "Cancelled import",
      shortName: "Cancelled",
      colors: [
        [1, 0, 0, 1],
        [0, 0, 0, 1],
      ],
    };
    const close = vi.fn<() => void>();
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = vi.fn<() => Promise<ImageBitmap>>(
      async () => ({ width: 100, height: 100, close }) as ImageBitmap,
    ) as typeof createImageBitmap;

    const controller = new AbortController();
    try {
      await expect(
        deserializeIntoCanvas(createImageWorkspace(3, true, false, [importedPalette]), {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.stage === "decoding" && progress.entityIndex === 3) {
              controller.abort();
            }
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }

    expect(close).toHaveBeenCalledOnce();
    expect(paletteStore.getPalettes().some((palette) => palette.id === importedPalette.id)).toBe(
      false,
    );
    expect(canvasStore.getState().entities.size).toBe(0);
    expect(canvasStore.getViewport()).toEqual({
      offset: { x: 900, y: 450 },
      zoom: 3,
    });
  });

  test("disposes decoded media when commit fails before adoption", async () => {
    const close = vi.fn<() => void>();
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = vi.fn<() => Promise<ImageBitmap>>(
      async () => ({ width: 100, height: 100, close }) as ImageBitmap,
    ) as typeof createImageBitmap;

    try {
      await expect(
        deserialize(createImageWorkspace(), () => {
          throw new Error("Commit failed");
        }),
      ).rejects.toThrow("Commit failed");
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }

    expect(close).toHaveBeenCalledOnce();
    expect(canvasStore.getState().entities.size).toBe(0);
  });

  test("rejects malformed workspace fields before commit", async () => {
    const commit = vi.fn<(workspace: DecodedWorkspace) => void>();
    const archive = createManifestArchive({
      type: "studio-canvas",
      version: CURRENT_VERSION,
      createdAt: new Date("2026-07-11T10:00:00.000Z").toISOString(),
      viewport: {},
      entities: [],
      palettes: {},
    });

    await expect(deserialize(archive, commit)).rejects.toThrow(
      "manifest contains missing or invalid workspace fields",
    );
    expect(commit).not.toHaveBeenCalled();
  });

  test("rejects duplicate entity IDs before decoding or commit", async () => {
    const commit = vi.fn<(workspace: DecodedWorkspace) => void>();
    const first = createSerializedImageEntity("entity-1", "media/first.png");
    const second = createSerializedImageEntity("entity-1", "media/second.png");
    const createBitmap = vi.spyOn(globalThis, "createImageBitmap");
    const archive = createManifestArchive(
      {
        type: "studio-canvas",
        version: CURRENT_VERSION,
        createdAt: new Date("2026-07-11T10:00:00.000Z").toISOString(),
        viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
        entities: [first, second],
        palettes: [],
      },
      {
        [first.mediaFile]: new Uint8Array([1]),
        [second.mediaFile]: new Uint8Array([2]),
      },
    );

    await expect(deserialize(archive, commit)).rejects.toThrow('duplicate entity ID "entity-1"');
    expect(createBitmap).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  test("migrates v5 storage without expanding already-compatible shader parameters", async () => {
    const entity = {
      ...createSerializedImageEntity("entity-1", "media/shared.png"),
      shaderParams: { size: 37 },
    };
    const archive = createManifestArchive(
      {
        type: "studio-canvas",
        version: 5,
        createdAt: new Date("2026-07-16T10:00:00.000Z").toISOString(),
        viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
        entities: [entity],
      },
      { "media/shared.png": new Uint8Array([1, 2, 3]) },
    );

    const result = await deserializeIntoCanvas(archive);
    const restored = canvasStore.getState().entities.get(entity.id)!;

    expect(result.warnings).toContain(`Migrated from v5 to v${CURRENT_VERSION}`);
    expect(restored.shaderParams.size).toBe(37);
    expect(restored.shaderParams.scale).toBeUndefined();
  });

  test("fills compatibility defaults for shader schemas older than v5", async () => {
    const entity = {
      ...createSerializedImageEntity("entity-1", "media/shared.png"),
      shaderParams: { size: 37 },
    };
    const archive = createManifestArchive(
      {
        type: "studio-canvas",
        version: 4,
        createdAt: new Date("2026-07-16T10:00:00.000Z").toISOString(),
        viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
        entities: [entity],
      },
      { "media/shared.png": new Uint8Array([1, 2, 3]) },
    );

    await deserializeIntoCanvas(archive);
    const restored = canvasStore.getState().entities.get(entity.id)!;

    expect(restored.shaderParams.size).toBe(37);
    expect(restored.shaderParams.scale).toBe(config.defaults.shaderParams.scale);
  });

  test("restores repeated image paths as one shared media asset", async () => {
    const result = await deserializeIntoCanvas(createImageWorkspace(2, true));
    const entities = [...canvasStore.getState().entities.values()];

    expect(result.success).toBe(true);
    expect(entities).toHaveLength(2);
    if (entities[0]?.mediaSource.type !== "image" || entities[1]?.mediaSource.type !== "image") {
      throw new Error("Expected image entities");
    }
    expect(entities[0].mediaSource.asset).toBe(entities[1].mediaSource.asset);
    expect(entities[0].imageBitmap).toBe(entities[1].imageBitmap);
  });

  test("shares immutable shader trees and palettes while isolating animation state", async () => {
    const originalPalette: ColorPalette = {
      id: "original",
      name: "Original",
      shortName: "Original",
      colors: [
        [0.1, 0.2, 0.3, 1],
        [0.8, 0.9, 1, 1],
      ],
    };
    const first = {
      ...createSerializedImageEntity("entity-1", "media/shared.png"),
      originalPalette: structuredClone(originalPalette),
    };
    first.shaderParams.time = 1;
    const second = {
      ...createSerializedImageEntity("entity-2", "media/shared.png"),
      originalPalette: structuredClone(originalPalette),
    };
    second.shaderParams.time = 2;
    const archive = createManifestArchive(
      {
        type: "studio-canvas",
        version: CURRENT_VERSION,
        createdAt: new Date("2026-07-16T10:00:00.000Z").toISOString(),
        viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
        entities: [first, second],
        palettes: [],
      },
      { "media/shared.png": new Uint8Array([1, 2, 3]) },
    );

    const result = await deserializeIntoCanvas(archive);
    const entities = [...canvasStore.getState().entities.values()];
    const firstEntity = entities[0]!;
    const secondEntity = entities[1]!;

    expect(result.success).toBe(true);
    expect(firstEntity.shaderParams).not.toBe(secondEntity.shaderParams);
    expect(firstEntity.shaderParams.postProcess).toBe(secondEntity.shaderParams.postProcess);
    expect(firstEntity.shaderParams.adjustments).toBe(secondEntity.shaderParams.adjustments);
    expect(firstEntity.shaderParams.palette).toBe(secondEntity.shaderParams.palette);
    expect(firstEntity.originalPalette).toBe(secondEntity.originalPalette);
    expect(firstEntity.shaderParams.time).toBe(1);
    expect(secondEntity.shaderParams.time).toBe(2);

    firstEntity.shaderParams.time = 9;
    expect(secondEntity.shaderParams.time).toBe(2);
  });

  test("restores compact manifest tables without expanding shared static records", async () => {
    const {
      time: _time,
      timeAutoPlay: _timeAutoPlay,
      ...staticParams
    } = structuredClone(config.defaults.shaderParams);
    const originalPalette: ColorPalette = {
      id: "compact-original",
      name: "Compact original",
      shortName: "Compact",
      colors: [
        [0, 0, 0, 1],
        [1, 1, 1, 1],
      ],
    };
    const compactEntity = (id: string, time: number) => ({
      id,
      name: id,
      mediaType: "image" as const,
      mediaFileRef: 0,
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      originalSize: { width: 100, height: 100 },
      zIndex: time,
      rotation: 0,
      locked: false,
      edited: false,
      shaderType: config.defaults.shader,
      shaderParamsRef: 0,
      shaderTime: time,
      originalPaletteRef: 0,
    });
    const archive = createManifestArchive(
      {
        type: "studio-canvas",
        version: CURRENT_VERSION,
        createdAt: new Date("2026-07-16T12:00:00.000Z").toISOString(),
        viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
        entities: [compactEntity("entity-1", 1), compactEntity("entity-2", 2)],
        shaderParamsTable: [staticParams],
        mediaFiles: ["media/shared.png"],
        originalPalettes: [originalPalette],
      },
      { "media/shared.png": new Uint8Array([1, 2, 3]) },
    );

    const result = await deserializeIntoCanvas(archive);
    const entities = [...canvasStore.getState().entities.values()];

    expect(result).toMatchObject({ success: true, entityCount: 2 });
    expect(entities[0]!.shaderParams).not.toBe(entities[1]!.shaderParams);
    expect(entities[0]!.shaderParams.postProcess).toBe(entities[1]!.shaderParams.postProcess);
    expect(entities[0]!.shaderParams.time).toBe(1);
    expect(entities[1]!.shaderParams.time).toBe(2);
    expect(entities[0]!.originalPalette).toBe(entities[1]!.originalPalette);
  });

  test("chunks large shared-image workspaces and restores them atomically", async () => {
    const decodingIndexes: number[] = [];
    let notifications = 0;
    const unsubscribe = canvasStore.subscribe(() => notifications++);

    const result = await deserializeIntoCanvas(createImageWorkspace(1_500, true, true), {
      onProgress: (progress) => {
        if (progress.stage === "decoding" && progress.entityIndex) {
          decodingIndexes.push(progress.entityIndex);
        }
      },
    });

    expect(result).toMatchObject({ success: true, entityCount: 1_500 });
    expect(decodingIndexes[0]).toBe(1);
    expect(decodingIndexes.at(-1)).toBe(1_500);
    expect(decodingIndexes).toEqual([...decodingIndexes].sort((left, right) => left - right));
    expect(notifications).toBe(1);
    expect(canvasStore.getState().entitiesDirty.size).toBe(0);
    expect(canvasStore.getState().entities.size).toBe(1_500);

    unsubscribe();
  });
});

function createSerializedImageEntity(id: string, mediaFile: string) {
  return {
    id,
    name: id,
    mediaType: "image" as const,
    mediaFile,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    originalSize: { width: 100, height: 100 },
    zIndex: 0,
    rotation: 0,
    locked: false,
    edited: false,
    shaderType: config.defaults.shader,
    shaderParams: structuredClone(config.defaults.shaderParams),
  };
}

function createManifestArchive(
  manifest: unknown,
  mediaEntries: Record<string, Uint8Array> = {},
): ArrayBuffer {
  const archive = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    ...mediaEntries,
  });
  return new Uint8Array(archive).buffer;
}
