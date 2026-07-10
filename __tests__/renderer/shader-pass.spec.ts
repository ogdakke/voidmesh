import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { DitheringShader } from "#renderer/shaders/dithering-shader.ts";
import { ShaderPass, type ShaderContext } from "#renderer/shaders/shader-pass.ts";
import type { EffectRenderEntity } from "#renderer/effect-render-entity.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("ShaderPass", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test("destroys a removed entity's cached uniform buffer", () => {
    const firstBuffer = createBuffer();
    const secondBuffer = createBuffer();
    const createBufferMock = vi
      .fn<GPUDevice["createBuffer"]>()
      .mockReturnValueOnce(firstBuffer)
      .mockReturnValueOnce(secondBuffer);
    const pass = new TestShaderPass(createContext(createBufferMock));
    const entity = createRenderEntity("shader-entity", 1);

    expect(pass.allocateUniforms(entity)).toBe(firstBuffer);
    expect(pass.allocateUniforms(entity)).toBe(firstBuffer);
    expect(createBufferMock).toHaveBeenCalledOnce();

    pass.removeEntity(entity.id);
    expect(firstBuffer.destroy).toHaveBeenCalledOnce();

    expect(pass.allocateUniforms(entity)).toBe(secondBuffer);
    expect(createBufferMock).toHaveBeenCalledTimes(2);
    pass.destroy();
  });

  test("scales pixel-space uniforms without changing dimensionless shader scale", () => {
    const context = createContext(vi.fn<GPUDevice["createBuffer"]>());
    const pass = new TestShaderPass(context);
    const entity = createRenderEntity("lod-uniforms", 0.25);
    entity.shaderParams.size = 40;
    entity.shaderParams.scale = 2;

    pass.write(entity);

    expect(context.floatView[2]).toBe(2);
    expect(context.floatView[4]).toBe(10);
  });

  test("scales dithering's pixel-period scale with the render texture", () => {
    const context = createContext(vi.fn<GPUDevice["createBuffer"]>());
    const pass = new DitheringShader(context);
    const entity = createRenderEntity("lod-dithering", 0.25);
    entity.shaderParams.size = 40;
    entity.shaderParams.scale = 2;

    pass.writeUniforms(entity);

    expect(context.floatView[2]).toBe(0.5);
    expect(context.floatView[4]).toBe(10);
  });
});

class TestShaderPass extends ShaderPass {
  override getShaderSource(): string {
    return "";
  }

  override writeVariantUniforms(): void {}

  allocateUniforms(entity: EffectRenderEntity): GPUBuffer {
    return this.writeEntityUniformBuffer(entity);
  }

  write(entity: EffectRenderEntity): void {
    this.writeUniforms(entity);
  }
}

function createRenderEntity(id: string, pixelScale: number): EffectRenderEntity {
  const entity = createTestEntity({ id });
  return {
    id: entity.id,
    originalSize: entity.originalSize,
    pixelScale,
    shaderType: entity.shaderType,
    shaderParams: entity.shaderParams,
  };
}

function createBuffer(): GPUBuffer {
  return { destroy: vi.fn<() => void>() } as unknown as GPUBuffer;
}

function createContext(createBuffer: GPUDevice["createBuffer"]): ShaderContext {
  const uniformData = new ArrayBuffer(336);
  return {
    device: {
      createBuffer,
      queue: { writeBuffer: vi.fn<GPUQueue["writeBuffer"]>() },
    } as unknown as GPUDevice,
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
