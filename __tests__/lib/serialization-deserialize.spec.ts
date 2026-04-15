import { beforeEach, describe, expect, test } from "vitest";
import { strToU8, zipSync } from "fflate";
import { canvasStore } from "#engine";
import { config } from "#config";
import { deserialize } from "#lib/serialization/deserialize.ts";
import { CURRENT_VERSION } from "#lib/serialization/version.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";

function createImageWorkspace(entityCount = 1): ArrayBuffer {
  const entities = Array.from({ length: entityCount }, (_, index) => ({
    id: `entity-${index + 1}`,
    name: `Image ${index + 1}`,
    mediaType: "image" as const,
    mediaFile: `media/image-${index + 1}.png`,
    position: { x: index * 10, y: index * 20 },
    size: { width: 100, height: 100 },
    originalSize: { width: 100, height: 100 },
    zIndex: index,
    rotation: 0,
    locked: false,
    edited: false,
    shaderType: config.defaults.shader,
    shaderParams: structuredClone(config.defaults.shaderParams),
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

  beforeEach(() => {
    cleanup?.();
    cleanup = setupCanvasTest();
  });

  test("reports import progress stages in order", async () => {
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
});
