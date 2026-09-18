import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

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

  beforeEach(() => vi.clearAllMocks());

  test("renders into a stable scene target and presents directly to a matching-format drawable", () => {
    const sceneTexture = createTexture();
    const device = createDevice(sceneTexture);
    const pass = new WlurOverlayPass({
      device,
      canvasFormat: "rgba16float",
      intermediateFormat: "rgba16float",
    });
    pass.setConfig({ enabled: true, cache: true });
    const sceneTarget = pass.getSceneTarget(3840, 2160, 2);
    const targetTexture = createTexture();
    const targetView = {} as GPUTextureView;
    const encoder = {
      copyTextureToTexture: vi.fn<GPUCommandEncoder["copyTextureToTexture"]>(),
    } as unknown as GPUCommandEncoder;

    expect(sceneTarget).not.toBeNull();
    expect(
      pass.encode({
        encoder,
        sourceTexture: sceneTarget!.texture,
        targetTexture,
        targetView,
        width: 3840,
        height: 2160,
        devicePixelRatio: 2,
        contentDirty: true,
      }),
    ).toBe(true);

    expect(device.createTexture).toHaveBeenCalledOnce();
    expect(wlurMocks.encode).toHaveBeenCalledWith(
      encoder,
      sceneTexture,
      targetTexture,
      3840,
      2160,
      expect.any(Object),
      { outputView: targetView },
    );
    expect(encoder.copyTextureToTexture).not.toHaveBeenCalled();
    expect(pass.getStats()).toEqual({
      blurRefreshes: 1,
      blurReuses: 0,
      composites: 1,
      directPresents: 1,
      convertedPresents: 0,
    });

    pass.destroy();
  });

  test("keeps explicit format conversion when the canvas format differs", () => {
    const inputTexture = createTexture();
    const outputTexture = createTexture();
    const device = createDevice(inputTexture, outputTexture);
    const pass = new WlurOverlayPass({
      device,
      canvasFormat: "bgra8unorm",
      intermediateFormat: "rgba16float",
    });
    pass.setConfig({ enabled: true, cache: true });
    const encoder = createEncoder();
    const sourceTexture = createTexture();
    const targetTexture = createTexture();
    const targetView = {} as GPUTextureView;

    expect(pass.getSceneTarget(1200, 800, 2)).toBeNull();
    expect(
      pass.encode({
        encoder,
        sourceTexture,
        targetTexture,
        targetView,
        width: 1200,
        height: 800,
        devicePixelRatio: 2,
        contentDirty: true,
      }),
    ).toBe(true);

    expect(wlurMocks.encode).toHaveBeenCalledWith(
      encoder,
      inputTexture,
      outputTexture,
      1200,
      800,
      expect.any(Object),
      {},
    );
    expect(encoder.beginRenderPass).toHaveBeenCalledTimes(2);
    expect(pass.getStats()).toMatchObject({ convertedPresents: 1, directPresents: 0 });

    pass.destroy();
  });
});

function createDevice(...textures: GPUTexture[]): GPUDevice & {
  createTexture: ReturnType<typeof vi.fn<GPUDevice["createTexture"]>>;
} {
  let textureIndex = 0;
  return {
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
    createTexture: vi.fn<GPUDevice["createTexture"]>(() => textures[textureIndex++]!),
  } as unknown as GPUDevice & {
    createTexture: ReturnType<typeof vi.fn<GPUDevice["createTexture"]>>;
  };
}

function createEncoder(): GPUCommandEncoder & {
  beginRenderPass: ReturnType<typeof vi.fn<GPUCommandEncoder["beginRenderPass"]>>;
} {
  const renderPass = {
    setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
    setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
    draw: vi.fn<GPURenderPassEncoder["draw"]>(),
    end: vi.fn<GPURenderPassEncoder["end"]>(),
  } as unknown as GPURenderPassEncoder;
  return {
    beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(() => renderPass),
  } as unknown as GPUCommandEncoder & {
    beginRenderPass: ReturnType<typeof vi.fn<GPUCommandEncoder["beginRenderPass"]>>;
  };
}

function createTexture(): GPUTexture {
  return {
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
    destroy: vi.fn<GPUTexture["destroy"]>(),
  } as unknown as GPUTexture;
}
