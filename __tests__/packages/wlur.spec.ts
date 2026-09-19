import {
  DEFAULT_WLUR_PARAMS,
  WLUR_CURVES,
  WlurPass,
  clampWlurParams,
  clampWlurQuality,
  getWlurScratchKey,
  getWlurSourceDependencyRegion,
  getWlurWorkingDimensions,
  mapWlurFactorAtPoint,
  resolveWlurCurve,
  sampleWlurCurve,
} from "#wlur";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

describe("wlur helpers", () => {
  test("maps downward blur like Glur", () => {
    const params = {
      direction: "down" as const,
      offset: 0.75,
      interpolation: 0.25,
    };

    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.5 }, params)).toBe(0);
    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.875 }, params)).toBeCloseTo(0.5);
    expect(mapWlurFactorAtPoint({ x: 0.5, y: 1 }, params)).toBe(1);
  });

  test("maps upward and leftward blur using the upstream Glur formula", () => {
    const up = {
      direction: "up" as const,
      offset: 0.3,
      interpolation: 0.4,
    };
    const left = {
      direction: "left" as const,
      offset: 0.3,
      interpolation: 0.4,
    };

    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.3 }, up)).toBeCloseTo(0.5);
    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.1 }, up)).toBe(1);
    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.5 }, up)).toBe(0);
    expect(mapWlurFactorAtPoint({ x: 0.1, y: 0.5 }, left)).toBe(1);
    expect(mapWlurFactorAtPoint({ x: 0.3, y: 0.5 }, left)).toBeCloseTo(0.5);
  });

  test("clamps invalid params", () => {
    expect(
      clampWlurParams({
        radius: -1,
        offset: 4,
        interpolation: -3,
        noise: -2,
      }),
    ).toMatchObject({
      radius: 0,
      offset: 1,
      interpolation: 0,
      direction: "down",
      noise: 0,
    });
  });

  test("clamps tint color and amount", () => {
    expect(
      clampWlurParams({
        tint: {
          color: [-1, 0.5, 4],
          amount: -3,
        },
      }),
    ).toMatchObject({
      tint: {
        color: [0, 0.5, 1],
        amount: 0,
      },
    });
  });

  test("accepts numeric bezier tuples for base and tint curves", () => {
    expect(
      clampWlurParams({
        curve: [0.55, 0, 1, 0.45],
        mixCurve: [0.55, 0, 0.9, 0.32],
        tint: {
          color: [1, 1, 1],
          amount: 1,
          curve: [0.28, 0.78, 0.5, 1],
        },
      }),
    ).toMatchObject({
      curve: [0.55, 0, 1, 0.45],
      mixCurve: [0.55, 0, 0.9, 0.32],
      tint: {
        curve: [0.28, 0.78, 0.5, 1],
      },
    });
  });

  test("normalizes invalid curve tuples back to the default linear curve", () => {
    expect(resolveWlurCurve([NaN, 0, 1, 1])).toEqual(WLUR_CURVES.linear);
  });

  test("samples CSS-compatible curve presets with different falloff shapes", () => {
    expect(sampleWlurCurve(WLUR_CURVES.linear, 0.5)).toBeCloseTo(0.5, 2);
    expect(sampleWlurCurve(WLUR_CURVES.overlayQuickFade, 0.5)).toBeLessThan(0.5);
    expect(sampleWlurCurve(WLUR_CURVES.overlayEdgeHold, 0.5)).toBeGreaterThan(0.5);
  });

  test("normalizes quality", () => {
    expect(clampWlurQuality({ kernelSize: 48, resolutionScale: 10 })).toMatchObject({
      kernelSize: 49,
      resolutionScale: 1,
    });
  });

  test("returns working dimensions and cache key for scaled passes", () => {
    expect(getWlurWorkingDimensions(1200, 800, 0.5)).toEqual({
      width: 600,
      height: 400,
      scale: 0.5,
    });
    expect(getWlurScratchKey(1200, 800, 0.5)).toBe("1200x800-600x400");
  });

  test("bounds the full-resolution source pixels that can affect Wlur", () => {
    expect(
      getWlurSourceDependencyRegion(
        800,
        600,
        { ...DEFAULT_WLUR_PARAMS, direction: "down", offset: 0.58 },
        { kernelSize: 45, resolutionScale: 0.5 },
      ),
    ).toEqual({ x: 0, y: 300, width: 800, height: 300 });
  });
});

