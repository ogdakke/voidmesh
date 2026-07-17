import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ActionLayerBlurPass } from "#renderer/action-layer-blur-pass.ts";
import type { ProcessingPipeline } from "#renderer/processing-pipeline.ts";

describe("ActionLayerBlurPass", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2 });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("samples the bindable scene texture without a full-resolution copy", () => {
    const outputTexture = createTexture();
    const renderPass = {
      setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
      setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
      draw: vi.fn<GPURenderPassEncoder["draw"]>(),
      end: vi.fn<GPURenderPassEncoder["end"]>(),
    } as unknown as GPURenderPassEncoder;
    const encoder = {
      copyTextureToTexture: vi.fn<GPUCommandEncoder["copyTextureToTexture"]>(),
      beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(() => renderPass),
    } as unknown as GPUCommandEncoder;
    const device = createDevice(outputTexture);
    const pass = new ActionLayerBlurPass({
      device,
      canvasFormat: "rgba16float",
      intermediateFormat: "rgba16float",
      tintColor: [0, 0, 0],
    });
    const sourceTexture = createTexture();
    const processingPipeline = {
      encodeFullScreenBlur: vi.fn<ProcessingPipeline["encodeFullScreenBlur"]>(),
    } as unknown as ProcessingPipeline;
    const options = {
      encoder,
      processingPipeline,
      sourceTexture,
      targetView: {} as GPUTextureView,
      width: 3840,
      height: 2160,
      blurIntensity: 1,
      contentDirty: true,
    };

    pass.encode(options);
    expect(encoder.copyTextureToTexture).not.toHaveBeenCalled();
    expect(processingPipeline.encodeFullScreenBlur).toHaveBeenCalledWith(
      encoder,
      sourceTexture,
      outputTexture,
      3840,
      2160,
    );
    expect(device.createTexture).toHaveBeenCalledOnce();

    options.contentDirty = false;
    pass.encode(options);
    expect(processingPipeline.encodeFullScreenBlur).toHaveBeenCalledOnce();

    pass.destroy();
    expect(outputTexture.destroy).toHaveBeenCalledOnce();
  });
});

function createDevice(outputTexture: GPUTexture): GPUDevice & {
  createTexture: ReturnType<typeof vi.fn<GPUDevice["createTexture"]>>;
} {
  return {
    queue: { writeBuffer: vi.fn<GPUQueue["writeBuffer"]>() },
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>(
      () => ({ destroy: vi.fn<GPUBuffer["destroy"]>() }) as unknown as GPUBuffer,
    ),
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createTexture: vi.fn<GPUDevice["createTexture"]>(() => outputTexture),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice & {
    createTexture: ReturnType<typeof vi.fn<GPUDevice["createTexture"]>>;
  };
}

function createTexture(): GPUTexture {
  return {
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
    destroy: vi.fn<GPUTexture["destroy"]>(),
  } as unknown as GPUTexture;
}
