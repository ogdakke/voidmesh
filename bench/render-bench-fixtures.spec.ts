import {
  createBatchedBenchResources,
  disposeBenchEntities,
  getBenchEntityShaderParams,
  resolveBenchShaderParams,
  retainBenchImageMedia,
  type RetainedBenchImageMedia,
} from "./render-bench-fixtures.ts";
import {
  createImageAsset,
  getImageAssetReferenceCount,
  releaseImageAsset,
} from "#lib/media-assets.ts";
import { DitheringKind, MediaType, type ShaderCanvasEntity } from "#types/canvas.ts";
import { describe, expect, test, vi } from "vitest";

describe("render benchmark fixtures", () => {
  test("resolves and freezes one shared parameter tree for static entities", () => {
    const resolved = resolveBenchShaderParams({
      scale: 2,
      dithering: { kind: DitheringKind.bayer8x8 },
      adjustments: { brightness: 0.25, contrast: 0.5, saturation: 0.5, blur: 0 },
    });
    const first = getBenchEntityShaderParams(resolved, false);
    const second = getBenchEntityShaderParams(resolved, false);

    expect(first).toBe(second);
    expect(first.scale).toBe(2);
    expect(first.dithering?.kind).toBe(DitheringKind.bayer8x8);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.adjustments)).toBe(true);
    expect(() => {
      first.scale = 3;
    }).toThrow(TypeError);
  });

  test("shares the immutable nested tree while keeping animated time independent", () => {
    const resolved = resolveBenchShaderParams({ time: 1, timeAutoPlay: true });
    const first = getBenchEntityShaderParams(resolved, true);
    const second = getBenchEntityShaderParams(resolved, true);

    expect(first).not.toBe(second);
    expect(first.glass).toBe(second.glass);
    first.time = 2;
    expect(second.time).toBe(1);
  });

  test("retains once per image attachment and disposes through entity media ownership", () => {
    const close = vi.fn<() => void>();
    const bitmap = { close } as unknown as ImageBitmap;
    const asset = createImageAsset({
      id: "bench-shared-asset",
      imageBitmap: bitmap,
      blob: new Blob([], { type: "image/jpeg" }),
    });
    const firstMedia = retainBenchImageMedia(asset);
    const secondMedia = retainBenchImageMedia(asset);

    expect(getImageAssetReferenceCount(asset)).toBe(3);
    releaseImageAsset(asset);
    expect(getImageAssetReferenceCount(asset)).toBe(2);

    disposeBenchEntities([
      createImageEntity("first", firstMedia),
      createImageEntity("second", secondMedia),
    ]);

    expect(getImageAssetReferenceCount(asset)).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });

  test("waits for a failed batch and disposes every fulfilled sibling", async () => {
    const disposed: number[] = [];

    await expect(
      createBatchedBenchResources({
        count: 3,
        batchSize: 3,
        create: async (index) => {
          await Promise.resolve();
          if (index === 1) throw new Error("fixture failed");
          return index;
        },
        dispose: (value) => disposed.push(value),
      }),
    ).rejects.toThrow("fixture failed");

    expect(disposed).toEqual([2, 0]);
  });
});

function createImageEntity(id: string, media: RetainedBenchImageMedia): ShaderCanvasEntity {
  if (media.mediaSource.type !== MediaType.image) throw new Error("Expected image media");
  return {
    id,
    imageBitmap: media.imageBitmap,
    mediaSource: media.mediaSource,
  } as ShaderCanvasEntity;
}
