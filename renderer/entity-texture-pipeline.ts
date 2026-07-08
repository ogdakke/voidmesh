import { MediaType, type ShaderCanvasEntity } from "#types/canvas.ts";
import type { CopyPass } from "./copy-pass.ts";
import { EntityShaderRuntime, type EntityShaderSource } from "./entity-shader-runtime.ts";
import type { GpuColorConfig } from "./gpu-color-space.ts";
import type { ProcessingPipeline } from "./processing-pipeline.ts";
import type { TexturePool } from "./texture-pool.ts";

export type EntityCompositionSource =
  | { kind: "texture"; texture: GPUTexture }
  | { kind: "external"; texture: GPUExternalTexture };

export interface EntityTexturePipelineOptions {
  device: GPUDevice;
  colorConfig: GpuColorConfig;
  texturePool: TexturePool | null;
  onEntityError?: (entityId: string, error: string) => void;
}

export class EntityTexturePipeline {
  readonly #device: GPUDevice;
  readonly #colorConfig: GpuColorConfig;
  readonly #runtime: EntityShaderRuntime;

  // Entity texture cache
  #entityTextures: Map<string, GPUTexture> = new Map();

  // Cached source textures per entity (avoids re-uploading unchanged images to GPU)
  #entitySourceTextures: Map<
    string,
    {
      texture: GPUTexture;
      width: number;
      height: number;
    }
  > = new Map();

