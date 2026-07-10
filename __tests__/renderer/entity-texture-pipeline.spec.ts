import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
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
    const device = createDevice(sourceTexture);
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

function createDevice(sourceTexture: GPUTexture): GPUDevice {
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
    createTexture: vi.fn<GPUDevice["createTexture"]>(() => sourceTexture),
  };
  return device as unknown as GPUDevice;
}
