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

  test("reuses a dedicated blur pyramid while the backdrop stays unchanged", () => {
    const mipTextures = Array.from({ length: 7 }, createTexture);
    const downsampleMipChain = mipTextures.slice(0, 4);
    const upsampleMipChain = mipTextures.slice(4);
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
    const device = createDevice(mipTextures);
    const pass = new ActionLayerBlurPass({
      device,
      canvasFormat: "rgba16float",
      intermediateFormat: "rgba16float",
      tintColor: [0, 0, 0],
    });
    expect(pass.sourceDependencyPaddingPx).toBe(196);
    const sourceTexture = createTexture();
    const processingPipeline = {
      encodeFullScreenBlurPyramid: vi.fn<ProcessingPipeline["encodeFullScreenBlurPyramid"]>(
        (_encoder, _source, _width, _height, downsample, upsample, refreshRegion) => ({
          texture: upsample[0] ?? downsample[0]!,
          updatedPixels: refreshRegion ? 100 : 200,
          fullPixels: 200,
          partial: refreshRegion !== undefined,
        }),
      ),
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
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(encoder.copyTextureToTexture).not.toHaveBeenCalled();
    expect(processingPipeline.encodeFullScreenBlurPyramid).toHaveBeenCalledWith(
      encoder,
      sourceTexture,
      3840,
      2160,
      downsampleMipChain,
      upsampleMipChain,
      undefined,
    );
    expect(encoder.beginRenderPass).toHaveBeenCalledOnce();
    expect(pass.getStats()).toEqual({
      composites: 1,
      pyramidRefreshes: 1,
      partialPyramidRefreshes: 0,
      pyramidReuses: 0,
      blurPixels: 200,
      fullBlurPixels: 200,
      residentBytes: 43_804_800,
    });

    options.contentDirty = false;
    pass.encode(options);
    pass.encode(options);
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(processingPipeline.encodeFullScreenBlurPyramid).toHaveBeenCalledOnce();
    expect(encoder.beginRenderPass).toHaveBeenCalledTimes(3);
    expect(pass.getStats()).toEqual({
      composites: 3,
      pyramidRefreshes: 1,
      partialPyramidRefreshes: 0,
      pyramidReuses: 2,
      blurPixels: 200,
      fullBlurPixels: 200,
      residentBytes: 43_804_800,
    });

    options.contentDirty = true;
    const refreshRegion = { x: 100, y: 200, width: 300, height: 400 };
    Object.assign(options, { refreshRegion });
    pass.encode(options);
    expect(processingPipeline.encodeFullScreenBlurPyramid).toHaveBeenCalledTimes(2);
    expect(processingPipeline.encodeFullScreenBlurPyramid).toHaveBeenLastCalledWith(
      encoder,
      sourceTexture,
      3840,
      2160,
      downsampleMipChain,
      upsampleMipChain,
      refreshRegion,
    );
    expect(pass.getStats()).toEqual({
      composites: 4,
      pyramidRefreshes: 2,
      partialPyramidRefreshes: 1,
      pyramidReuses: 2,
      blurPixels: 300,
      fullBlurPixels: 400,
      residentBytes: 43_804_800,
    });
    expect(device.createTexture).toHaveBeenCalledTimes(7);

    pass.destroy();
    for (const texture of mipTextures) expect(texture.destroy).toHaveBeenCalledOnce();
  });
});

function createDevice(mipTextures: GPUTexture[]): GPUDevice & {
  createTexture: ReturnType<typeof vi.fn<GPUDevice["createTexture"]>>;
} {
  let textureIndex = 0;
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
    createTexture: vi.fn<GPUDevice["createTexture"]>(() => mipTextures[textureIndex++]!),
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
