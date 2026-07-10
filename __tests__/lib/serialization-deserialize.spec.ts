import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import { canvasStore } from "#engine";
import { config } from "#config";
import { provideMockAnalytics } from "#lib/analytics.ts";
import { deserialize } from "#lib/serialization/deserialize.ts";
import { CURRENT_VERSION } from "#lib/serialization/version.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";

function createImageWorkspace(
  entityCount = 1,
  sharedMedia = false,
  minimalShaderParams = false,
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
        palettes: [],
      }),
    ),
    ...Object.fromEntries(entities.map((entity) => [entity.mediaFile, new Uint8Array([1, 2, 3])])),
  });

  return new Uint8Array(archive).buffer;
}

describe("deserialize workspace", () => {
  let cleanup: () => void;
  let cleanupAnalytics: (() => void) | undefined;

  beforeEach(() => {
    cleanup?.();
    cleanup = setupCanvasTest();
    cleanupAnalytics?.();
    cleanupAnalytics = undefined;
  });

  afterEach(() => {
    cleanupAnalytics?.();
    cleanupAnalytics = undefined;
  });

  test("reports import progress stages in order", async () => {
    const { mock, cleanup: nextCleanupAnalytics } = provideMockAnalytics();
    cleanupAnalytics = nextCleanupAnalytics;
    const stages: string[] = [];
    const progressEvents: Array<{ stage: string; entityIndex?: number; entityName?: string }> = [];

    const result = await deserialize(createImageWorkspace(), {
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

  test("aborting during decode keeps the current canvas intact", async () => {
    canvasStore.setViewport({ offset: { x: 900, y: 450 }, zoom: 3 });

    const controller = new AbortController();
    await expect(
      deserialize(createImageWorkspace(2), {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.stage === "decoding" && progress.entityIndex === 2) {
            controller.abort();
          }
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(canvasStore.getState().entities.size).toBe(0);
    expect(canvasStore.getViewport()).toEqual({
      offset: { x: 900, y: 450 },
      zoom: 3,
    });
  });

  test("restores repeated image paths as one shared media asset", async () => {
    const result = await deserialize(createImageWorkspace(2, true));
    const entities = [...canvasStore.getState().entities.values()];

    expect(result.success).toBe(true);
    expect(entities).toHaveLength(2);
    if (entities[0]?.mediaSource.type !== "image" || entities[1]?.mediaSource.type !== "image") {
      throw new Error("Expected image entities");
    }
    expect(entities[0].mediaSource.asset).toBe(entities[1].mediaSource.asset);
    expect(entities[0].imageBitmap).toBe(entities[1].imageBitmap);
  });

  test("chunks large shared-image workspaces and restores them atomically", async () => {
    const decodingIndexes: number[] = [];
    let notifications = 0;
    const unsubscribe = canvasStore.subscribe(() => notifications++);

    const result = await deserialize(createImageWorkspace(1_500, true, true), {
      onProgress: (progress) => {
        if (progress.stage === "decoding" && progress.entityIndex) {
          decodingIndexes.push(progress.entityIndex);
        }
      },
    });

    expect(result).toMatchObject({ success: true, entityCount: 1_500 });
    expect(decodingIndexes).toEqual([1, 512, 1024, 1500]);
    expect(notifications).toBe(1);
    expect(canvasStore.getState().entitiesDirty.size).toBe(0);
    expect(canvasStore.getState().entities.size).toBe(1_500);

    unsubscribe();
  });
});
