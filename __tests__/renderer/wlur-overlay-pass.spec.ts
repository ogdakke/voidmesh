import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const wlurMocks = vi.hoisted(() => ({
  encode: vi.fn<(...args: unknown[]) => void>(),
  destroy: vi.fn<() => void>(),
}));

vi.mock("#wlur", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#wlur")>();
  return {
    ...actual,
    WlurPass: class {
      initialize(): void {}
      updateConfig(): void {}
      encode(...args: unknown[]): void {
        wlurMocks.encode(...args);
      }
      destroy(): void {
        wlurMocks.destroy();
      }
    },
  };
});

import { WlurOverlayPass } from "#renderer/wlur-overlay-pass.ts";

describe("WlurOverlayPass", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
    vi.stubGlobal("GPUTextureUsage", {
      TEXTURE_BINDING: 1,
      RENDER_ATTACHMENT: 2,
      COPY_SRC: 4,
    });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("samples a matching-format canvas without allocating or copying an input texture", () => {
    const outputTexture = createTexture();
    const device = createDevice(outputTexture);
    const pass = new WlurOverlayPass({
      device,
      canvasFormat: "rgba16float",
      intermediateFormat: "rgba16float",
    });
    pass.setConfig({ enabled: true, cache: true });
    const sourceTexture = createTexture();
    const encoder = {
      copyTextureToTexture: vi.fn<GPUCommandEncoder["copyTextureToTexture"]>(),
    } as unknown as GPUCommandEncoder;

    expect(
      pass.encode({
        encoder,
        sourceTexture,
        targetTexture: sourceTexture,
        targetView: {} as GPUTextureView,
        width: 3840,
        height: 2160,
        devicePixelRatio: 2,
        contentDirty: true,
      }),
    ).toBe(true);

    expect(device.createTexture).toHaveBeenCalledOnce();
    expect(wlurMocks.encode.mock.calls[0]!.slice(0, 5)).toEqual([
      encoder,
      sourceTexture,
      outputTexture,
      3840,
      2160,
    ]);
    expect(encoder.copyTextureToTexture).toHaveBeenCalledOnce();
    expect(encoder.copyTextureToTexture).toHaveBeenCalledWith(
      { texture: outputTexture },
      { texture: sourceTexture },
      { width: 3840, height: 2160 },
    );

    pass.destroy();
  });
});

function createDevice(outputTexture: GPUTexture): GPUDevice & {
  createTexture: ReturnType<typeof vi.fn<GPUDevice["createTexture"]>>;
} {
  return {
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createTexture: vi.fn<GPUDevice["createTexture"]>(() => outputTexture),
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
