import { DitheringKind, isErrorDiffusion } from "#types/canvas.ts";
import type { EffectRenderEntity } from "../effect-render-entity.ts";
import ditheringComputeShaderSource from "../dithering-compute.wgsl?raw";
import ditheringShaderSource from "../dithering.wgsl?raw";
import { type ExternalTextureSource, ShaderPass } from "./shader-pass.ts";

// Map DitheringKind to uniform index
const DITHERING_KIND_INDEX: Record<DitheringKind, number> = {
  [DitheringKind.bayer2x2]: 0,
  [DitheringKind.bayer4x4]: 1,
  [DitheringKind.bayer8x8]: 2,
  [DitheringKind.whiteNoise]: 3,
  [DitheringKind.blueNoise]: 4,
  // Error diffusion algorithms (will use compute shader, but mapped for completeness)
  [DitheringKind.floydSteinberg]: 5,
  [DitheringKind.atkinson]: 6,
  [DitheringKind.jarvisJudiceNinke]: 7,
  [DitheringKind.stucki]: 8,
  [DitheringKind.burkes]: 9,
  [DitheringKind.sierra]: 10,
  [DitheringKind.sierraLite]: 11,
};

function createExternalComputeShaderSource(source: string): string {
  const rewritten = source
    .replace(
      /@group\(0\)\s+@binding\(1\)\s+var\s+inputTexture\s*:\s*texture_2d<f32>;/,
      "@group(0) @binding(1) var inputTexture: texture_external;",
    )
    .replace(/textureLoad\(inputTexture,\s*([^,]+),\s*0\)/g, "textureLoad(inputTexture, $1)");

  if (rewritten === source || !rewritten.includes("texture_external")) {
    throw new Error(
      "Failed to rewrite dithering compute shader source for external texture input.",
    );
  }
  return rewritten;
}

export class DitheringShader extends ShaderPass {
  // Compute pipeline for error diffusion
  #computePipeline: GPUComputePipeline | null = null;
  #externalComputePipeline: GPUComputePipeline | null = null;
  #computeBindGroupLayout: GPUBindGroupLayout | null = null;
  #externalComputeBindGroupLayout: GPUBindGroupLayout | null = null;
  // Error buffer cache per entity (keyed by entityId-width-height)
  #errorBufferCache: Map<string, GPUBuffer> = new Map();

  override getShaderSource(): string {
    return ditheringShaderSource;
  }

  override writeVariantUniforms(entity: EffectRenderEntity): void {
    const ditheringKind = entity.shaderParams.dithering?.kind ?? DitheringKind.bayer4x4;
    this.ctx.uintView[7] = DITHERING_KIND_INDEX[ditheringKind];
  }

  override async initialize(): Promise<void> {
    // Fragment pipeline (ordered dithering) - from base class
    this.bindGroupLayout = this.createBindGroupLayout();
    this.pipeline = this.createPipeline();
    this.externalBindGroupLayout = this.createExternalBindGroupLayout();
    this.externalPipeline = this.createExternalPipeline();

    // Compute pipeline (error diffusion dithering)
    await this.#createComputePipeline();
  }

  async #createComputePipeline(): Promise<void> {
    const device = this.ctx.device;

    this.#computeBindGroupLayout = device.createBindGroupLayout({
      label: "Dithering compute bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: this.ctx.intermediateFormat },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });

    this.#externalComputeBindGroupLayout = device.createBindGroupLayout({
      label: "Dithering external compute bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          externalTexture: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: this.ctx.intermediateFormat },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });

    const shaderModule = device.createShaderModule({
      label: "Dithering compute shader",
      code: ditheringComputeShaderSource,
    });
    const externalShaderModule = device.createShaderModule({
      label: "Dithering external compute shader",
      code: createExternalComputeShaderSource(ditheringComputeShaderSource),
    });

    const compilationInfo = await shaderModule.getCompilationInfo();
    const errors = compilationInfo.messages.filter((m) => m.type === "error");
    if (errors.length > 0) {
      const errorMessages = errors.map((e) => `Line ${e.lineNum}: ${e.message}`).join("\n");
      throw new Error(`Dithering compute shader compilation failed:\n${errorMessages}`);
    }
    const externalCompilationInfo = await externalShaderModule.getCompilationInfo();
    const externalErrors = externalCompilationInfo.messages.filter((m) => m.type === "error");
    if (externalErrors.length > 0) {
      const errorMessages = externalErrors.map((e) => `Line ${e.lineNum}: ${e.message}`).join("\n");
      throw new Error(`Dithering external compute shader compilation failed:\n${errorMessages}`);
    }

