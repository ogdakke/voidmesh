import { config } from "#config";
import type { RGBA } from "#types/canvas.ts";
import { ShaderType } from "#types/canvas.ts";
import { CopyPass } from "./copy-pass.ts";
import type { EffectRenderEntity } from "./effect-render-entity.ts";
import type { GpuColorConfig } from "./gpu-color-space.ts";
import { ProcessingPipeline } from "./processing-pipeline.ts";
import { AsciiShader } from "./shaders/ascii-shader.ts";
import { BlobsShader } from "./shaders/blobs-shader.ts";
import { DitheringShader } from "./shaders/dithering-shader.ts";
import { GlassShader } from "./shaders/glass-shader.ts";
import { GlitchShader } from "./shaders/glitch-shader.ts";
import { HalftoneShader } from "./shaders/halftone-shader.ts";
import { MeltShader } from "./shaders/melt-shader.ts";
import type { ShaderContext } from "./shaders/shader-pass.ts";
import { ShaderRegistry } from "./shaders/shader-registry.ts";
import type { TexturePool } from "./texture-pool.ts";

export interface EntityShaderRuntimeOptions {
  device: GPUDevice;
  colorConfig: GpuColorConfig;
  texturePool: TexturePool | null;
  onEntityError?: (entityId: string, error: string) => void;
}

export class EntityShaderRuntime {
  #device: GPUDevice;
  #colorConfig: GpuColorConfig;
  #texturePool: TexturePool | null;
  #shaderRegistry = new ShaderRegistry();
  #processingPipeline: ProcessingPipeline;
  #passthroughCopyPass: CopyPass;
  #uniformBuffer: GPUBuffer;
  #sampler: GPUSampler;
  #uniformData = new ArrayBuffer(config.rendering.ditheringUniformSize);
  #floatView = new Float32Array(this.#uniformData);
  #uintView = new Uint32Array(this.#uniformData);
  #sortedPaletteCache: { original: readonly RGBA[]; reversed: boolean; sorted: RGBA[] } | null =
    null;
  #shaderContext: ShaderContext;
  #initialized = false;
  #onEntityError?: (entityId: string, error: string) => void;