  constructor(options: EntityTexturePipelineOptions) {
    this.#device = options.device;
    this.#colorConfig = options.colorConfig;
    this.#runtime = new EntityShaderRuntime({
      device: options.device,
      colorConfig: options.colorConfig,
      texturePool: options.texturePool,
      onEntityError: options.onEntityError,
    });
  }

  get processingPipeline(): ProcessingPipeline {
    return this.#runtime.processingPipeline;
  }

  get passthroughCopyPass(): CopyPass {
    return this.#runtime.passthroughCopyPass;
  }

  async initialize(): Promise<void> {
    await this.#runtime.initialize();
  }

  /**
   * Apply entity shader to source texture, writing result to output texture.
   * Handles both compute shader (error diffusion) and fragment shader paths.
   * If adjustments are set, applies them BEFORE the main shader.
   * If post-processing is enabled, applies effects AFTER the main shader.
   * This is the core shader application logic used by export rendering methods.
   *
   * Pipeline order: Source -> Adjustments -> Main Shader -> Post-Processing -> Output
   */
  applyShaderToTexture(
    entity: ShaderCanvasEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
  ): void {
    // Single encoder for the entire entity pipeline: blur -> adjustments -> shader -> post-process
    const encoder = this.#device.createCommandEncoder({
      label: `Entity ${entity.id} pipeline`,
    });
    this.#runtime.encode({
      entity,
      source: { kind: "texture", texture: sourceTexture },
      outputTexture,
      encoder,
      width: entity.originalSize.width,
      height: entity.originalSize.height,
      respectShowOriginal: true,
      sourceAlphaMode:
        entity.mediaSource.type === MediaType.video ? entity.mediaSource.alphaMode : undefined,
    });

    this.#device.queue.submit([encoder.finish()]);
    this.#runtime.flushTextureReleases();
  }

  /**
   * Render an entity's image through its shader to a texture.
   * Returns the texture, caching it for future frames.
   */
  renderEntityToTexture(
    entity: ShaderCanvasEntity,
    encoder: GPUCommandEncoder,
  ): EntityCompositionSource | null {
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const useExternalVideoSource = entity.mediaSource.type === MediaType.video;

    // Time-based shaders need the shader pass every canvas render. Processed videos do not:
    // GameLoop marks them dirty only when a decoded video frame changes, so viewport-only
    // renders can safely reuse the cached processed texture instead of re-running the shader.
    const needsContinuousShaderRender = this.#runtime.needsContinuousRender(entity);

    // Check if we have a valid processed texture.
    const cachedTexture = this.#entityTextures.get(entity.id);
    if (
      !entity.shaderParams.showOriginal &&
      !needsContinuousShaderRender &&
      cachedTexture &&
      !entity.textureDirty
    ) {
      return { kind: "texture", texture: cachedTexture };
    }
    let shaderSource: EntityShaderSource | null = null;
    let sourceTexture: GPUTexture | null = null;

    if (useExternalVideoSource && entity.mediaSource.type === MediaType.video) {
      this.#destroyEntitySourceTexture(entity.id);
      const video = entity.mediaSource.videoElement;
      const externalTexture = this.#device.importExternalTexture({
        source: video,
        colorSpace: this.#colorConfig.textureColorSpace,
      });

      if (entity.shaderParams.showOriginal) {
        cachedTexture?.destroy();
        this.#entityTextures.delete(entity.id);
        return { kind: "external", texture: externalTexture };
      }

      shaderSource = { kind: "external", texture: externalTexture };
    }

    // Source texture usage flags
    const sourceUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT;

    // Check source texture cache for static media: reuse when source dimensions match and
    // the entity was not marked dirty.
    const cachedSource = this.#entitySourceTextures.get(entity.id);

    if (!shaderSource) {
      if (
        !entity.textureDirty &&
        cachedSource &&
        cachedSource.width === width &&
        cachedSource.height === height
      ) {
        sourceTexture = cachedSource.texture;
      } else {
        // Source changed, dimensions changed, or a new animated frame arrived: upload.
        if (cachedSource && (cachedSource.width !== width || cachedSource.height !== height)) {
          // Dimensions changed — destroy old, create new
          cachedSource.texture.destroy();
          sourceTexture = this.#device.createTexture({
            label: `Entity ${entity.id} cached source`,
            size: [width, height],
            format: "rgba8unorm",
            usage: sourceUsage,
          });
        } else if (cachedSource) {
          // Same dimensions — reuse existing texture object, just re-upload data
          sourceTexture = cachedSource.texture;
        } else {
          // First render — create new long-lived source texture
          sourceTexture = this.#device.createTexture({
            label: `Entity ${entity.id} cached source`,
            size: [width, height],
            format: "rgba8unorm",
            usage: sourceUsage,
          });
        }

        this.#uploadStaticEntitySourceToTexture(entity, sourceTexture, width, height);

        this.#entitySourceTextures.set(entity.id, {
          texture: sourceTexture,
          width,
          height,
        });
      }

      shaderSource = { kind: "texture", texture: sourceTexture! };
    }

    // If showOriginal is enabled, compose the source texture directly. The source texture
    // is owned by #entitySourceTextures, so keep it out of #entityTextures to avoid
    // double-destroying the same GPU resource during cleanup.
    if (entity.shaderParams.showOriginal) {
      if (cachedTexture) {
        cachedTexture.destroy();
        this.#entityTextures.delete(entity.id);
      }
      return { kind: "texture", texture: sourceTexture! };
    }

    // Reuse output texture if dimensions match, otherwise create new
    const outputUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;

    let outputTexture: GPUTexture;
    if (cachedTexture && cachedTexture.width === width && cachedTexture.height === height) {
      // Reuse existing output texture — content will be overwritten by shader
      outputTexture = cachedTexture;
    } else {
      // Dimensions changed or first render — destroy old, create new
      cachedTexture?.destroy();
      outputTexture = this.#device.createTexture({
        label: `Entity ${entity.id} processed texture`,
        size: [width, height],
        format: this.#colorConfig.intermediateFormat,
        usage: outputUsage,
      });
    }

    // Apply shader using unified method (handles fragment, external, and compute paths).
    this.#runtime.encode({
      entity,
      source: shaderSource,
      outputTexture,
      encoder,
      width,
      height,
      respectShowOriginal: true,
      sourceAlphaMode:
        entity.mediaSource.type === MediaType.video ? entity.mediaSource.alphaMode : undefined,
    });

    // Cache and return (source texture stays in #entitySourceTextures)
    this.#entityTextures.set(entity.id, outputTexture);
    return { kind: "texture", texture: outputTexture };
  }

  getDisplayedEntityTexture(entity: ShaderCanvasEntity): GPUTexture | null {
    if (entity.shaderParams.showOriginal) {
      return (
        this.#entitySourceTextures.get(entity.id)?.texture ??
        this.#entityTextures.get(entity.id) ??
        null
      );
    }

    return this.#entityTextures.get(entity.id) ?? null;
  }

  getProcessedEntityTexture(entityId: string): GPUTexture | null {
    return this.#entityTextures.get(entityId) ?? null;
  }

  getSourceEntityTexture(entityId: string): GPUTexture | null {
    return this.#entitySourceTextures.get(entityId)?.texture ?? null;
  }

  needsContinuousRenderForEntity(entity: ShaderCanvasEntity): boolean {
    return this.#runtime.needsContinuousRender(entity);
  }

  removeEntity(entityId: string): void {
    // Remove texture
    const texture = this.#entityTextures.get(entityId);
    texture?.destroy();
    this.#entityTextures.delete(entityId);

    // Remove cached source texture
    const cachedSource = this.#entitySourceTextures.get(entityId);
    if (cachedSource) {
      cachedSource.texture.destroy();
      this.#entitySourceTextures.delete(entityId);
    }

    this.#runtime.removeEntity(entityId);
  }

  removeGlassEntity(entityId: string): void {
    this.#runtime.removeGlassEntity(entityId);
  }

  flushTextureReleases(): void {
    this.#runtime.flushTextureReleases();
  }

  destroy(): void {
    // Destroy entity textures
    for (const texture of this.#entityTextures.values()) {
      texture.destroy();
    }
    this.#entityTextures.clear();

    // Destroy cached source textures
    for (const cached of this.#entitySourceTextures.values()) {
      cached.texture.destroy();
    }
    this.#entitySourceTextures.clear();

    this.#runtime.destroy();
  }

  #uploadStaticEntitySourceToTexture(
    entity: ShaderCanvasEntity,
    texture: GPUTexture,
    width: number,
    height: number,
  ): void {
    const source =
      entity.mediaSource.type === MediaType.image
        ? entity.mediaSource.imageBitmap
        : entity.imageBitmap;
    this.#device.queue.copyExternalImageToTexture(
      { source },
      { texture, colorSpace: this.#colorConfig.textureColorSpace },
      [width, height],
    );
  }

  #destroyEntitySourceTexture(entityId: string): void {
    const cachedSource = this.#entitySourceTextures.get(entityId);
    if (!cachedSource) return;

    cachedSource.texture.destroy();
    this.#entitySourceTextures.delete(entityId);
  }
}
