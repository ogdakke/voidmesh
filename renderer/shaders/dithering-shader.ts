import { config } from "#config";
import { DitheringKind, isErrorDiffusion, type ShaderCanvasEntity } from "#types/canvas.ts";
import ditheringComputeShaderSource from "../dithering-compute.wgsl?raw";
import ditheringShaderSource from "../dithering.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

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

export class DitheringShader extends ShaderPass {
  override supportsDepth(): boolean {
    return true;
  }

  // Compute pipeline for error diffusion
  #computePipeline: GPUComputePipeline | null = null;
  #computeBindGroupLayout: GPUBindGroupLayout | null = null;
  #computeUniformBuffer: GPUBuffer | null = null;
  // Error buffer cache per entity (keyed by entityId-width-height)
  #errorBufferCache: Map<string, GPUBuffer> = new Map();

  override getShaderSource(): string {
    return ditheringShaderSource;
  }

  override writeVariantUniforms(entity: ShaderCanvasEntity): void {
    const ditheringKind = entity.shaderParams.dithering?.kind ?? DitheringKind.bayer4x4;
    this.ctx.uintView[7] = DITHERING_KIND_INDEX[ditheringKind];
  }

  override async initialize(): Promise<void> {
    // Fragment pipeline (ordered dithering) - from base class
    this.bindGroupLayout = this.createBindGroupLayout();
    this.pipeline = this.createPipeline();

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

    this.#computeUniformBuffer = device.createBuffer({
      label: "Dithering compute uniforms",
      size: config.rendering.ditheringUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = device.createShaderModule({
      label: "Dithering compute shader",
      code: ditheringComputeShaderSource,
    });

    const compilationInfo = await shaderModule.getCompilationInfo();
    const errors = compilationInfo.messages.filter((m) => m.type === "error");
    if (errors.length > 0) {
      const errorMessages = errors.map((e) => `Line ${e.lineNum}: ${e.message}`).join("\n");
      throw new Error(`Dithering compute shader compilation failed:\n${errorMessages}`);
    }

    const pipelineLayout = device.createPipelineLayout({
      label: "Dithering compute pipeline layout",
      bindGroupLayouts: [this.#computeBindGroupLayout],
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
    entity: ShaderCanvasEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    depthTexture?: GPUTexture,
  ): void {
    const ditheringKind = entity.shaderParams.dithering?.kind ?? DitheringKind.bayer4x4;

    if (isErrorDiffusion(ditheringKind)) {
      this.#executeCompute(entity, sourceTexture, outputTexture);
    } else {
      // Ordered dithering uses the standard fragment shader path
      super.execute(entity, sourceTexture, outputTexture, depthTexture);
    }
  }

  #executeCompute(
    entity: ShaderCanvasEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
  ): void {
    if (!this.#computePipeline || !this.#computeBindGroupLayout || !this.#computeUniformBuffer) {
      return;
    }

    const device = this.ctx.device;
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;

    const errorBuffer = this.#getOrCreateErrorBuffer(entity.id, width, height);

    // Write uniforms (uses same shared uniform data + compute uniform buffer)
    this.writeUniforms(entity);
    device.queue.writeBuffer(this.#computeUniformBuffer, 0, this.ctx.uniformData);

    // Compute shader writes to a storage texture, then copy to output
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
        { binding: 0, resource: { buffer: this.#computeUniformBuffer } },
        { binding: 1, resource: sourceTexture.createView() },
        { binding: 2, resource: computeOutputTexture.createView() },
        { binding: 3, resource: { buffer: errorBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder({
      label: `Entity ${entity.id} compute encoder`,
    });

    // GPU-native error buffer clear (no CPU transfer)
    encoder.clearBuffer(errorBuffer);

    const computePass = encoder.beginComputePass({
      label: `Entity ${entity.id} compute pass`,
    });

    computePass.setPipeline(this.#computePipeline);
    computePass.setBindGroup(0, bindGroup);
    // Dispatch ceil(height/32) workgroups - 32 threads per workgroup, each handles one row
    computePass.dispatchWorkgroups(Math.ceil(height / 32));
    computePass.end();

    // Copy compute output to the final output texture
    encoder.copyTextureToTexture({ texture: computeOutputTexture }, { texture: outputTexture }, [
      width,
      height,
    ]);

    device.queue.submit([encoder.finish()]);

    // Release compute output texture back to pool
    if (pool) {
      pool.release(computeOutputTexture, width, height, computeUsage);
    } else {
      computeOutputTexture.destroy();
    }
  }

  /** Remove cached error buffers for an entity (call when entity is removed) */
  removeEntity(entityId: string): void {
    for (const [key, buffer] of this.#errorBufferCache.entries()) {
      if (key.startsWith(entityId + "-")) {
        buffer.destroy();
        this.#errorBufferCache.delete(key);
      }
    }
  }

  override destroy(): void {
    for (const buffer of this.#errorBufferCache.values()) {
      buffer.destroy();
    }
    this.#errorBufferCache.clear();
    this.#computeUniformBuffer?.destroy();
    this.#computeUniformBuffer = null;
    this.#computePipeline = null;
    this.#computeBindGroupLayout = null;
    super.destroy();
  }
}
