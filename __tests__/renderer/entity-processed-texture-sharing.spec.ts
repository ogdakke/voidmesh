import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { releaseImageAsset, retainImageAsset } from "#lib/media-assets.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

const externalCopyEncode = vi.hoisted(() => vi.fn<() => void>());

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

vi.mock("#renderer/external-texture-copy-pass.ts", () => ({
  ExternalTextureCopyPass: class {
    encode = externalCopyEncode;
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

  test("copies show-original video frames into a projected LOD texture", () => {
    externalCopyEncode.mockClear();
    const entity = createTestEntity({
      id: "video-lod",
      mediaType: "video",
      shaderParams: { showOriginal: true },
    });
    const externalTexture = {} as GPUExternalTexture;
    const outputTexture = createTexture(128, 72);
    const device = {
      importExternalTexture: vi.fn<GPUDevice["importExternalTexture"]>(() => externalTexture),
      createTexture: vi.fn<GPUDevice["createTexture"]>(() => outputTexture),
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

    const result = pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder, {
      width: 128,
      height: 72,
    });

    expect(result).toEqual({ kind: "texture", texture: outputTexture });
    expect(externalCopyEncode).toHaveBeenCalledWith(
      expect.anything(),
      externalTexture,
      outputTexture,
    );
    expect(pipeline.getResidencyStats()).toMatchObject({
      processedBytes: 128 * 72 * 8,
      processedTextureCount: 1,
    });
  });
});

function createTexture(width = 200, height = 150): GPUTexture {
  return {
    width,
    height,
    destroy: vi.fn<() => void>(),
  } as unknown as GPUTexture;
}
