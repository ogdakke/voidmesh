import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { config } from "#config";
import { DitheringShader } from "#renderer/shaders/dithering-shader.ts";
import { arrangeRisoPalette, HalftoneShader } from "#renderer/shaders/halftone-shader.ts";
import { PrintKind, ShaderType } from "#types/canvas.ts";
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

  test("reuses peak per-frame uniform buffer slots across entity identities", () => {
    const firstBuffer = createBuffer();
    const secondBuffer = createBuffer();
    const createBufferMock = vi
      .fn<GPUDevice["createBuffer"]>()
      .mockReturnValueOnce(firstBuffer)
      .mockReturnValueOnce(secondBuffer);
    const pass = new TestShaderPass(createContext(createBufferMock));
    const firstEntity = createRenderEntity("shader-entity-first", 1);
    const secondEntity = createRenderEntity("shader-entity-second", 1);
    const laterEntity = createRenderEntity("shader-entity-later", 1);

    pass.beginFrame();
    expect(pass.allocateUniforms(firstEntity)).toBe(firstBuffer);
    expect(pass.allocateUniforms(secondEntity)).toBe(secondBuffer);
    expect(createBufferMock).toHaveBeenCalledTimes(2);
    expect(createBufferMock.mock.calls[0]![0].size).toBe(304);

    pass.beginFrame();
    expect(pass.allocateUniforms(laterEntity)).toBe(firstBuffer);
    expect(createBufferMock).toHaveBeenCalledTimes(2);
    pass.removeEntity(firstEntity.id);
    expect(firstBuffer.destroy).not.toHaveBeenCalled();

    pass.destroy();
    expect(firstBuffer.destroy).toHaveBeenCalledOnce();
    expect(secondBuffer.destroy).toHaveBeenCalledOnce();
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

  test("print packs kind, angle and print knobs after palette metadata", () => {
    const context = createContext(vi.fn<GPUDevice["createBuffer"]>());
    const pass = new HalftoneShader(context);
    const entity = createRenderEntity("print", 0.5);
    entity.shaderType = ShaderType.print;
    entity.shaderParams.scale = 2;
    entity.shaderParams.print = {
      kind: PrintKind.cmyk,
      angle: 30,
      dotGain: 1,
      paper: 0.5,
      misregistration: 0,
    };

    pass.writeUniforms(entity);

    expect(context.floatView[7]).toBe(30);
    expect(context.uintView[9]).toBe(2);
    expect(context.uintView[11]).toBe(255 | (128 << 8));
    // Print hides scale; the slot carries pixel scale for LOD-stable paper texture.
    expect(context.floatView[2]).toBe(0.5);
  });

  test("halftone keeps scale and writes kind 0 even with stale print params", () => {
    const context = createContext(vi.fn<GPUDevice["createBuffer"]>());
    const pass = new HalftoneShader(context);
    const entity = createRenderEntity("halftone-classic", 0.5);
    entity.shaderType = ShaderType.halftone;
    entity.shaderParams.scale = 2;
    entity.shaderParams.print = { ...config.defaults.shaderParams.print, kind: PrintKind.riso };

    pass.writeUniforms(entity);

    expect(context.uintView[9]).toBe(0);
    expect(context.floatView[2]).toBe(2);
  });

  test("writes fallback palette metadata immediately after the base uniforms", () => {
    const context = createContext(vi.fn<GPUDevice["createBuffer"]>());
    const pass = new TestShaderPass(context);
    const entity = createRenderEntity("compact-palette", 1);
    entity.shaderParams.palette = undefined;

    pass.write(entity);

    expect(context.uniformData.byteLength).toBe(304);
    expect(context.uintView[8]).toBe(2);
    expect(context.uintView[9]).toBe(entity.shaderParams.ascii?.invert ? 1 : 0);
    expect(context.uintView[10]).toBe(0);
    for (let index = 0; index < 4; index++) {
      expect(context.floatView[12 + index]).toBeCloseTo(entity.shaderParams.background[index]!);
      expect(context.floatView[16 + index]).toBeCloseTo(entity.shaderParams.color[index]!);
    }
  });

  test("supports shader-specific uniform buffer and upload sizes", () => {
    const buffer = createBuffer();
    const createBufferMock = vi.fn<GPUDevice["createBuffer"]>(() => buffer);
    const context = createContext(createBufferMock);
    const pass = new CompactTestShaderPass(context);
    const entity = createRenderEntity("compact-shader", 1);

    expect(pass.allocateUniforms(entity)).toBe(buffer);
    expect(createBufferMock.mock.calls[0]![0].size).toBe(48);
    expect(context.device.queue.writeBuffer).toHaveBeenCalledWith(
      buffer,
      0,
      context.uniformData,
      0,
      48,
    );

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

  write(entity: EffectRenderEntity): void {
    this.writeUniforms(entity);
  }
}

class CompactTestShaderPass extends TestShaderPass {
  protected override get uniformBufferSize(): number {
    return 48;
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
  const uniformData = new ArrayBuffer(config.rendering.ditheringUniformSize);
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

describe("arrangeRisoPalette", () => {
  const pack = (colors: number[][]) => {
    const f = new Float32Array(64);
    colors.forEach((c, i) => f.set([...c, 1], i * 4));
    return f;
  };
  const colorAt = (f: Float32Array, i: number) => Array.from(f.slice(i * 4, i * 4 + 3));

  test("uses the lightest colour as paper even when the palette starts dark", () => {
    const f = pack([
      [0, 0, 0],
      [1, 1, 1],
    ]);
    expect(arrangeRisoPalette(f, 2)).toBe(2);
    expect(colorAt(f, 0)).toEqual([1, 1, 1]);
    expect(colorAt(f, 1)).toEqual([0, 0, 0]);
  });

  test("keeps at most three inks, preferring distinct ones over near duplicates", () => {
    const f = pack([
      [0.05, 0.05, 0.1],
      [0.06, 0.05, 0.1],
      [1, 0.2, 0.3],
      [0.95, 0.95, 0.9],
      [0.1, 0.6, 0.55],
    ]);
    expect(arrangeRisoPalette(f, 5)).toBe(4);
    expect(colorAt(f, 0)).toEqual([0.95, 0.95, 0.9].map(Math.fround));
    const inks = [1, 2, 3].map((i) => colorAt(f, i)[0]);
    expect(inks).toContain(Math.fround(1));
    expect(inks).toContain(Math.fround(0.1));
  });
});
