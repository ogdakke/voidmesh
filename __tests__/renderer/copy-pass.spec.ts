import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { CopyPass } from "#renderer/copy-pass.ts";

describe("CopyPass", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("reuses source bindings and texture views", () => {
    const renderPass = {
      setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
      setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
      draw: vi.fn<GPURenderPassEncoder["draw"]>(),
      end: vi.fn<GPURenderPassEncoder["end"]>(),
    } as unknown as GPURenderPassEncoder;
    const encoder = {
      beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(() => renderPass),
    } as unknown as GPUCommandEncoder;
    const device = createDevice();
    const pass = new CopyPass(device, "rgba16float");
    const source = createTexture();
    const firstDestination = createTexture();
    const secondDestination = createTexture();

    pass.encode(encoder, source, firstDestination);
    pass.encode(encoder, source, firstDestination);
    pass.encode(encoder, source, secondDestination);

    expect(device.createBindGroup).toHaveBeenCalledOnce();
    expect(source.createView).toHaveBeenCalledOnce();
    expect(firstDestination.createView).toHaveBeenCalledOnce();
    expect(secondDestination.createView).toHaveBeenCalledOnce();

    pass.encode(encoder, createTexture(), secondDestination);
    expect(device.createBindGroup).toHaveBeenCalledTimes(2);
  });
});

function createDevice(): GPUDevice & {
  createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
} {
  return {
    queue: { submit: vi.fn<GPUQueue["submit"]>() },
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice & {
    createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
  };
}

function createTexture(): GPUTexture & {
  createView: ReturnType<typeof vi.fn<GPUTexture["createView"]>>;
} {
  return {
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
  } as unknown as GPUTexture & {
    createView: ReturnType<typeof vi.fn<GPUTexture["createView"]>>;
  };
}
