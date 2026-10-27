import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WlurInvalidationDebugPass } from "#renderer/wlur-invalidation-debug-pass.ts";

describe("WlurInvalidationDebugPass", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
    vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("draws valid bounds as one instanced overlay pass", () => {
    const renderPass = {
      setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
      setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
      draw: vi.fn<GPURenderPassEncoder["draw"]>(),
      end: vi.fn<GPURenderPassEncoder["end"]>(),
    } as unknown as GPURenderPassEncoder;
    const encoder = {
      beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(() => renderPass),
    } as unknown as GPUCommandEncoder;
    const buffer = { destroy: vi.fn<GPUBuffer["destroy"]>() } as unknown as GPUBuffer;
    const writeBuffer = vi.fn<GPUQueue["writeBuffer"]>();
    const device = {
      queue: { writeBuffer },
      createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
        () => ({}) as GPUBindGroupLayout,
      ),
      createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
      createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(
        () => ({}) as GPUPipelineLayout,
      ),
      createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(
        () => ({}) as GPURenderPipeline,
      ),
      createBuffer: vi.fn<GPUDevice["createBuffer"]>(() => buffer),
      createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
    } as unknown as GPUDevice;
    const pass = new WlurInvalidationDebugPass(device, "rgba16float", {} as GPUBuffer);

    pass.beginFrame();
    pass.addBounds({ x: 1, y: 2, width: 30, height: 40 }, [0, 1, 1, 0.9]);
    pass.addBounds({ x: 0, y: 0, width: 0, height: 10 }, [1, 0, 0, 1]);
    pass.encode(encoder, {} as GPUTextureView);

    expect(writeBuffer).toHaveBeenCalledOnce();
    expect(renderPass.draw).toHaveBeenCalledWith(6, 1);
    expect(renderPass.end).toHaveBeenCalledOnce();

    pass.destroy();
    expect(buffer.destroy).toHaveBeenCalledOnce();
  });
});
