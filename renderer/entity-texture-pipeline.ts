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

  // Cached source textures per asset/frame identity. Static image instances share entries.
  #sourceTextures: Map<
    string,
    {
      texture: GPUTexture;
      width: number;
      height: number;
      entityIds: Set<string>;
    }
  > = new Map();
  #entitySourceKeys: Map<string, string> = new Map();

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
      this.#releaseEntitySourceTexture(entity.id);
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

    if (!shaderSource) {
      const sourceKey = this.#getSourceCacheKey(entity, width, height);
      let cachedSource = this.#sourceTextures.get(sourceKey);
      if (!cachedSource) {
        sourceTexture = this.#device.createTexture({
          label: `Source ${sourceKey}`,
          size: [width, height],
          format: "rgba8unorm",
          usage: sourceUsage,
        });
        this.#uploadStaticEntitySourceToTexture(entity, sourceTexture, width, height);
        cachedSource = {
          texture: sourceTexture,
          width,
          height,
          entityIds: new Set(),
        };
        this.#sourceTextures.set(sourceKey, cachedSource);
      } else {
        sourceTexture = cachedSource.texture;
        if (entity.mediaSource.type === MediaType.gif && entity.textureDirty) {
          this.#uploadStaticEntitySourceToTexture(entity, sourceTexture, width, height);
        }
      }

      this.#bindEntityToSource(entity.id, sourceKey, cachedSource);

      shaderSource = { kind: "texture", texture: sourceTexture! };
    }

    // If showOriginal is enabled, compose the source texture directly. The source texture
    // is owned by #sourceTextures, so keep it out of #entityTextures to avoid
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

    // Cache and return (source texture stays in the shared source cache)
    this.#entityTextures.set(entity.id, outputTexture);
    return { kind: "texture", texture: outputTexture };
  }

  getDisplayedEntityTexture(entity: ShaderCanvasEntity): GPUTexture | null {
    if (entity.shaderParams.showOriginal) {
      return this.getSourceEntityTexture(entity.id) ?? this.#entityTextures.get(entity.id) ?? null;
    }

    return this.#entityTextures.get(entity.id) ?? null;
  }

  getProcessedEntityTexture(entityId: string): GPUTexture | null {
    return this.#entityTextures.get(entityId) ?? null;
  }

  getSourceEntityTexture(entityId: string): GPUTexture | null {
    const sourceKey = this.#entitySourceKeys.get(entityId);
    return sourceKey ? (this.#sourceTextures.get(sourceKey)?.texture ?? null) : null;
  }

  needsContinuousRenderForEntity(entity: ShaderCanvasEntity): boolean {
    return this.#runtime.needsContinuousRender(entity);
  }

  removeEntity(entityId: string): void {
    // Remove texture
    const texture = this.#entityTextures.get(entityId);
    texture?.destroy();
    this.#entityTextures.delete(entityId);

    this.#releaseEntitySourceTexture(entityId);

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
    for (const cached of this.#sourceTextures.values()) {
      cached.texture.destroy();
    }
    this.#sourceTextures.clear();
    this.#entitySourceKeys.clear();

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
        ? entity.mediaSource.asset.imageBitmap
        : entity.imageBitmap;
    this.#device.queue.copyExternalImageToTexture(
      { source },
      { texture, colorSpace: this.#colorConfig.textureColorSpace },
      [width, height],
    );
  }

  #getSourceCacheKey(entity: ShaderCanvasEntity, width: number, height: number): string {
    switch (entity.mediaSource.type) {
      case MediaType.image:
        return `image:${entity.mediaSource.asset.id}:${entity.mediaSource.asset.revision}:${width}x${height}`;
      case MediaType.gif:
        return `gif:${entity.id}:${width}x${height}`;
      case MediaType.svg:
        return `svg:${entity.id}:${width}x${height}`;
      case MediaType.video:
        throw new Error("External video textures do not have source cache keys");
    }
  }

  #bindEntityToSource(
    entityId: string,
    sourceKey: string,
    cachedSource: { texture: GPUTexture; width: number; height: number; entityIds: Set<string> },
  ): void {
    const previousKey = this.#entitySourceKeys.get(entityId);
    if (previousKey === sourceKey) return;
    if (previousKey) this.#releaseEntitySourceTexture(entityId);

    cachedSource.entityIds.add(entityId);
    this.#entitySourceKeys.set(entityId, sourceKey);
  }

  #releaseEntitySourceTexture(entityId: string): void {
    const sourceKey = this.#entitySourceKeys.get(entityId);
    if (!sourceKey) return;

    this.#entitySourceKeys.delete(entityId);
    const cachedSource = this.#sourceTextures.get(sourceKey);
    if (!cachedSource) return;

    cachedSource.entityIds.delete(entityId);
    if (cachedSource.entityIds.size === 0) {
      cachedSource.texture.destroy();
      this.#sourceTextures.delete(sourceKey);
    }
  }
}