    const pipelineLayout = device.createPipelineLayout({
      label: "Dithering compute pipeline layout",
      bindGroupLayouts: [this.#computeBindGroupLayout],
    });
    const externalPipelineLayout = device.createPipelineLayout({
      label: "Dithering external compute pipeline layout",
      bindGroupLayouts: [this.#externalComputeBindGroupLayout],
    });

    try {
      this.#computePipeline = await device.createComputePipelineAsync({
        label: "Dithering compute pipeline",
        layout: pipelineLayout,
        compute: {
          module: shaderModule,
          entryPoint: "main",
        },
      });
      this.#externalComputePipeline = await device.createComputePipelineAsync({
        label: "Dithering external compute pipeline",
        layout: externalPipelineLayout,
        compute: {
          module: externalShaderModule,
          entryPoint: "main",
        },
      });
    } catch (error) {
      throw new Error(
        `Failed to create dithering compute pipeline: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #getOrCreateErrorBuffer(entityId: string, width: number, height: number): GPUBuffer {
    const key = `${entityId}-${width}-${height}`;
    const cached = this.#errorBufferCache.get(key);
    if (cached) return cached;

    // 4 floats per pixel (RGBA error), 4 bytes per float
    const bufferSize = width * height * 4 * 4;
    const buffer = this.ctx.device.createBuffer({
      label: `Error buffer ${entityId}`,
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.#errorBufferCache.set(key, buffer);
    return buffer;
  }

  override execute(
    entity: EffectRenderEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    const ditheringKind = entity.shaderParams.dithering?.kind ?? DitheringKind.bayer4x4;

    if (isErrorDiffusion(ditheringKind)) {
      this.#executeCompute(entity, sourceTexture, outputTexture, encoder);
    } else {
      super.execute(entity, sourceTexture, outputTexture, encoder);
    }
  }

  override executeExternal(
    entity: EffectRenderEntity,
    source: ExternalTextureSource,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    const ditheringKind = entity.shaderParams.dithering?.kind ?? DitheringKind.bayer4x4;

    if (isErrorDiffusion(ditheringKind)) {
      this.#executeComputeExternal(entity, source, outputTexture, encoder);
      return;
    }

    super.executeExternal(entity, source, outputTexture, encoder);
  }

  #executeCompute(
    entity: EffectRenderEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (!this.#computePipeline || !this.#computeBindGroupLayout) {
      return;
    }

    const device = this.ctx.device;
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;

    const errorBuffer = this.#getOrCreateErrorBuffer(entity.id, width, height);

    const uniformBuffer = this.writeEntityUniformBuffer(entity);

    const computeUsage =
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;

    const pool = this.ctx.texturePool;
    const computeOutputTexture = pool
      ? pool.acquire(width, height, computeUsage, `Compute output intermediate`)
      : device.createTexture({
          label: `Compute output intermediate texture`,
          size: [width, height],
          format: this.ctx.intermediateFormat,
          usage: computeUsage,
        });

    const bindGroup = device.createBindGroup({
      label: `Entity ${entity.id} compute bind group`,
      layout: this.#computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sourceTexture.createView() },
        { binding: 2, resource: computeOutputTexture.createView() },
        { binding: 3, resource: { buffer: errorBuffer } },
      ],
    });

    encoder.clearBuffer(errorBuffer);

    const computePass = encoder.beginComputePass({
      label: `Entity ${entity.id} compute pass`,
    });

    computePass.setPipeline(this.#computePipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(Math.ceil(height / 32));
    computePass.end();

    encoder.copyTextureToTexture({ texture: computeOutputTexture }, { texture: outputTexture }, [
      width,
      height,
    ]);

    this.ctx.releaseTexture(computeOutputTexture, width, height, computeUsage);
  }

  #executeComputeExternal(
    entity: EffectRenderEntity,
    source: ExternalTextureSource,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (!this.#externalComputePipeline || !this.#externalComputeBindGroupLayout) {
      return;
    }

    const device = this.ctx.device;
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;

    const errorBuffer = this.#getOrCreateErrorBuffer(entity.id, width, height);
    const uniformBuffer = this.writeEntityUniformBuffer(entity);

    const computeUsage =
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;

    const pool = this.ctx.texturePool;
    const computeOutputTexture = pool
      ? pool.acquire(width, height, computeUsage, `Compute external output intermediate`)
      : device.createTexture({
          label: `Compute external output intermediate texture`,
          size: [width, height],
          format: this.ctx.intermediateFormat,
          usage: computeUsage,
        });

    const bindGroup = device.createBindGroup({
      label: `Entity ${entity.id} external compute bind group`,
      layout: this.#externalComputeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: source.texture },
        { binding: 2, resource: computeOutputTexture.createView() },
        { binding: 3, resource: { buffer: errorBuffer } },
      ],
    });

    encoder.clearBuffer(errorBuffer);

    const computePass = encoder.beginComputePass({
      label: `Entity ${entity.id} external compute pass`,
    });

    computePass.setPipeline(this.#externalComputePipeline);
    computePass.setBindGroup(0, bindGroup);
    computePass.dispatchWorkgroups(Math.ceil(height / 32));
    computePass.end();

    encoder.copyTextureToTexture({ texture: computeOutputTexture }, { texture: outputTexture }, [
      width,
      height,
    ]);

    this.ctx.releaseTexture(computeOutputTexture, width, height, computeUsage);
  }

  /** Remove cached error buffers for an entity (call when entity is removed) */
  override removeEntity(entityId: string): void {
    for (const [key, buffer] of this.#errorBufferCache.entries()) {
      if (key.startsWith(entityId + "-")) {
        buffer.destroy();
        this.#errorBufferCache.delete(key);
      }
    }
    super.removeEntity(entityId);
  }

  override destroy(): void {
    for (const buffer of this.#errorBufferCache.values()) {
      buffer.destroy();
    }
    this.#errorBufferCache.clear();
    this.#computePipeline = null;
    this.#externalComputePipeline = null;
    this.#computeBindGroupLayout = null;
    this.#externalComputeBindGroupLayout = null;
    super.destroy();
  }
}
