import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ShaderPass, type ShaderContext } from "#renderer/shaders/shader-pass.ts";
import type { EffectRenderEntity } from "#renderer/effect-render-entity.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("ShaderPass entity resource lifetime", () => {
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
    const entity = createTestEntity({ id: "shader-entity" });

    expect(pass.allocateUniforms(entity)).toBe(firstBuffer);
    expect(pass.allocateUniforms(entity)).toBe(firstBuffer);
    expect(createBufferMock).toHaveBeenCalledOnce();

    pass.removeEntity(entity.id);
    expect(firstBuffer.destroy).toHaveBeenCalledOnce();

    expect(pass.allocateUniforms(entity)).toBe(secondBuffer);
    expect(createBufferMock).toHaveBeenCalledTimes(2);
    pass.destroy();
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
