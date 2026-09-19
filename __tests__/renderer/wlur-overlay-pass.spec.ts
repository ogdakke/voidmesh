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
      getStats(): { blurPixels: number; fullBlurPixels: number } {
        return { blurPixels: 12, fullBlurPixels: 24 };
      }
      encode(...args: unknown[]): void {
        wlurMocks.encode(...args);
      }
      destroy(): void {
        wlurMocks.destroy();
      }
    },
  };
});

import {
  WLUR_BLUR_DIRTY_AUXILIARY,
  WLUR_BLUR_DIRTY_CALLOUT,
  WLUR_BLUR_DIRTY_LENS,
  WlurOverlayPass,
} from "#renderer/wlur-overlay-pass.ts";

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
        blurDirtyMask: 1,
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
      { outputView: targetView, refreshBlur: true },
    );
    expect(encoder.copyTextureToTexture).not.toHaveBeenCalled();
    expect(pass.getStats()).toEqual({
      blurRefreshes: 1,
      blurReuses: 0,
      composites: 1,
      directPresents: 1,
      convertedPresents: 0,
      blurPixels: 12,
      fullBlurPixels: 24,
      globalInvalidations: 1,
      animatedInvalidations: 0,
      actionInvalidations: 0,
      dragInvalidations: 0,
      auxiliaryInvalidations: 0,
      lensInvalidations: 0,
      disintegrationInvalidations: 0,
      labelInvalidations: 0,
      calloutInvalidations: 0,
      selectionInvalidations: 0,
      cacheInvalidations: 0,
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
        blurDirtyMask: 1,
      }),
    ).toBe(true);

    expect(wlurMocks.encode).toHaveBeenCalledWith(
      encoder,
      inputTexture,
      outputTexture,
      1200,
      800,
      expect.any(Object),
      { refreshBlur: true },
    );
    expect(encoder.beginRenderPass).toHaveBeenCalledTimes(2);
    expect(pass.getStats()).toMatchObject({ convertedPresents: 1, directPresents: 0 });

    pass.destroy();
  });

  test("reuses the blur texture while compositing a changed source", () => {
    const sceneTexture = createTexture();
    const device = createDevice(sceneTexture);
    const pass = new WlurOverlayPass({
      device,
      canvasFormat: "rgba16float",
      intermediateFormat: "rgba16float",
    });
    pass.setConfig({ enabled: true, cache: true });
    const sceneTarget = pass.getSceneTarget(1200, 800, 2)!;
    const encoder = createEncoder();
    const targetTexture = createTexture();
    const targetView = {} as GPUTextureView;

    pass.encode({
      encoder,
      sourceTexture: sceneTarget.texture,
      targetTexture,
      targetView,
      width: 1200,
      height: 800,
      devicePixelRatio: 2,
      contentDirty: true,
      blurDirtyMask: 1,
    });
    pass.encode({
      encoder,
      sourceTexture: sceneTarget.texture,
      targetTexture,
      targetView,
      width: 1200,
      height: 800,
      devicePixelRatio: 2,
      contentDirty: true,
      blurDirtyMask: 0,
    });

    expect(wlurMocks.encode).toHaveBeenLastCalledWith(
      encoder,
      sceneTexture,
      targetTexture,
      1200,
      800,
      expect.any(Object),
      { outputView: targetView, refreshBlur: false },
    );
    expect(pass.getStats()).toMatchObject({
      blurRefreshes: 1,
      blurReuses: 1,
      composites: 2,
    });

    pass.destroy();
  });

  test("attributes auxiliary invalidations to their concrete sources", () => {
    const sceneTexture = createTexture();
    const pass = new WlurOverlayPass({
      device: createDevice(sceneTexture),
      canvasFormat: "rgba16float",
      intermediateFormat: "rgba16float",
    });
    pass.setConfig({ enabled: true, cache: true });
    const sceneTarget = pass.getSceneTarget(1200, 800, 2)!;

    pass.encode({
      encoder: createEncoder(),
      sourceTexture: sceneTarget.texture,
      targetTexture: createTexture(),
      targetView: {} as GPUTextureView,
      width: 1200,
      height: 800,
      devicePixelRatio: 2,
      contentDirty: true,
      blurDirtyMask: WLUR_BLUR_DIRTY_AUXILIARY | WLUR_BLUR_DIRTY_LENS | WLUR_BLUR_DIRTY_CALLOUT,
    });

    expect(pass.getStats()).toMatchObject({
      auxiliaryInvalidations: 1,
      lensInvalidations: 1,
      calloutInvalidations: 1,
      disintegrationInvalidations: 0,
      labelInvalidations: 0,
      selectionInvalidations: 0,
    });

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
