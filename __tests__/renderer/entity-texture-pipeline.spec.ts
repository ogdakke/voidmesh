import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { config } from "#config";
import { EntityTexturePipeline } from "#renderer/entity-texture-pipeline.ts";
import type { GpuColorConfig } from "#renderer/gpu-color-space.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { releaseImageAsset, retainImageAsset } from "#lib/media-assets.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

const colorConfig: GpuColorConfig = {
  supportsP3: false,
  canvasFormat: "bgra8unorm",
  canvasColorSpace: "srgb",
  intermediateFormat: "rgba16float",
  textureColorSpace: "srgb",
};

describe("EntityTexturePipeline shared image sources", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUTextureUsage", {
      TEXTURE_BINDING: 1,
      COPY_DST: 2,
      COPY_SRC: 4,
      RENDER_ATTACHMENT: 8,
    });
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1, VERTEX: 2 });
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        readonly width: number;
        readonly height: number;

        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }

        getContext() {
          return { drawImage: vi.fn<CanvasRenderingContext2D["drawImage"]>() };
        }
      },
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test("uploads one source texture for multiple instances of the same image asset", () => {
    const first = createTestEntity({
      id: "image-first",
      shaderParams: { showOriginal: true },
    });
    if (first.mediaSource.type !== "image") throw new Error("Expected image entity");

    retainImageAsset(first.mediaSource.asset);
    const second: ShaderCanvasEntity = {
      ...first,
      id: "image-second",
      mediaSource: { type: "image", asset: first.mediaSource.asset },
      textureDirty: true,
    };

    const sourceTexture = createTexture(200, 150);
    const device = createDevice([sourceTexture]);
    const pipeline = new EntityTexturePipeline({
      device,
      colorConfig,
      texturePool: null,
    });
    const encoder = {} as GPUCommandEncoder;

    const firstSource = pipeline.renderEntityToTexture(first, encoder);
    const secondSource = pipeline.renderEntityToTexture(second, encoder);

    expect(firstSource).toEqual({ kind: "texture", texture: sourceTexture });
    expect(secondSource).toEqual({ kind: "texture", texture: sourceTexture });
    expect(device.createTexture).toHaveBeenCalledOnce();
    expect(device.queue.copyExternalImageToTexture).toHaveBeenCalledOnce();

    pipeline.removeEntity(first.id);
    expect(sourceTexture.destroy).not.toHaveBeenCalled();
    pipeline.removeEntity(second.id);
    expect(sourceTexture.destroy).toHaveBeenCalledOnce();

    releaseImageAsset(first.mediaSource.asset);
    releaseImageAsset(first.mediaSource.asset);
  });

  test("evicts least-recently-used offscreen sources when the byte budget is exceeded", () => {
    const first = createTestEntity({
      id: "unique-first",
      shaderParams: { showOriginal: true },
    });
    const second = createTestEntity({
      id: "unique-second",
      shaderParams: { showOriginal: true },
    });
    if (first.mediaSource.type !== "image" || second.mediaSource.type !== "image") {
      throw new Error("Expected image entities");
    }

    const firstTexture = createTexture(200, 150);
    const secondTexture = createTexture(200, 150);
    const onTextureEvicted = vi.fn<(entityIds: ReadonlySet<string>) => void>();
    const pipeline = new EntityTexturePipeline({
      device: createDevice([firstTexture, secondTexture]),
      colorConfig,
      texturePool: null,
      textureBudgetBytes: 200 * 150 * 4,
      onTextureEvicted,
    });
    const encoder = {} as GPUCommandEncoder;

    pipeline.renderEntityToTexture(first, encoder);
    pipeline.renderEntityToTexture(second, encoder);
    pipeline.endFrame();
    expect(pipeline.getResidencyStats().residentBytes).toBe(200 * 150 * 4 * 2);

    second.textureDirty = false;
    pipeline.renderEntityToTexture(second, encoder);
    pipeline.endFrame();

    expect(firstTexture.destroy).toHaveBeenCalledOnce();
    expect(secondTexture.destroy).not.toHaveBeenCalled();
    expect(pipeline.getResidencyStats()).toMatchObject({
      residentBytes: 200 * 150 * 4,
      sourceTextureCount: 1,
    });
    expect(onTextureEvicted).toHaveBeenCalledWith(new Set([first.id]));

    pipeline.removeEntity(first.id);
    pipeline.removeEntity(second.id);
    releaseImageAsset(first.mediaSource.asset);
    releaseImageAsset(second.mediaSource.asset);
  });

  test("pins a persistent composition texture against offscreen eviction", () => {
    const first = createTestEntity({ id: "pinned-first", shaderParams: { showOriginal: true } });
    const second = createTestEntity({ id: "pinned-second", shaderParams: { showOriginal: true } });
    const firstTexture = createTexture(200, 150);
    const secondTexture = createTexture(200, 150);
    const pipeline = new EntityTexturePipeline({
      device: createDevice([firstTexture, secondTexture]),
      colorConfig,
      texturePool: null,
      textureBudgetBytes: 200 * 150 * 4,
    });
    const encoder = {} as GPUCommandEncoder;

    pipeline.renderEntityToTexture(first, encoder);
    pipeline.renderEntityToTexture(second, encoder);
    pipeline.endFrame();
    expect(pipeline.pinCachedTexture(firstTexture)).toBe(true);
    pipeline.endFrame();

    expect(firstTexture.destroy).not.toHaveBeenCalled();
    expect(secondTexture.destroy).toHaveBeenCalledOnce();
    expect(pipeline.pinCachedTexture(secondTexture)).toBe(false);

    pipeline.destroy();
    if (first.mediaSource.type === "image") releaseImageAsset(first.mediaSource.asset);
    if (second.mediaSource.type === "image") releaseImageAsset(second.mediaSource.asset);
  });

  test("freezes LOD during viewport motion and bounds settled transitions per frame", () => {
    const entities = Array.from({ length: 5 }, (_, index) =>
      createTestEntity({
        id: `lod-${index}`,
        shaderParams: { showOriginal: true },
      }),
    );
    const textures = entities.map(() => createTexture(200, 150));
    const pipeline = new EntityTexturePipeline({
      device: createDevice(textures),
      colorConfig,
      texturePool: null,
    });
    const encoder = {} as GPUCommandEncoder;
    for (const entity of entities) pipeline.renderEntityToTexture(entity, encoder);

    pipeline.beginFrame(false);
    expect(pipeline.resolveRenderSize(entities[0]!, { width: 100, height: 75 })).toEqual({
      width: 200,
      height: 150,
    });
    expect(pipeline.hasPendingLodWork).toBe(true);

    pipeline.beginFrame(true);
    const resolved = entities.map((entity) =>
      pipeline.resolveRenderSize(entity, { width: 100, height: 75 }),
    );
    expect(resolved.slice(0, 4)).toEqual(
      Array.from({ length: 4 }, () => ({ width: 100, height: 75 })),
    );
    expect(resolved[4]).toEqual({ width: 200, height: 150 });
    expect(pipeline.hasPendingLodWork).toBe(true);

    for (const entity of entities) {
      pipeline.removeEntity(entity.id);
      if (entity.mediaSource.type === "image") releaseImageAsset(entity.mediaSource.asset);
    }
  });

  test("bounds cold visible source uploads during viewport motion", () => {
    const entities = Array.from(
      { length: config.rendering.lodTransitionsPerFrame + 1 },
      (_, index) =>
        createTestEntity({
          id: `cold-lod-${index}`,
          shaderParams: { showOriginal: true },
        }),
    );
    const pipeline = new EntityTexturePipeline({
      device: createDevice([]),
      colorConfig,
      texturePool: null,
    });

    pipeline.beginFrame(false);
    const resolved = entities.map((entity) =>
      pipeline.resolveRenderSize(entity, { width: 100, height: 75 }),
    );

    expect(resolved.slice(0, config.rendering.lodTransitionsPerFrame)).toEqual(
      Array.from({ length: config.rendering.lodTransitionsPerFrame }, () => ({
        width: 100,
        height: 75,
      })),
    );
    expect(resolved[config.rendering.lodTransitionsPerFrame]).toBeNull();
    expect(pipeline.hasPendingLodWork).toBe(true);

    for (const entity of entities) {
      if (entity.mediaSource.type === "image") releaseImageAsset(entity.mediaSource.asset);
    }
  });

  test("resolves a cold entity immediately when its desired source texture is resident", () => {
    const first = createTestEntity({
      id: "resident-first",
      shaderParams: { showOriginal: true },
    });
    if (first.mediaSource.type !== "image") throw new Error("Expected image entity");
    retainImageAsset(first.mediaSource.asset);
    const second: ShaderCanvasEntity = {
      ...first,
      id: "resident-second",
      mediaSource: { type: "image", asset: first.mediaSource.asset },
      textureDirty: true,
    };
    const pipeline = new EntityTexturePipeline({
      device: createDevice([createTexture(200, 150)]),
      colorConfig,
      texturePool: null,
    });

    pipeline.renderEntityToTexture(first, {} as GPUCommandEncoder);
    pipeline.beginFrame(false);
    const budgetFillers: ShaderCanvasEntity[] = [];
    for (let index = 0; index < config.rendering.lodTransitionsPerFrame; index++) {
      const filler = createTestEntity({
        id: `budget-filler-${index}`,
        shaderParams: { showOriginal: true },
      });
      budgetFillers.push(filler);
      expect(pipeline.resolveRenderSize(filler, { width: 100, height: 75 })).toEqual({
        width: 100,
        height: 75,
      });
    }

    expect(pipeline.resolveRenderSize(second, { width: 200, height: 150 })).toEqual({
      width: 200,
      height: 150,
    });

    pipeline.destroy();
    for (const filler of budgetFillers) {
      if (filler.mediaSource.type === "image") releaseImageAsset(filler.mediaSource.asset);
    }
    releaseImageAsset(first.mediaSource.asset);
    releaseImageAsset(first.mediaSource.asset);
  });

  test("reuses a retained image tier when zoom returns to a previous LOD", () => {
    const entity = createTestEntity({
      id: "lod-return",
      shaderParams: { showOriginal: true },
    });
    const detailTexture = createTexture(200, 150);
    const overviewTexture = createTexture(100, 75);
    const device = createDevice([detailTexture, overviewTexture]);
    const pipeline = new EntityTexturePipeline({
      device,
      colorConfig,
      texturePool: null,
    });
    const encoder = {} as GPUCommandEncoder;

    expect(pipeline.renderEntityToTexture(entity, encoder)).toEqual({
      kind: "texture",
      texture: detailTexture,
    });
    expect(pipeline.renderEntityToTexture(entity, encoder, { width: 100, height: 75 })).toEqual({
      kind: "texture",
      texture: overviewTexture,
    });
    expect(pipeline.renderEntityToTexture(entity, encoder)).toEqual({
      kind: "texture",
      texture: detailTexture,
    });

    expect(device.createTexture).toHaveBeenCalledTimes(2);
    expect(device.queue.copyExternalImageToTexture).toHaveBeenCalledTimes(2);
    expect(detailTexture.destroy).not.toHaveBeenCalled();

    pipeline.destroy();
    if (entity.mediaSource.type === "image") releaseImageAsset(entity.mediaSource.asset);
  });
});

function createTexture(width: number, height: number): GPUTexture {
  return {
    width,
    height,
    format: "rgba8unorm",
    createView: vi.fn<() => GPUTextureView>(() => ({}) as GPUTextureView),
    destroy: vi.fn<() => void>(),
  } as unknown as GPUTexture;
}

function createDevice(sourceTextures: GPUTexture[]): GPUDevice {
  const device = {
    queue: {
      copyExternalImageToTexture: vi.fn<GPUQueue["copyExternalImageToTexture"]>(),
    },
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createTexture: vi.fn<GPUDevice["createTexture"]>(() => {
      const texture = sourceTextures.shift();
      if (!texture) throw new Error("Test requested an unexpected texture allocation");
      return texture;
    }),
  };
  return device as unknown as GPUDevice;
}
