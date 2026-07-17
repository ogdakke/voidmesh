import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { GridPass } from "#renderer/grid-pass.ts";

describe("GridPass", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("reuses unchanged grid uniforms while still encoding the draw", () => {
    const writeBuffer = vi.fn<GPUQueue["writeBuffer"]>();
    const renderPass = {
      setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
      setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
      draw: vi.fn<GPURenderPassEncoder["draw"]>(),
      end: vi.fn<GPURenderPassEncoder["end"]>(),
    } as unknown as GPURenderPassEncoder;
    const encoder = {
      beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(() => renderPass),
    } as unknown as GPUCommandEncoder;
    const device = {
      queue: { writeBuffer },
      createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
      createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
        () => ({}) as GPUBindGroupLayout,
      ),
      createBuffer: vi.fn<GPUDevice["createBuffer"]>(
        () => ({ destroy: vi.fn<GPUBuffer["destroy"]>() }) as unknown as GPUBuffer,
      ),
      createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
      createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(
        () => ({}) as GPUPipelineLayout,
      ),
      createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(
        () => ({}) as GPURenderPipeline,
      ),
    } as unknown as GPUDevice;
    const grid = new GridPass(device, "bgra8unorm");
    const viewport = { offset: { x: 10, y: 20 }, zoom: 0.5 };
    const options = {
      encoder,
      targetView: {} as GPUTextureView,
      viewport,
      width: 1920,
      height: 1080,
    };

    grid.encode(options);
    grid.encode(options);
    expect(writeBuffer).toHaveBeenCalledOnce();
    expect(encoder.beginRenderPass).toHaveBeenCalledTimes(2);

    viewport.zoom = 0.6;
    grid.encode(options);
    grid.setConfig({ dotSize: 2 });
    grid.encode(options);
    expect(writeBuffer).toHaveBeenCalledTimes(3);

    grid.destroy();
  });
});
