import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { releaseImageAsset, retainImageAsset } from "#lib/media-assets.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

const runtimeEncode = vi.hoisted(() => vi.fn<() => void>());
const offscreenCanvasConstructor = vi.hoisted(() =>
  vi.fn<(width: number, height: number) => void>(),
);

vi.mock("#renderer/entity-shader-runtime.ts", () => ({
  EntityShaderRuntime: class {
    processingPipeline = {};
    passthroughCopyPass = {};
    initialize = vi.fn<() => Promise<void>>(async () => {});
    encode = runtimeEncode;
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
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;

        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
          offscreenCanvasConstructor(width, height);
        }

        getContext() {
          return { drawImage: vi.fn<CanvasRenderingContext2D["drawImage"]>() };
        }
      },
    );
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

  test("recycles a unique same-size processed output when shader params change", () => {
    runtimeEncode.mockClear();
    const entity = createTestEntity({ id: "processed-param-change" });
    const sourceTexture = createTexture();
    const processedTexture = createTexture();
    const device = createDevice([sourceTexture, processedTexture]);
    const pipeline = createPipeline(device);

    expect(pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder)).toEqual({
      kind: "texture",
      texture: processedTexture,
    });

    entity.shaderParams = structuredClone(entity.shaderParams);
    entity.shaderParams.size += 1;
    entity.textureDirty = true;

    expect(pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder)).toEqual({
      kind: "texture",
      texture: processedTexture,
    });
    expect(device.createTexture).toHaveBeenCalledTimes(2);
    expect(runtimeEncode).toHaveBeenCalledTimes(2);
    expect(pipeline.getResidencyStats()).toMatchObject({
      processedTextureCount: 1,
      processedTextureAllocations: 1,
    });
    expect(processedTexture.destroy).not.toHaveBeenCalled();

    pipeline.destroy();
    if (entity.mediaSource.type === "image") releaseImageAsset(entity.mediaSource.asset);
  });

  test("overwrites a retained processed video tier when its decoded-frame revision changed", () => {
    runtimeEncode.mockClear();
    const entity = createTestEntity({ id: "video-lod", mediaType: "video" });
    const detailTexture = createTexture(200, 150);
    const overviewTexture = createTexture(100, 75);
    const device = createDevice([detailTexture, overviewTexture]);
    const pipeline = createPipeline(device);

    entity.textureDirty = true;
    pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder);
    entity.textureDirty = false;

    entity.textureDirty = true;
    pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder, { width: 100, height: 75 });
    entity.textureDirty = false;

    expect(pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder)).toEqual({
      kind: "texture",
      texture: detailTexture,
    });
    expect(device.createTexture).toHaveBeenCalledTimes(2);
    expect(runtimeEncode).toHaveBeenCalledTimes(3);
  });

  test("refreshes retained GIF tiers while reusing one resize surface", () => {
    runtimeEncode.mockClear();
    offscreenCanvasConstructor.mockClear();
    const entity = createTestEntity({ id: "gif-lod", mediaType: "gif" });
    const textures = [
      createTexture(200, 150),
      createTexture(200, 150),
      createTexture(100, 75),
      createTexture(100, 75),
    ];
    const device = createDevice(textures);
    const pipeline = createPipeline(device);

    entity.textureDirty = true;
    pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder);
    entity.textureDirty = false;

    entity.textureDirty = true;
    pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder, { width: 100, height: 75 });
    entity.textureDirty = false;

    pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder);
    entity.textureDirty = true;
    pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder, { width: 100, height: 75 });

    expect(device.createTexture).toHaveBeenCalledTimes(4);
    expect(device.queue.copyExternalImageToTexture).toHaveBeenCalledTimes(4);
    expect(runtimeEncode).toHaveBeenCalledTimes(4);
    expect(offscreenCanvasConstructor).toHaveBeenCalledOnce();
  });

  test("admits animated-media demotions while viewport LOD is frozen", () => {
    const entity = createTestEntity({ id: "video-demotion", mediaType: "video" });
    const pipeline = createPipeline(createDevice([createTexture(200, 150)]));

    entity.textureDirty = true;
    pipeline.renderEntityToTexture(entity, {} as GPUCommandEncoder);
    pipeline.beginFrame(false);

    expect(pipeline.resolveRenderSize(entity, { width: 100, height: 75 })).toEqual({
      width: 100,
      height: 75,
    });
  });
});

function createPipeline(device: GPUDevice): InstanceType<typeof EntityTexturePipeline> {
  return new EntityTexturePipeline({
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
}

function createTexture(width = 200, height = 150): GPUTexture {
  return {
    width,
    height,
    destroy: vi.fn<() => void>(),
  } as unknown as GPUTexture;
}

function createDevice(textures: GPUTexture[]): GPUDevice {
  return {
    queue: {
      copyExternalImageToTexture: vi.fn<GPUQueue["copyExternalImageToTexture"]>(),
    },
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    importExternalTexture: vi.fn<GPUDevice["importExternalTexture"]>(
      () => ({}) as GPUExternalTexture,
    ),
    createTexture: vi.fn<GPUDevice["createTexture"]>(() => {
      const texture = textures.shift();
      if (!texture) throw new Error("Unexpected texture allocation");
      return texture;
    }),
  } as unknown as GPUDevice;
}
