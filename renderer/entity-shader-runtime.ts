import { config } from "#config";
import { isErrorDiffusion, ShaderType } from "#types/canvas.ts";
import type { MediaAlphaMode, RGBA } from "#types/canvas.ts";
import { AlphaMaskPass } from "./alpha-mask-pass.ts";
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
import type { ExternalTextureSource } from "./shaders/shader-pass.ts";
import { ShaderRegistry } from "./shaders/shader-registry.ts";
import type { TexturePool } from "./texture-pool.ts";

export interface EntityShaderRuntimeOptions {
  device: GPUDevice;
  colorConfig: GpuColorConfig;
  texturePool: TexturePool | null;
  onEntityError?: (entityId: string, error: string) => void;
}

export type EntityShaderSource =
  | { kind: "texture"; texture: GPUTexture }
  | ({ kind: "external" } & ExternalTextureSource);

export class EntityShaderRuntime {
  #device: GPUDevice;
  #colorConfig: GpuColorConfig;
  #texturePool: TexturePool | null;
  #shaderRegistry = new ShaderRegistry();
  #processingPipeline: ProcessingPipeline;
  #passthroughCopyPass: CopyPass;
  #alphaMaskPass: AlphaMaskPass;
  #sampler: GPUSampler;
  #uniformData = new ArrayBuffer(config.rendering.ditheringUniformSize);
  #floatView = new Float32Array(this.#uniformData);
  #uintView = new Uint32Array(this.#uniformData);
  #sortedPaletteCache: { original: readonly RGBA[]; reversed: boolean; sorted: RGBA[] } | null =
    null;
  #pendingTextureReleases: Array<{
    texture: GPUTexture;
    width: number;
    height: number;
    usage: GPUTextureUsageFlags;
  }> = [];
  #shaderContext: ShaderContext;
  #initialized = false;
  #onEntityError?: (entityId: string, error: string) => void;

  constructor(options: EntityShaderRuntimeOptions) {
    this.#device = options.device;
    this.#colorConfig = options.colorConfig;
    this.#texturePool = options.texturePool;
    this.#onEntityError = options.onEntityError;
    this.#sampler = this.#device.createSampler({
      label: "Entity shader sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.#shaderContext = {
      device: this.#device,
      uniformData: this.#uniformData,
      floatView: this.#floatView,
      uintView: this.#uintView,
      sampler: this.#sampler,
      sortedPaletteCache: this.#sortedPaletteCache,
      texturePool: this.#texturePool,
      releaseTexture: (texture, width, height, usage) => {
        this.#releaseTexture(texture, width, height, usage);
      },
      intermediateFormat: this.#colorConfig.intermediateFormat,
      supportsP3: this.#colorConfig.supportsP3,
      supportsImmediates: supportsShaderImmediates(),
    };
    this.#processingPipeline = new ProcessingPipeline(
      this.#device,
      this.#colorConfig.intermediateFormat,
      this.#colorConfig.supportsP3,
    );
    this.#passthroughCopyPass = new CopyPass(this.#device, this.#colorConfig.intermediateFormat);
    this.#alphaMaskPass = new AlphaMaskPass(this.#device, this.#colorConfig.intermediateFormat);
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
    source: EntityShaderSource;
    outputTexture: GPUTexture;
    encoder: GPUCommandEncoder;
    width: number;
    height: number;
    respectShowOriginal: boolean;
    sourceAlphaMode?: MediaAlphaMode;
  }): void {
    const { entity, source, outputTexture, encoder, width, height } = params;

    if (params.respectShowOriginal && entity.shaderParams.showOriginal) {
      if (source.kind === "external") return;
      const sourceTexture = source.texture;
      this.#passthroughCopyPass.encode(encoder, sourceTexture, outputTexture);
      return;
    }

    const applySourceAlphaMask = shouldApplySourceAlphaMask(entity, params.sourceAlphaMode);
    const needsBlur = this.#processingPipeline.needsBlur(entity);
    const needsAdjustments = this.#processingPipeline.needsAdjustments(entity);
    const postProcessEnabled = entity.shaderParams.postProcess?.enabled ?? false;
    const preProcessUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC;

    let shaderSource = source;
    let blurOutputTexture: GPUTexture | null = null;
    let adjustmentsOutputTexture: GPUTexture | null = null;

    if (needsBlur) {
      blurOutputTexture = this.#acquireTexture(
        width,
        height,
        preProcessUsage,
        "Blur output texture",
      );
      if (source.kind === "external") {
        this.#processingPipeline.applyBlurExternal(entity, source, blurOutputTexture, encoder);
      } else {
        this.#processingPipeline.applyBlur(entity, source.texture, blurOutputTexture, encoder);
      }
      shaderSource = { kind: "texture", texture: blurOutputTexture };
    }

    if (needsAdjustments) {
      adjustmentsOutputTexture = this.#acquireTexture(
        width,
        height,
        preProcessUsage,
        "Adjustments output texture",
      );
      if (shaderSource.kind === "external") {
        this.#processingPipeline.applyAdjustmentsExternal(
          entity,
          shaderSource,
          adjustmentsOutputTexture,
          encoder,
        );
      } else {
        this.#processingPipeline.applyAdjustments(
          entity,
          shaderSource.texture,
          adjustmentsOutputTexture,
          encoder,
        );
      }
      shaderSource = { kind: "texture", texture: adjustmentsOutputTexture };
    }

    const postProcessUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST;
    const alphaMaskUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST;
    let pipelineOutputTexture = outputTexture;
    let alphaMaskIntermediateTexture: GPUTexture | null = null;
    let postProcessIntermediateTexture: GPUTexture | null = null;
    const reuseOutputTextureForPostProcessSource = postProcessEnabled && applySourceAlphaMask;

    if (applySourceAlphaMask) {
      alphaMaskIntermediateTexture = this.#acquireTexture(
        width,
        height,
        alphaMaskUsage,
        "Alpha mask intermediate texture",
      );
      pipelineOutputTexture = alphaMaskIntermediateTexture;
    }

    let mainShaderOutputTexture = pipelineOutputTexture;
    if (postProcessEnabled) {
      if (reuseOutputTextureForPostProcessSource) {
        mainShaderOutputTexture = outputTexture;
      } else {
        postProcessIntermediateTexture = this.#acquireTexture(
          width,
          height,
          postProcessUsage,
          "Post-process intermediate texture",
        );
        mainShaderOutputTexture = postProcessIntermediateTexture;
      }
    }

    if (shaderSource.kind === "external") {
      this.#shaderRegistry.applyShaderExternal(
        entity,
        shaderSource,
        mainShaderOutputTexture,
        encoder,
      );
    } else {
      this.#shaderRegistry.applyShader(
        entity,
        shaderSource.texture,
        mainShaderOutputTexture,
        encoder,
      );
    }

    if (blurOutputTexture) {
      this.#releaseTexture(blurOutputTexture, width, height, preProcessUsage);
    }
    if (adjustmentsOutputTexture) {
      this.#releaseTexture(adjustmentsOutputTexture, width, height, preProcessUsage);
    }

    if (postProcessEnabled) {
      this.#processingPipeline.applyPostProcessing(
        entity,
        mainShaderOutputTexture,
        pipelineOutputTexture,
        encoder,
      );
    }

    if (postProcessIntermediateTexture) {
      this.#releaseTexture(postProcessIntermediateTexture, width, height, postProcessUsage);
    }

    if (alphaMaskIntermediateTexture) {
      this.#alphaMaskPass.encode(encoder, alphaMaskIntermediateTexture, source, outputTexture);
      this.#releaseTexture(alphaMaskIntermediateTexture, width, height, alphaMaskUsage);
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
    // Passes are encoded in order, so pooled scratch can be reused by a later pass in the
    // same command buffer once the final read/copy using this texture has been encoded.
    if (this.#texturePool) {
      this.#texturePool.release(texture, width, height, usage);
      return;
    }
    this.#pendingTextureReleases.push({ texture, width, height, usage });
  }

  flushTextureReleases(): void {
    for (const release of this.#pendingTextureReleases) {
      release.texture.destroy();
    }
    this.#pendingTextureReleases = [];
  }

  needsContinuousRender(entity: EffectRenderEntity): boolean {
    return this.#shaderRegistry.get(entity.shaderType)?.needsContinuousRender(entity) ?? false;
  }

  removeEntity(entityId: string): void {
    this.#shaderRegistry.removeEntity(entityId);
    this.#processingPipeline.removeEntity(entityId);
  }

  endFrame(): void {
    this.#processingPipeline.endFrame();
  }

  removeGlassEntity(entityId: string): void {
    const glassShader = this.#shaderRegistry.get(ShaderType.glass) as GlassShader | undefined;
    glassShader?.removeEntity(entityId);
  }

  destroy(): void {
    this.flushTextureReleases();
    this.#shaderRegistry.destroy();
    this.#processingPipeline.destroy();
  }
}

function supportsShaderImmediates(): boolean {
  if (shaderImmediatesDisabledByLocation()) return false;
  return globalThis.navigator.gpu?.wgslLanguageFeatures?.has("immediate_address_space") ?? false;
}

function shaderImmediatesDisabledByLocation(): boolean {
  const search = globalThis.location?.search;
  if (!search) return false;
  return new URLSearchParams(search).get("shaderImmediates") === "0";
}

function shouldApplySourceAlphaMask(
  entity: EffectRenderEntity,
  sourceAlphaMode: MediaAlphaMode | undefined,
): boolean {
  if (sourceAlphaMode === "none") {
    return false;
  }

  if (entity.shaderType !== ShaderType.dithering) return true;

  const ditheringKind = entity.shaderParams.dithering?.kind;
  return ditheringKind ? !isErrorDiffusion(ditheringKind) : true;
}
