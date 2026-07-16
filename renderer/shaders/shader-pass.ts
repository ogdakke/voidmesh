import type { RGBA } from "#types/canvas.ts";
import { ColorSpace } from "#types/enums.ts";
import { sortPaletteByLuminance } from "#lib/color-utils.ts";
import type { TexturePool } from "../texture-pool.ts";
import type { EffectRenderEntity, EffectShaderSettings } from "../effect-render-entity.ts";

export interface ShaderContext {
  device: GPUDevice;
  /** Pre-allocated ArrayBuffer for the 304-byte uniform layout */
  uniformData: ArrayBuffer;
  floatView: Float32Array;
  uintView: Uint32Array;
  /** Default sampler (linear, clamp-to-edge) */
  sampler: GPUSampler;
  /** Mutable palette sorting cache (shared to avoid per-frame re-sorting) */
  sortedPaletteCache: { original: readonly RGBA[]; reversed: boolean; sorted: RGBA[] } | null;
  /** Texture pool for intermediate textures (used by compute shaders) */
  texturePool: TexturePool | null;
  /** Release scratch after its final encoded use; later ordered passes may reuse it. */
  releaseTexture: (
    texture: GPUTexture,
    width: number,
    height: number,
    usage: GPUTextureUsageFlags,
  ) => void;
  /** Intermediate texture format for the rendering pipeline */
  intermediateFormat: GPUTextureFormat;
  /** Whether the GPU is rendering in Display P3 color space */
  supportsP3: boolean;
  /** Whether WGSL `var<immediate>` and pass.setImmediates are available. */
  supportsImmediates: boolean;
}

export interface ExternalTextureSource {
  texture: GPUExternalTexture;
}

function assertExternalTextureRewrite(source: string, rewritten: string, label: string): string {
  if (rewritten === source || !rewritten.includes("texture_external")) {
    throw new Error(`Failed to rewrite ${label} shader source for external texture input.`);
  }
  return rewritten;
}

export function createExternalTextureShaderSource(source: string): string {
  const rewritten = source
    .replace(
      /@group\(0\)\s+@binding\(1\)\s+var\s+sourceTexture\s*:\s*texture_2d<f32>;/,
      "@group(0) @binding(1) var sourceTexture: texture_external;",
    )
    .replace(
      /fn\s+loadAtUV\s*\(\s*([A-Za-z_]\w*)\s*:\s*vec2f\s*\)\s*->\s*vec4f\s*\{[^{}]*textureLoad\s*\(\s*sourceTexture\s*,[^)]*,\s*0\s*\)\s*;?\s*\}/,
      "fn loadAtUV($1: vec2f) -> vec4f {\n  return textureSampleBaseClampToEdge(sourceTexture, sourceSampler, clamp($1, vec2f(0.0), vec2f(1.0)));\n}",
    )
    .replace(
      /textureSampleLevel\(sourceTexture,\s*sourceSampler,\s*([^,]+),\s*0\.0\)/g,
      "textureSampleBaseClampToEdge(sourceTexture, sourceSampler, $1)",
    )
    .replace(
      /textureSample\(sourceTexture,\s*sourceSampler,/g,
      "textureSampleBaseClampToEdge(sourceTexture, sourceSampler,",
    );

  return assertExternalTextureRewrite(source, rewritten, "entity effect");
}

export abstract class ShaderPass {
  protected pipeline: GPURenderPipeline | null = null;
  protected bindGroupLayout: GPUBindGroupLayout | null = null;
  protected externalPipeline: GPURenderPipeline | null = null;
  protected externalBindGroupLayout: GPUBindGroupLayout | null = null;
  #textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();
  #uniformBuffers: GPUBuffer[] = [];
  #uniformBufferCursor = 0;

  constructor(protected readonly ctx: ShaderContext) {}

  protected get uniformBufferSize(): number {
    return this.ctx.uniformData.byteLength;
  }

  beginFrame(): void {
    this.#uniformBufferCursor = 0;
  }

  /** Whether this shader needs re-rendering every frame for the given entity (e.g., time-based animation). */
  needsContinuousRender(_entity: EffectShaderSettings): boolean {
    return false;
  }

  /** Return the WGSL source string */
  abstract getShaderSource(): string;

  /**
   * Write shader-variant uniform at offset 7 (byte 28) and any other per-shader overrides.
   * Called after common uniforms are written.
   */
  abstract writeVariantUniforms(entity: EffectRenderEntity): void;

  /** Async initialization. Default creates pipeline. Override for async resources like ASCII atlas. */
  async initialize(): Promise<void> {
    this.bindGroupLayout = this.createBindGroupLayout();
    this.pipeline = this.createPipeline();
    this.externalBindGroupLayout = this.createExternalBindGroupLayout();
    this.externalPipeline = this.createExternalPipeline();
  }