  constructor(options: EntityShaderRuntimeOptions) {
    this.#device = options.device;
    this.#colorConfig = options.colorConfig;
    this.#texturePool = options.texturePool;
    this.#onEntityError = options.onEntityError;
    this.#uniformBuffer = this.#device.createBuffer({
      label: "Entity shader uniforms",
      size: config.rendering.ditheringUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#sampler = this.#device.createSampler({
      label: "Entity shader sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.#shaderContext = {
      device: this.#device,
      uniformBuffer: this.#uniformBuffer,
      uniformData: this.#uniformData,
      floatView: this.#floatView,
      uintView: this.#uintView,
      sampler: this.#sampler,
      sortedPaletteCache: this.#sortedPaletteCache,
      texturePool: this.#texturePool,
      intermediateFormat: this.#colorConfig.intermediateFormat,
      supportsP3: this.#colorConfig.supportsP3,
    };
    this.#processingPipeline = new ProcessingPipeline(
      this.#device,
      this.#colorConfig.intermediateFormat,
      this.#colorConfig.supportsP3,
    );
    this.#passthroughCopyPass = new CopyPass(this.#device, this.#colorConfig.intermediateFormat);
  }

  get passthroughCopyPass(): CopyPass {
    return this.#passthroughCopyPass;
  }

  get processingPipeline(): ProcessingPipeline {
    return this.#processingPipeline;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;

    const asciiShader = new AsciiShader(this.#shaderContext);
    asciiShader.onEntityError = this.#onEntityError;
    const shaders = [
      [ShaderType.halftone, new HalftoneShader(this.#shaderContext)] as const,
      [ShaderType.blobs, new BlobsShader(this.#shaderContext)] as const,
      [ShaderType.melt, new MeltShader(this.#shaderContext)] as const,
      [ShaderType.glass, new GlassShader(this.#shaderContext)] as const,
      [ShaderType.glitch, new GlitchShader(this.#shaderContext)] as const,
      [ShaderType.ascii, asciiShader] as const,
      [ShaderType.dithering, new DitheringShader(this.#shaderContext)] as const,
    ];

    await Promise.all(
      shaders.map(async ([type, pass]) => {
        await pass.initialize();
        this.#shaderRegistry.register(type, pass);
      }),
    );
    this.#processingPipeline.initialize();
    this.#initialized = true;
  }

  encode(params: {
    entity: EffectRenderEntity;
    sourceTexture: GPUTexture;
    outputTexture: GPUTexture;
    encoder: GPUCommandEncoder;
    width: number;
    height: number;
    respectShowOriginal: boolean;
  }): void {
    const { entity, sourceTexture, outputTexture, encoder, width, height } = params;

    if (params.respectShowOriginal && entity.shaderParams.showOriginal) {
      this.#passthroughCopyPass.encode(encoder, sourceTexture, outputTexture);
      return;
    }

    const needsBlur = this.#processingPipeline.needsBlur(entity);
    const needsAdjustments = this.#processingPipeline.needsAdjustments(entity);
    const postProcessEnabled = entity.shaderParams.postProcess?.enabled ?? false;
    const preProcessUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC;

    let shaderSourceTexture = sourceTexture;
    let blurOutputTexture: GPUTexture | null = null;
    let adjustmentsOutputTexture: GPUTexture | null = null;

    if (needsBlur) {
      blurOutputTexture = this.#acquireTexture(
        width,
        height,
        preProcessUsage,
        "Blur output texture",
      );
      this.#processingPipeline.applyBlur(entity, sourceTexture, blurOutputTexture, encoder);
      shaderSourceTexture = blurOutputTexture;
    }

    if (needsAdjustments) {
      adjustmentsOutputTexture = this.#acquireTexture(
        width,
        height,
        preProcessUsage,
        "Adjustments output texture",
      );
      this.#processingPipeline.applyAdjustments(
        entity,
        shaderSourceTexture,
        adjustmentsOutputTexture,
        encoder,
      );
      shaderSourceTexture = adjustmentsOutputTexture;
    }

    const postProcessUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST;
    let mainShaderOutputTexture = outputTexture;
    let postProcessIntermediateTexture: GPUTexture | null = null;

    if (postProcessEnabled) {
      postProcessIntermediateTexture = this.#acquireTexture(
        width,
        height,
        postProcessUsage,
        "Post-process intermediate texture",
      );
      mainShaderOutputTexture = postProcessIntermediateTexture;
    }

    this.#shaderRegistry.applyShader(entity, shaderSourceTexture, mainShaderOutputTexture, encoder);

    if (blurOutputTexture) {
      this.#releaseTexture(blurOutputTexture, width, height, preProcessUsage);
    }
    if (adjustmentsOutputTexture) {
      this.#releaseTexture(adjustmentsOutputTexture, width, height, preProcessUsage);
    }

    if (postProcessIntermediateTexture) {
      this.#processingPipeline.applyPostProcessing(
        entity,
        postProcessIntermediateTexture,
        outputTexture,
        encoder,
      );
      this.#releaseTexture(postProcessIntermediateTexture, width, height, postProcessUsage);
    }
  }

  #acquireTexture(
    width: number,
    height: number,
    usage: GPUTextureUsageFlags,
    label: string,
  ): GPUTexture {
    if (this.#texturePool) return this.#texturePool.acquire(width, height, usage, label);
    return this.#device.createTexture({
      label,
      size: [width, height],
      format: this.#colorConfig.intermediateFormat,
      usage,
    });
  }

  #releaseTexture(
    texture: GPUTexture,
    width: number,
    height: number,
    usage: GPUTextureUsageFlags,
  ): void {
    if (this.#texturePool) {
      this.#texturePool.release(texture, width, height, usage);
    } else {
      texture.destroy();
    }
  }

  needsContinuousRender(entity: EffectRenderEntity): boolean {
    return this.#shaderRegistry.get(entity.shaderType)?.needsContinuousRender(entity) ?? false;
  }

  removeEntity(entityId: string): void {
    const ditheringShader = this.#shaderRegistry.get(ShaderType.dithering) as
      | DitheringShader
      | undefined;
    ditheringShader?.removeEntity(entityId);
    this.removeGlassEntity(entityId);
  }

  removeGlassEntity(entityId: string): void {
    const glassShader = this.#shaderRegistry.get(ShaderType.glass) as GlassShader | undefined;
    glassShader?.removeEntity(entityId);
  }

  destroy(): void {
    this.#shaderRegistry.destroy();
    this.#processingPipeline.destroy();
    this.#uniformBuffer.destroy();
  }
}
