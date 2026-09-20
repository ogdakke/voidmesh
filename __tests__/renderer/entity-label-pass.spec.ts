import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { scheduler } from "#lib/animation-scheduler.ts";
import { EntityLabelPass } from "#renderer/entity-label-pass.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

vi.mock("#lib/css.ts", () => ({
  getCssVarValue: () => "sans-serif",
  resolveCssColor: (value: string) => value,
  resolveCssVarColor: (value: string) => value,
}));

describe("EntityLabelPass", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 });
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
    }));
    vi.stubGlobal("OffscreenCanvas", createOffscreenCanvas());
  });

  afterAll(() => vi.unstubAllGlobals());

  test("skips unchanged per-label uniform uploads", () => {
    const device = createDevice();
    const labelPass = new EntityLabelPass(device, "rgba16float", {} as GPUBuffer);
    labelPass.initialize();
    const pass = createRenderPass();
    const entity = createTestEntity({ id: "label-1", name: "Label" });
    const viewport = { offset: { x: 0, y: 0 }, zoom: 1 };

    labelPass.beginFrame(viewport, 800, 600, false);
    labelPass.drawLabel(pass, entity, 0, 0);
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(device.queue.copyExternalImageToTexture).toHaveBeenCalledOnce();
    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      }),
    );

    labelPass.beginFrame(viewport, 800, 600, false);
    labelPass.drawLabel(pass, entity, 0, 0);
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(device.queue.copyExternalImageToTexture).toHaveBeenCalledOnce();

    labelPass.drawLabel(pass, entity, 4, 0);
    expect(device.queue.writeBuffer).toHaveBeenCalledTimes(2);

    labelPass.beginFrame(viewport, 800, 600, true);
    scheduler.tick(0);
    scheduler.tick(16);
    labelPass.beginFrame(viewport, 800, 600, true);
    labelPass.drawLabel(pass, entity, 0, 0);
    expect(device.queue.copyExternalImageToTexture).toHaveBeenCalledOnce();

    labelPass.destroy();
  });
});

function createOffscreenCanvas(): typeof OffscreenCanvas {
  const context = {
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    roundRect: () => {},
    fill: () => {},
    stroke: () => {},
    fillText: () => {},
    translate: () => {},
    scale: () => {},
    measureText: (text: string) => ({ width: text.length * 8 }),
  };
  return class MockOffscreenCanvas {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    getContext() {
      return context;
    }
  } as unknown as typeof OffscreenCanvas;
}

function createDevice(): GPUDevice {
  return {
    queue: {
      writeBuffer: vi.fn<GPUQueue["writeBuffer"]>(),
      copyExternalImageToTexture: vi.fn<GPUQueue["copyExternalImageToTexture"]>(),
    },
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createTexture: vi.fn<GPUDevice["createTexture"]>(
      () =>
        ({
          createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
          destroy: vi.fn<GPUTexture["destroy"]>(),
        }) as unknown as GPUTexture,
    ),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>(
      () =>
        ({
          destroy: vi.fn<GPUBuffer["destroy"]>(),
        }) as unknown as GPUBuffer,
    ),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice;
}

function createRenderPass(): GPURenderPassEncoder {
  return {
    setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
    setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
    draw: vi.fn<GPURenderPassEncoder["draw"]>(),
  } as unknown as GPURenderPassEncoder;
}
