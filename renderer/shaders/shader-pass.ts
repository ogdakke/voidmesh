import type { RGBA, ShaderCanvasEntity } from "#types/canvas.ts";
import { ColorSpace } from "#types/enums.ts";
import { sortPaletteByLuminance } from "#lib/color-utils.ts";
import type { TexturePool } from "../texture-pool.ts";

export interface ShaderContext {
  device: GPUDevice;
  /** Shared 336-byte uniform buffer for entity shaders */
  uniformBuffer: GPUBuffer;
  /** Pre-allocated ArrayBuffer for the 336-byte uniform layout */
  uniformData: ArrayBuffer;
  floatView: Float32Array;
  uintView: Uint32Array;
  /** Default sampler (linear, clamp-to-edge) */
  sampler: GPUSampler;
  /** Mutable palette sorting cache (shared to avoid per-frame re-sorting) */
  sortedPaletteCache: { original: readonly RGBA[]; sorted: RGBA[] } | null;
  /** Texture pool for intermediate textures (used by compute shaders) */
  texturePool: TexturePool | null;
  /** Intermediate texture format for the rendering pipeline */
  intermediateFormat: GPUTextureFormat;
  /** Whether the GPU is rendering in Display P3 color space */
  supportsP3: boolean;
}

export abstract class ShaderPass {
  protected pipeline: GPURenderPipeline | null = null;
  protected bindGroupLayout: GPUBindGroupLayout | null = null;

  constructor(protected readonly ctx: ShaderContext) {}

  /** Whether this shader needs re-rendering every frame for the given entity (e.g., time-based animation). */
  needsContinuousRender(_entity: ShaderCanvasEntity): boolean {
    return false;
  }

  /** Return the WGSL source string */
  abstract getShaderSource(): string;

  /**
   * Write shader-variant uniform at offset 7 (byte 28) and any other per-shader overrides.
   * Called after common uniforms are written.
   */
  abstract writeVariantUniforms(entity: ShaderCanvasEntity): void;

  /** Async initialization. Default creates pipeline. Override for async resources like ASCII atlas. */
  async initialize(): Promise<void> {
    this.bindGroupLayout = this.createBindGroupLayout();
    this.pipeline = this.createPipeline();
  }

  /**
   * Write the common portion of the 336-byte uniform buffer, then call writeVariantUniforms().
   *
   * Replicates the exact logic from canvas-renderer.ts #updateShaderUniforms (lines 2159-2247).
   */
  writeUniforms(entity: ShaderCanvasEntity): void {
    const params = entity.shaderParams;
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const f = this.ctx.floatView;
    const u = this.ctx.uintView;

    // Base uniforms (first 64 bytes / 16 floats)
    f[0] = width;
    f[1] = height;
    f[2] = params.scale;
    f[3] = params.intensity;
    f[4] = params.size;
    u[5] = params.shape === "circle" ? 0 : params.shape === "square" ? 1 : 2;
    u[6] = params.preserveColors ? 1 : 0;

    // Offset 7 is handled by subclass
    this.writeVariantUniforms(entity);

    // Legacy color/background fields
    f[8] = params.color[0];
    f[9] = params.color[1];
    f[10] = params.color[2];
    f[11] = params.color[3];
    f[12] = params.background[0];
    f[13] = params.background[1];
    f[14] = params.background[2];
    f[15] = params.background[3];

    // Color space flag (offset 72 / u[18])
    u[18] = this.ctx.supportsP3 ? 1 : 0;

    // Palette data (offset 64 bytes / 16 floats)
    const palette = params.palette;
    if (palette && palette.colors.length >= 2) {
      let sortedColors: RGBA[];
      if (this.ctx.sortedPaletteCache?.original === palette.colors) {
        sortedColors = this.ctx.sortedPaletteCache.sorted;
      } else {
        const [background, ...rest] = palette.colors;
        const sortedRest = sortPaletteByLuminance(
          rest,
          this.ctx.supportsP3 ? ColorSpace.displayP3 : ColorSpace.srgb,
        );
        sortedColors = [background!, ...sortedRest];
        this.ctx.sortedPaletteCache = {
          original: palette.colors,
          sorted: sortedColors,
        };
      }

      u[16] = sortedColors.length;
      u[17] = params.ascii?.invert ? 1 : 0;

      const paletteStart = 20;
      for (let i = 0; i < sortedColors.length && i < 16; i++) {
        const color = sortedColors[i]!;
        const offset = paletteStart + i * 4;
        f[offset] = color[0];
        f[offset + 1] = color[1];
        f[offset + 2] = color[2];
        f[offset + 3] = color[3];
      }
    } else {
      u[16] = 2;
      u[17] = params.ascii?.invert ? 1 : 0;

      const paletteStart = 20;
      f[paletteStart] = params.background[0];
      f[paletteStart + 1] = params.background[1];
      f[paletteStart + 2] = params.background[2];
      f[paletteStart + 3] = params.background[3];
      f[paletteStart + 4] = params.color[0];
      f[paletteStart + 5] = params.color[1];
      f[paletteStart + 6] = params.color[2];
      f[paletteStart + 7] = params.color[3];
    }
  }

  /** Create bind group layout. Default: 3 bindings (uniform, texture, sampler). Override for more. */
  protected createBindGroupLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: `${this.constructor.name} bind group layout`,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });
  }

  /** Create render pipeline from shader source and layout */
  protected createPipeline(): GPURenderPipeline {
    const shaderModule = this.ctx.device.createShaderModule({
      label: `${this.constructor.name} shader`,
      code: this.getShaderSource(),
    });

    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: `${this.constructor.name} pipeline layout`,
      bindGroupLayouts: [this.bindGroupLayout!],
    });

    return this.ctx.device.createRenderPipeline({
      label: `${this.constructor.name} pipeline`,
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.ctx.intermediateFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  /** Create bind group for a source texture. Override for extra bindings (ASCII). */
  createBindGroup(sourceTextureView: GPUTextureView): GPUBindGroup {
    return this.ctx.device.createBindGroup({
      label: `${this.constructor.name} bind group`,
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.ctx.uniformBuffer } },
        { binding: 1, resource: sourceTextureView },
        { binding: 2, resource: this.ctx.sampler },
      ],
    });
  }

  /**
   * Execute this shader pass: write uniforms, create bind group, submit render pass.
   * Override for compute shaders (DitheringShader) or error handling (AsciiShader).
   */
  execute(entity: ShaderCanvasEntity, sourceTexture: GPUTexture, outputTexture: GPUTexture): void {
    if (!this.pipeline) return;

    this.writeUniforms(entity);
    this.ctx.device.queue.writeBuffer(this.ctx.uniformBuffer, 0, this.ctx.uniformData);

    const bindGroup = this.createBindGroup(sourceTexture.createView());

    const encoder = this.ctx.device.createCommandEncoder({
      label: `${this.constructor.name} encoder`,
    });

    const pass = encoder.beginRenderPass({
      label: `${this.constructor.name} render pass`,
      colorAttachments: [
        {
          view: outputTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    this.ctx.device.queue.submit([encoder.finish()]);
  }

  /** Cleanup GPU resources. Override to clean up additional resources. */
  destroy(): void {
    // Pipeline and bind group layout don't need explicit destruction
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}
