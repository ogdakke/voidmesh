import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { releaseImageAsset, retainImageAsset } from "#lib/media-assets.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

vi.mock("#renderer/entity-shader-runtime.ts", () => ({
  EntityShaderRuntime: class {
    processingPipeline = {};
    passthroughCopyPass = {};
    initialize = vi.fn<() => Promise<void>>(async () => {});
    encode = vi.fn<() => void>();
    needsContinuousRender = vi.fn<() => boolean>(() => false);
    removeEntity = vi.fn<() => void>();
    removeGlassEntity = vi.fn<() => void>();
    flushTextureReleases = vi.fn<() => void>();
    endFrame = vi.fn<() => void>();
    destroy = vi.fn<() => void>();
  },
}));

const { EntityTexturePipeline } = await import("#renderer/entity-texture-pipeline.ts");

describe("EntityTexturePipeline processed image sharing", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUTextureUsage", {
      TEXTURE_BINDING: 1,
      COPY_DST: 2,
      COPY_SRC: 4,
      RENDER_ATTACHMENT: 8,
    });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("shares one processed texture across identical static image instances", () => {
    const first = createTestEntity({ id: "processed-first" });
    if (first.mediaSource.type !== "image") throw new Error("Expected image entity");
    retainImageAsset(first.mediaSource.asset);
    const second: ShaderCanvasEntity = {
      ...first,
      id: "processed-second",
      shaderParams: structuredClone(first.shaderParams),
      mediaSource: { type: "image", asset: first.mediaSource.asset },
      textureDirty: true,
    };

    const sourceTexture = createTexture();
    const processedTexture = createTexture();
    const textures = [sourceTexture, processedTexture];
    const device = {
      queue: {
        copyExternalImageToTexture: vi.fn<GPUQueue["copyExternalImageToTexture"]>(),
      },
      createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
      createTexture: vi.fn<GPUDevice["createTexture"]>(() => {
        const texture = textures.shift();
        if (!texture) throw new Error("Unexpected texture allocation");
        return texture;
      }),
    } as unknown as GPUDevice;
    const pipeline = new EntityTexturePipeline({
      device,
      colorConfig: {
        supportsP3: false,
        canvasFormat: "bgra8unorm",
        canvasColorSpace: "srgb",
        intermediateFormat: "rgba16float",
        textureColorSpace: "srgb",
      },
      texturePool: null,
    });

    const firstResult = pipeline.renderEntityToTexture(first, {} as GPUCommandEncoder);
    const secondResult = pipeline.renderEntityToTexture(second, {} as GPUCommandEncoder);

    expect(firstResult).toEqual({ kind: "texture", texture: processedTexture });
    expect(secondResult).toEqual(firstResult);
    expect(device.createTexture).toHaveBeenCalledTimes(2);
    expect(pipeline.getResidencyStats()).toMatchObject({
      sourceTextureCount: 1,
      processedTextureCount: 1,
      processedTextureAllocations: 1,
    });

    pipeline.removeEntity(first.id);
    expect(processedTexture.destroy).not.toHaveBeenCalled();
    pipeline.removeEntity(second.id);
    expect(processedTexture.destroy).toHaveBeenCalledOnce();

    releaseImageAsset(first.mediaSource.asset);
    releaseImageAsset(first.mediaSource.asset);
  });

  test("reuses a video poster texture while live preview is suppressed", () => {
    const entity = createTestEntity({
      id: "video-poster",
      mediaType: "video",
      shaderParams: { showOriginal: true },
    });
    entity.textureDirty = true;
    const posterTexture = createTexture();
    const device = {
      queue: {
        copyExternalImageToTexture: vi.fn<GPUQueue["copyExternalImageToTexture"]>(),
      },
      createTexture: vi.fn<GPUDevice["createTexture"]>(() => posterTexture),
      createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    } as unknown as GPUDevice;
    const pipeline = new EntityTexturePipeline({
      device,
      colorConfig: {
        supportsP3: false,
        canvasFormat: "bgra8unorm",
        canvasColorSpace: "srgb",
        intermediateFormat: "rgba16float",
        textureColorSpace: "srgb",
      },
      texturePool: null,
    });

    const first = pipeline.renderEntityToTexture(
      entity,
      {} as GPUCommandEncoder,
      entity.originalSize,
      false,
    );
    entity.textureDirty = true;
    const second = pipeline.renderEntityToTexture(
      entity,
      {} as GPUCommandEncoder,
      entity.originalSize,
      false,
    );

    expect(first).toEqual({ kind: "texture", texture: posterTexture });
    expect(second).toEqual(first);
    expect(device.createTexture).toHaveBeenCalledOnce();
    expect(device.queue.copyExternalImageToTexture).toHaveBeenCalledOnce();
    expect(pipeline.getResidencyStats().sourceTextureCount).toBe(1);
  });
});

function createTexture(): GPUTexture {
  return {
    width: 200,
    height: 150,
    destroy: vi.fn<() => void>(),
  } as unknown as GPUTexture;
}