  /**
   * Write the common portion of the 304-byte uniform buffer, then call writeVariantUniforms().
   *
   * Replicates the exact logic from canvas-renderer.ts #updateShaderUniforms (lines 2159-2247).
   */
  writeUniforms(entity: EffectRenderEntity): void {
    const params = entity.shaderParams;
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const f = this.ctx.floatView;
    const u = this.ctx.uintView;

    // Base uniforms (first 32 bytes / 8 values)
    f[0] = width;
    f[1] = height;
    f[2] = params.scale;
    f[3] = params.intensity;
    f[4] = params.size * entity.pixelScale;
    u[5] = params.shape === "circle" ? 0 : params.shape === "square" ? 1 : 2;
    u[6] = params.preserveColors ? 1 : 0;

    // Offset 7 is handled by subclass
    this.writeVariantUniforms(entity);

    // Color space flag (offset 40 / u[10])
    u[10] = this.ctx.supportsP3 ? 1 : 0;

    // Palette metadata starts at byte 32; vec4 colors start at byte 48.
    const palette = params.palette;
    if (palette && palette.colors.length >= 2) {
      let sortedColors: RGBA[];
      const reversed = !!params.reversePalette;
      if (
        this.ctx.sortedPaletteCache?.original === palette.colors &&
        this.ctx.sortedPaletteCache.reversed === reversed
      ) {
        sortedColors = this.ctx.sortedPaletteCache.sorted;
      } else {
        const colors = reversed ? [...palette.colors].reverse() : palette.colors;
        const [background, ...rest] = colors;
        const sortedRest = sortPaletteByLuminance(
          rest,
          this.ctx.supportsP3 ? ColorSpace.displayP3 : ColorSpace.srgb,
        );
        sortedColors = [background!, ...sortedRest];
        this.ctx.sortedPaletteCache = {
          original: palette.colors,
          reversed,
          sorted: sortedColors,
        };
      }

      u[8] = sortedColors.length;
      u[9] = params.ascii?.invert ? 1 : 0;

      const paletteStart = 12;
      for (let i = 0; i < sortedColors.length && i < 16; i++) {
        const color = sortedColors[i]!;
        const offset = paletteStart + i * 4;
        f[offset] = color[0];
        f[offset + 1] = color[1];
        f[offset + 2] = color[2];
        f[offset + 3] = color[3];
      }
    } else {
      u[8] = 2;
      u[9] = params.ascii?.invert ? 1 : 0;

      const paletteStart = 12;
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

  protected createExternalBindGroupLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: `${this.constructor.name} external bind group layout`,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
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

  protected createExternalPipeline(): GPURenderPipeline {
    const shaderModule = this.ctx.device.createShaderModule({
      label: `${this.constructor.name} external shader`,
      code: createExternalTextureShaderSource(this.getShaderSource()),
    });

    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: `${this.constructor.name} external pipeline layout`,
      bindGroupLayouts: [this.externalBindGroupLayout!],
    });

    return this.ctx.device.createRenderPipeline({
      label: `${this.constructor.name} external pipeline`,
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

  #getUniformBuffer(): GPUBuffer {
    const slot = this.#uniformBufferCursor++;
    const cached = this.#uniformBuffers[slot];
    if (cached) return cached;

    const buffer = this.ctx.device.createBuffer({
      label: `${this.constructor.name} uniforms slot ${slot}`,
      size: this.uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#uniformBuffers.push(buffer);
    return buffer;
  }

  protected writeEntityUniformBuffer(entity: EffectRenderEntity): GPUBuffer {
    this.writeUniforms(entity);
    const uniformBuffer = this.#getUniformBuffer();
    this.ctx.device.queue.writeBuffer(
      uniformBuffer,
      0,
      this.ctx.uniformData,
      0,
      this.uniformBufferSize,
    );
    return uniformBuffer;
  }

  /** Create bind group for a source texture. Override for extra bindings (ASCII). */
  createBindGroup(sourceTextureView: GPUTextureView, uniformBuffer: GPUBuffer): GPUBindGroup {
    return this.ctx.device.createBindGroup({
      label: `${this.constructor.name} bind group`,
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sourceTextureView },
        { binding: 2, resource: this.ctx.sampler },
      ],
    });
  }

  createExternalBindGroup(source: ExternalTextureSource, uniformBuffer: GPUBuffer): GPUBindGroup {
    return this.ctx.device.createBindGroup({
      label: `${this.constructor.name} external bind group`,
      layout: this.externalBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: source.texture },
        { binding: 2, resource: this.ctx.sampler },
      ],
    });
  }

  protected getTextureView(texture: GPUTexture): GPUTextureView {
    const cached = this.#textureViewCache.get(texture);
    if (cached) return cached;

    const view = texture.createView();
    this.#textureViewCache.set(texture, view);
    return view;
  }

  protected getBindGroup(sourceTexture: GPUTexture, uniformBuffer: GPUBuffer): GPUBindGroup {
    return this.createBindGroup(this.getTextureView(sourceTexture), uniformBuffer);
  }

  /**
   * Execute this shader pass: write uniforms, create bind group, encode render pass.
   * When an encoder is provided, encodes into it without submitting.
   * When omitted, creates an encoder and submits immediately.
   * Override for compute shaders (DitheringShader) or error handling (AsciiShader).
   */
  execute(
    entity: EffectRenderEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (!this.pipeline) return;

    const uniformBuffer = this.writeEntityUniformBuffer(entity);
    const bindGroup = this.getBindGroup(sourceTexture, uniformBuffer);

    const pass = encoder.beginRenderPass({
      label: `${this.constructor.name} render pass`,
      colorAttachments: [
        {
          view: this.getTextureView(outputTexture),
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
  }

  executeExternal(
    entity: EffectRenderEntity,
    source: ExternalTextureSource,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (!this.externalPipeline) return;

    const uniformBuffer = this.writeEntityUniformBuffer(entity);
    const bindGroup = this.createExternalBindGroup(source, uniformBuffer);

    const pass = encoder.beginRenderPass({
      label: `${this.constructor.name} external render pass`,
      colorAttachments: [
        {
          view: this.getTextureView(outputTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.externalPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /** Release specialized per-entity resources in subclasses. */
  removeEntity(_entityId: string): void {}

  /** Cleanup GPU resources. Override to clean up additional resources. */
  destroy(): void {
    for (const buffer of this.#uniformBuffers) buffer.destroy();
    this.#uniformBuffers.length = 0;
    this.#uniformBufferCursor = 0;
    // Pipeline and bind group layout don't need explicit destruction
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.externalPipeline = null;
    this.externalBindGroupLayout = null;
  }
}
