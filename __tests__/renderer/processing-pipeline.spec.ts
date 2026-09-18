import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ProcessingPipeline } from "#renderer/processing-pipeline.ts";
import type { EffectRenderEntity } from "#renderer/effect-render-entity.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("ProcessingPipeline LOD parameters", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
    vi.stubGlobal("GPUTextureUsage", {
      TEXTURE_BINDING: 1,
      RENDER_ATTACHMENT: 2,
      COPY_SRC: 4,
    });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("skips blur when its scaled radius is below one render-texture subpixel", () => {
    const pipeline = new ProcessingPipeline({} as GPUDevice, "rgba16float", false);
    const entity = createRenderEntity(1);
    const adjustments = entity.shaderParams.adjustments;
    if (!adjustments) throw new Error("Expected default adjustments");
    adjustments.blur = 0.002;

    expect(pipeline.needsBlur(entity)).toBe(true);

    entity.pixelScale = 0.25;
    expect(pipeline.needsBlur(entity)).toBe(false);
  });

  test("reuses every stable full-screen blur bind group", () => {
    const device = createProcessingDevice();
    const pipeline = new ProcessingPipeline(device, "rgba16float", false);
    pipeline.initialize();
    const encoder = createProcessingEncoder();
    const input = createProcessingTexture(800, 600);
    const output = createProcessingTexture(800, 600);

    pipeline.encodeFullScreenBlur(encoder, input, output, 800, 600);
    const initialBindGroups = device.createBindGroup.mock.calls.length;
    expect(initialBindGroups).toBeGreaterThan(1);

    pipeline.encodeFullScreenBlur(encoder, input, output, 800, 600);
    expect(device.createBindGroup).toHaveBeenCalledTimes(initialBindGroups);

    pipeline.encodeFullScreenBlur(encoder, createProcessingTexture(800, 600), output, 800, 600);
    expect(device.createBindGroup).toHaveBeenCalledTimes(initialBindGroups + 1);
    expect(output.createView).toHaveBeenCalledOnce();

    pipeline.destroy();
  });
});

function createRenderEntity(pixelScale: number): EffectRenderEntity {
  const entity = createTestEntity({ id: "lod-processing" });
  return {
    id: entity.id,
    originalSize: entity.originalSize,
    pixelScale,
    shaderType: entity.shaderType,
    shaderParams: entity.shaderParams,
  };
}

function createProcessingTexture(
  width: number,
  height: number,
): GPUTexture & { createView: ReturnType<typeof vi.fn<GPUTexture["createView"]>> } {
  return {
    width,
    height,
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
    destroy: vi.fn<GPUTexture["destroy"]>(),
  } as unknown as GPUTexture & {
    createView: ReturnType<typeof vi.fn<GPUTexture["createView"]>>;
  };
}

function createProcessingDevice(): GPUDevice & {
  createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
} {
  return {
    queue: { writeBuffer: vi.fn<GPUQueue["writeBuffer"]>() },
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>(
      () => ({ destroy: vi.fn<GPUBuffer["destroy"]>() }) as unknown as GPUBuffer,
    ),
    createTexture: vi.fn<GPUDevice["createTexture"]>((descriptor) => {
      const [width, height] = descriptor.size as [number, number];
      return createProcessingTexture(width, height);
    }),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice & {
    createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
  };
}

function createProcessingEncoder(): GPUCommandEncoder {
  const renderPass = {
    setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
    setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
    setViewport: vi.fn<GPURenderPassEncoder["setViewport"]>(),
    draw: vi.fn<GPURenderPassEncoder["draw"]>(),
    end: vi.fn<GPURenderPassEncoder["end"]>(),
  } as unknown as GPURenderPassEncoder;
  return {
    beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(() => renderPass),
  } as unknown as GPUCommandEncoder;
}
