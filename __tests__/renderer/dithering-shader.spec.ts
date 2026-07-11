import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { config } from "#config";
import { DitheringKind, ShaderType, type ShaderParams } from "#types/canvas.ts";
import { DitheringShader } from "#renderer/shaders/dithering-shader.ts";
import type { ShaderContext } from "#renderer/shaders/shader-pass.ts";
import type { EffectRenderEntity } from "#renderer/effect-render-entity.ts";

describe("DitheringShader error diffusion buffers", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1, VERTEX: 2, COMPUTE: 4 });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 });
    vi.stubGlobal("GPUTextureUsage", {
      TEXTURE_BINDING: 1,
      STORAGE_BINDING: 2,
      COPY_SRC: 4,
    });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("evicts old error-diffusion buffers when the cache exceeds its byte budget", async () => {
    const buffers: Array<GPUBuffer & { label?: string }> = [];
    const device = createDevice(buffers);
    const shader = new DitheringShader(createShaderContext(device));
    await shader.initialize();

    shader.execute(
      createEntity("first", 4096, 4096),
      createTexture(),
      createTexture(),
      createEncoder(),
    );
    const firstErrorBuffer = buffers.find((buffer) => buffer.label === "Error buffer first");
    expect(firstErrorBuffer?.destroy).not.toHaveBeenCalled();

    shader.execute(
      createEntity("second", 4096, 4096),
      createTexture(),
      createTexture(),
      createEncoder(),
    );

    const secondErrorBuffer = buffers.find((buffer) => buffer.label === "Error buffer second");
    expect(firstErrorBuffer?.destroy).toHaveBeenCalledOnce();
    expect(secondErrorBuffer?.destroy).not.toHaveBeenCalled();

    shader.destroy();
  });
});

function createEntity(id: string, width: number, height: number): EffectRenderEntity {
  const shaderParams = structuredClone(config.defaults.shaderParams) as ShaderParams;
  shaderParams.dithering = { kind: DitheringKind.floydSteinberg };
  return {
    id,
    originalSize: { width, height },
    pixelScale: 1,
    shaderType: ShaderType.dithering,
    shaderParams,
  };
}

function createShaderContext(device: GPUDevice): ShaderContext {
  const uniformData = new ArrayBuffer(config.rendering.ditheringUniformSize);
  return {
    device,
    uniformData,
    floatView: new Float32Array(uniformData),
    uintView: new Uint32Array(uniformData),
    sampler: {} as GPUSampler,
    sortedPaletteCache: null,
    texturePool: null,
    releaseTexture: vi.fn<ShaderContext["releaseTexture"]>(),
    intermediateFormat: "rgba16float",
    supportsP3: false,
    supportsImmediates: false,
  };
}

function createDevice(buffers: Array<GPUBuffer & { label?: string }>): GPUDevice {
  return {
    queue: {
      writeBuffer: vi.fn<GPUQueue["writeBuffer"]>(),
    },
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createComputePipelineAsync: vi.fn<GPUDevice["createComputePipelineAsync"]>(
      async () => ({}) as GPUComputePipeline,
    ),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(
      () =>
        ({
          getCompilationInfo: vi.fn<GPUShaderModule["getCompilationInfo"]>(
            async () => ({ messages: [] }) as unknown as GPUCompilationInfo,
          ),
        }) as unknown as GPUShaderModule,
    ),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>((descriptor) => {
      const buffer = {
        label: descriptor.label,
        destroy: vi.fn<() => void>(),
      } as unknown as GPUBuffer & { label?: string };
      buffers.push(buffer);
      return buffer;
    }),
    createTexture: vi.fn<GPUDevice["createTexture"]>(() => createTexture()),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice;
}

function createTexture(): GPUTexture {
  return {
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
  } as unknown as GPUTexture;
}

function createEncoder(): GPUCommandEncoder {
  return {
    clearBuffer: vi.fn<GPUCommandEncoder["clearBuffer"]>(),
    beginComputePass: vi.fn<GPUCommandEncoder["beginComputePass"]>(
      () =>
        ({
          setPipeline: vi.fn<GPUComputePassEncoder["setPipeline"]>(),
          setBindGroup: vi.fn<GPUComputePassEncoder["setBindGroup"]>(),
          dispatchWorkgroups: vi.fn<GPUComputePassEncoder["dispatchWorkgroups"]>(),
          end: vi.fn<GPUComputePassEncoder["end"]>(),
        }) as unknown as GPUComputePassEncoder,
    ),
    copyTextureToTexture: vi.fn<GPUCommandEncoder["copyTextureToTexture"]>(),
  } as unknown as GPUCommandEncoder;
}