describe("WlurPass resource reuse", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1 });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2, COPY_DST: 4 });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("reuses stable texture views and bind groups between encodes", () => {
    const device = createWlurDevice();
    const pass = new WlurPass({
      device,
      format: "rgba16float",
      quality: { resolutionScale: 0.5 },
    });
    const encoder = createWlurEncoder();
    const input = createWlurTexture(800, 600);
    const firstOutput = createWlurTexture(800, 600);
    const secondOutput = createWlurTexture(800, 600);
    const params = { ...DEFAULT_WLUR_PARAMS, radius: 20, noise: 0 };
    const beginRenderPass = vi.mocked(encoder.beginRenderPass);

    pass.encode(encoder, input, firstOutput, 800, 600, params);
    expect(device.createBindGroup).toHaveBeenCalledTimes(3);
    expect(beginRenderPass).toHaveBeenCalledTimes(3);
    const renderPass = beginRenderPass.mock.results[0]!.value as GPURenderPassEncoder;
    expect(renderPass.setScissorRect).toHaveBeenNthCalledWith(1, 0, 58, 400, 242);
    expect(renderPass.setScissorRect).toHaveBeenNthCalledWith(2, 0, 89, 400, 211);
    expect(pass.getStats()).toEqual({ blurPixels: 181_200, fullBlurPixels: 240_000 });

    pass.encode(encoder, input, firstOutput, 800, 600, params, { refreshBlur: false });
    expect(beginRenderPass).toHaveBeenCalledTimes(4);
    expect(pass.getStats()).toEqual({ blurPixels: 181_200, fullBlurPixels: 240_000 });

    pass.encode(encoder, input, firstOutput, 800, 600, params);
    expect(device.createBindGroup).toHaveBeenCalledTimes(3);
    expect(beginRenderPass).toHaveBeenCalledTimes(7);
    expect(input.createView).toHaveBeenCalledOnce();
    expect(firstOutput.createView).toHaveBeenCalledOnce();

    pass.encode(encoder, input, secondOutput, 800, 600, params);
    expect(device.createBindGroup).toHaveBeenCalledTimes(3);
    expect(secondOutput.createView).toHaveBeenCalledOnce();

    const nextInput = createWlurTexture(800, 600);
    pass.encode(encoder, nextInput, secondOutput, 800, 600, params);
    expect(device.createBindGroup).toHaveBeenCalledTimes(5);

    pass.encode(encoder, input, firstOutput, 800, 600, params);
    expect(device.createBindGroup).toHaveBeenCalledTimes(6);

    pass.destroy();
  });

  test("renders the final composite into a caller-owned output view", () => {
    const device = createWlurDevice();
    const pass = new WlurPass({ device, format: "rgba16float" });
    const encoder = createWlurEncoder();
    const input = createWlurTexture(800, 600);
    const output = createWlurTexture(800, 600);
    const outputView = {} as GPUTextureView;

    pass.encode(
      encoder,
      input,
      output,
      800,
      600,
      { ...DEFAULT_WLUR_PARAMS, radius: 20, noise: 0 },
      { outputView },
    );

    expect(output.createView).not.toHaveBeenCalled();
    const renderPasses = vi.mocked(encoder.beginRenderPass).mock.calls;
    expect(renderPasses.at(-1)?.[0].colorAttachments[0]?.view).toBe(outputView);

    pass.destroy();
  });
});

function createWlurTexture(
  width: number,
  height: number,
): GPUTexture & { createView: ReturnType<typeof vi.fn<GPUTexture["createView"]>> } {
  return {
    width,
    height,
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
    destroy: vi.fn<GPUTexture["destroy"]>(),
  } as unknown as GPUTexture & {
    createView: ReturnType<typeof vi.fn<GPUTexture["createView"]>>;
  };
}

function createWlurDevice(): GPUDevice & {
  createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
} {
  return {
    queue: {
      writeBuffer: vi.fn<GPUQueue["writeBuffer"]>(),
      writeTexture: vi.fn<GPUQueue["writeTexture"]>(),
    },
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createTexture: vi.fn<GPUDevice["createTexture"]>((descriptor) => {
      const [width, height] = descriptor.size as [number, number];
      return createWlurTexture(width, height);
    }),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>(
      () => ({ destroy: vi.fn<GPUBuffer["destroy"]>() }) as unknown as GPUBuffer,
    ),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice & {
    createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
  };
}

function createWlurEncoder(): GPUCommandEncoder {
  const renderPass = {
    setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
    setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
    setScissorRect: vi.fn<GPURenderPassEncoder["setScissorRect"]>(),
    draw: vi.fn<GPURenderPassEncoder["draw"]>(),
    end: vi.fn<GPURenderPassEncoder["end"]>(),
  } as unknown as GPURenderPassEncoder;
  return {
    beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(() => renderPass),
  } as unknown as GPUCommandEncoder;
}
