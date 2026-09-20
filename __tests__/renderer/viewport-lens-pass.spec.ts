import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ViewportLensPass } from "#renderer/viewport-lens-pass.ts";

describe("ViewportLensPass", () => {
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

  test("skips unchanged lens uniform uploads", () => {
    const device = createDevice();
    const lens = new ViewportLensPass({
      device,
      format: "rgba16float",
      initialConfig: {
        enabled: true,
        strength: 0.1,
        radius: 0.7,
        falloff: 0.2,
        dispersion: 0.03,
        scale: 1,
        reflectionIntensity: 0.1,
        reflectionFocus: 0.5,
        occlusion: 0.2,
        vignetteLight: 0.1,
        vignetteDark: 0.2,
      },
    });
    const encoder = createEncoder();
    const targetView = {} as GPUTextureView;

    expect(lens.encode(encoder, targetView, 800, 600)).toBe(true);
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();

    expect(lens.encode(encoder, targetView, 800, 600)).toBe(true);
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();

    lens.setColorScheme(true);
    expect(lens.encode(encoder, targetView, 800, 600)).toBe(true);
    expect(device.queue.writeBuffer).toHaveBeenCalledTimes(2);

    lens.destroy();
  });
});

function createDevice(): GPUDevice {
  return {
    queue: { writeBuffer: vi.fn<GPUQueue["writeBuffer"]>() },
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>(
      () =>
        ({
          destroy: vi.fn<GPUBuffer["destroy"]>(),
        }) as unknown as GPUBuffer,
    ),
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createTexture: vi.fn<GPUDevice["createTexture"]>((descriptor) => {
      const [width, height] = descriptor.size as [number, number];
      return {
        width,
        height,
        createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
        destroy: vi.fn<GPUTexture["destroy"]>(),
      } as unknown as GPUTexture;
    }),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice;
}

function createEncoder(): GPUCommandEncoder {
  const pass = {
    setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
    setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
    draw: vi.fn<GPURenderPassEncoder["draw"]>(),
    end: vi.fn<GPURenderPassEncoder["end"]>(),
  } as unknown as GPURenderPassEncoder;
  return {
    beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(() => pass),
  } as unknown as GPUCommandEncoder;
}
