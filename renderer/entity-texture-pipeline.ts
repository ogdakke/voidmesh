import { config } from "#config";
import { getTextureByteSize } from "#lib/textures.ts";
import {
  isAnimatedEntity,
  MediaType,
  type MediaAlphaMode,
  type ShaderCanvasEntity,
} from "#types/canvas.ts";
import type { CopyPass } from "./copy-pass.ts";
import type { EffectRenderEntity } from "./effect-render-entity.ts";
import { getEntityRenderPixelScale } from "./entity-render-size.ts";
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
  textureBudgetBytes?: number;
  onEntityError?: (entityId: string, error: string) => void;
  onTextureEvicted?: (entityIds: ReadonlySet<string>) => void;
}

interface CachedEntityTexture {
  key: string;
  texture: GPUTexture;
  compositionSource: { kind: "texture"; texture: GPUTexture };
  byteSize: number;
  lastUsedFrame: number;
  contentRevision: number;
}

interface CachedSourceTexture extends CachedEntityTexture {
  width: number;
  height: number;
  entityIds: Set<string>;
}

interface CachedProcessedTexture extends CachedEntityTexture {
  entityIds: Set<string>;
}

interface GifResizeSurface {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
}

interface LodCacheLookup {
  width: number;
  height: number;
  textureCacheRevision: number;
  isCached: boolean;
}

export interface EntityTextureResidencyStats {
  budgetBytes: number;
  residentBytes: number;
  sourceBytes: number;
  processedBytes: number;
  sourceTextureCount: number;
  processedTextureCount: number;
  /** Cumulative counters since pipeline initialization, useful for benchmarks. */
  sourceTextureAllocations: number;
  processedTextureAllocations: number;
  sourceUploads: number;
  evictions: number;
}

export class EntityTexturePipeline {
  readonly #device: GPUDevice;
  readonly #colorConfig: GpuColorConfig;
  readonly #runtime: EntityShaderRuntime;
  readonly #textureBudgetBytes: number;
  readonly #onTextureEvicted?: (entityIds: ReadonlySet<string>) => void;
  #currentFrame = 0;
  #sourceTextureAllocations = 0;
  #processedTextureAllocations = 0;
  #sourceUploads = 0;
  #evictions = 0;
  #allowLodTransitions = false;
  #lodTransitionsRemaining = 0;
  #lodTransitionPixelsRemaining = 0;
  #lodTransitionsUsed = 0;
  #pendingLodWork = false;
  #textureCacheRevision = 0;
  readonly #residentTextureEntries = new WeakMap<GPUTexture, CachedEntityTexture>();
  readonly #lodCacheLookups = new Map<object, LodCacheLookup>();
  #entityContentRevisions = new Map<string, number>();
  #gifResizeSurfaces = new Map<string, GifResizeSurface>();
  #renderEntityView: EffectRenderEntity | null = null;
  #sourceBytes = 0;
  #processedBytes = 0;
  // Processed textures keyed by immutable source + effect identity when shareable.
  #processedTextures: Map<string, CachedProcessedTexture> = new Map();
  #entityProcessedBindings: Map<string, CachedProcessedTexture> = new Map();

  // Cached source textures per asset/frame identity. Static image instances share entries.
  #sourceTextures: Map<string, CachedSourceTexture> = new Map();
  #entitySourceBindings: Map<string, CachedSourceTexture> = new Map();

  constructor(options: EntityTexturePipelineOptions) {
    this.#device = options.device;
    this.#colorConfig = options.colorConfig;
    this.#textureBudgetBytes =
      options.textureBudgetBytes ?? config.rendering.entityTextureBudgetBytes;
    this.#onTextureEvicted = options.onTextureEvicted;
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
      entity: this.#getRenderEntityView(
        entity,
        entity.originalSize.width,
        entity.originalSize.height,
      ),
      source: { kind: "texture", texture: sourceTexture },
      outputTexture,
      encoder,
      width: entity.originalSize.width,
      height: entity.originalSize.height,
      respectShowOriginal: true,
      sourceAlphaMode: getSourceAlphaMode(entity),
    });

    this.#device.queue.submit([encoder.finish()]);
    this.#runtime.flushTextureReleases();
    this.#runtime.endFrame();
  }

  /**
   * Render an entity's image through its shader to a texture.
   * Returns the texture, caching it for future frames.
   */
  renderEntityToTexture(
    entity: ShaderCanvasEntity,
    encoder: GPUCommandEncoder,
    renderSize: { width: number; height: number } = entity.originalSize,
  ): EntityCompositionSource | null {
    const width = renderSize.width;
    const height = renderSize.height;
    const useExternalVideoSource = entity.mediaSource.type === MediaType.video;
    const contentRevision = this.#resolveContentRevision(entity);

    // Time-based shaders need the shader pass every canvas render. Processed videos do not:
    // GameLoop marks them dirty only when a decoded video frame changes, so viewport-only
    // renders can safely reuse the cached processed texture instead of re-running the shader.
    const needsContinuousShaderRender =
      !entity.shaderParams.showOriginal && this.#runtime.needsContinuousRender(entity);

    if (!entity.textureDirty) {
      if (entity.shaderParams.showOriginal && !useExternalVideoSource) {
        const currentSource = this.#entitySourceBindings.get(entity.id);
        if (
          currentSource &&
          currentSource.width === width &&
          currentSource.height === height &&
          currentSource.contentRevision === contentRevision
        ) {
          currentSource.lastUsedFrame = this.#currentFrame;
          return currentSource.compositionSource;
        }
      } else if (!entity.shaderParams.showOriginal && !needsContinuousShaderRender) {
        const currentProcessed = this.#entityProcessedBindings.get(entity.id);
        if (
          currentProcessed &&
          currentProcessed.texture.width === width &&
          currentProcessed.texture.height === height &&
          currentProcessed.contentRevision === contentRevision
        ) {
          currentProcessed.lastUsedFrame = this.#currentFrame;
          return currentProcessed.compositionSource;
        }
      }
    }

    // Check if we have a valid processed texture.
    const processedKey = this.#getProcessedCacheKey(
      entity,
      width,
      height,
      needsContinuousShaderRender,
    );
    let cachedTexture = this.#processedTextures.get(processedKey);
    const processedKeyWasCached = !!cachedTexture;
    const canReuseDirtyTexture =
      entity.mediaSource.type === MediaType.image && !needsContinuousShaderRender;
    if (
      !entity.shaderParams.showOriginal &&
      !needsContinuousShaderRender &&
      cachedTexture &&
      cachedTexture.contentRevision === contentRevision &&
      (!entity.textureDirty || canReuseDirtyTexture)
    ) {
      cachedTexture.lastUsedFrame = this.#currentFrame;
      this.#bindEntityToProcessed(entity.id, processedKey, cachedTexture);
      return cachedTexture.compositionSource;
    }
    let shaderSource: EntityShaderSource | null = null;
    let sourceTexture: GPUTexture | null = null;

    if (useExternalVideoSource && entity.mediaSource.type === MediaType.video) {
      this.#releaseEntitySourceTexture(entity.id, false);
      const video = entity.mediaSource.videoElement;
      const externalTexture = this.#device.importExternalTexture({
        source: video,
        colorSpace: this.#colorConfig.textureColorSpace,
      });

      if (entity.shaderParams.showOriginal) {
        this.#releaseEntityProcessedTexture(entity.id, false);
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
        this.#sourceTextureAllocations++;
        cachedSource = {
          key: sourceKey,
          texture: sourceTexture,
          compositionSource: { kind: "texture", texture: sourceTexture },
          width,
          height,
          byteSize: getTextureByteSize(width, height, "rgba8unorm"),
          lastUsedFrame: this.#currentFrame,
          contentRevision,
          entityIds: new Set(),
        };
        this.#uploadStaticEntitySourceToTexture(entity, sourceTexture, width, height);
        this.#sourceTextures.set(sourceKey, cachedSource);
        this.#residentTextureEntries.set(sourceTexture, cachedSource);
        this.#sourceBytes += cachedSource.byteSize;
        this.#textureCacheRevision++;
      } else {
        sourceTexture = cachedSource.texture;
        cachedSource.lastUsedFrame = this.#currentFrame;
        if (cachedSource.contentRevision !== contentRevision) {
          this.#uploadStaticEntitySourceToTexture(entity, sourceTexture, width, height);
          cachedSource.contentRevision = contentRevision;
        }
      }

      this.#bindEntityToSource(entity.id, sourceKey, cachedSource);

      shaderSource = cachedSource.compositionSource;
    }

    // If showOriginal is enabled, compose the source texture directly. The source texture
    // is owned by #sourceTextures, so keep it out of #entityTextures to avoid
    // double-destroying the same GPU resource during cleanup.
    if (entity.shaderParams.showOriginal && sourceTexture) {
      this.#releaseEntityProcessedTexture(entity.id, false);
      const cachedSource = this.#entitySourceBindings.get(entity.id);
      return cachedSource?.compositionSource ?? { kind: "texture", texture: sourceTexture };
    }

    const previousProcessed = this.#entityProcessedBindings.get(entity.id);
    const previousProcessedKey = previousProcessed?.key;
    let recycledTexture: CachedProcessedTexture | null = null;
    if (previousProcessedKey && previousProcessedKey !== processedKey) {
      const previousCached = previousProcessed;
      const canRecyclePrevious =
        previousCached &&
        previousCached.texture.width === width &&
        previousCached.texture.height === height &&
        previousCached.entityIds.size === 1;
      if (canRecyclePrevious && !cachedTexture) {
        previousCached.entityIds.delete(entity.id);
        this.#entityProcessedBindings.delete(entity.id);
        this.#processedTextures.delete(previousProcessedKey);
        recycledTexture = previousCached;
      } else {
        this.#releaseEntityProcessedTexture(entity.id, canRecyclePrevious && !!cachedTexture);
      }
      cachedTexture = this.#processedTextures.get(processedKey);
    }

    // Reuse output texture if dimensions match, otherwise create new
    const outputUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;

    let outputTexture: GPUTexture;
    let createdOutputTexture = false;
    if (
      cachedTexture &&
      cachedTexture.texture.width === width &&
      cachedTexture.texture.height === height
    ) {
      // Reuse existing output texture — content will be overwritten by shader
      outputTexture = cachedTexture.texture;
    } else if (recycledTexture) {
      outputTexture = recycledTexture.texture;
    } else {
      // Dimensions changed or first render — destroy old, create new
      cachedTexture?.texture.destroy();
      if (cachedTexture) this.#residentTextureEntries.delete(cachedTexture.texture);
      if (cachedTexture) this.#processedBytes -= cachedTexture.byteSize;
      outputTexture = this.#device.createTexture({
        label: `Entity ${entity.id} processed texture`,
        size: [width, height],
        format: this.#colorConfig.intermediateFormat,
        usage: outputUsage,
      });
      this.#processedTextureAllocations++;
      createdOutputTexture = true;
    }

    this.#runtime.encode({
      entity: this.#getRenderEntityView(entity, width, height),
      source: shaderSource,
      outputTexture,
      encoder,
      width,
      height,
      respectShowOriginal: true,
      sourceAlphaMode: getSourceAlphaMode(entity),
    });

    // Cache and return (source texture stays in the shared source cache)
    const processedEntry: CachedProcessedTexture = {
      key: processedKey,
      texture: outputTexture,
      compositionSource:
        cachedTexture?.compositionSource ??
        recycledTexture?.compositionSource ??
        ({ kind: "texture", texture: outputTexture } as const),
      byteSize: getTextureByteSize(width, height, this.#colorConfig.intermediateFormat),
      lastUsedFrame: this.#currentFrame,
      contentRevision,
      entityIds: cachedTexture?.entityIds ?? recycledTexture?.entityIds ?? new Set(),
    };
    this.#processedTextures.set(processedKey, processedEntry);
    this.#residentTextureEntries.set(outputTexture, processedEntry);
    if (!processedKeyWasCached) this.#textureCacheRevision++;
    if (createdOutputTexture) this.#processedBytes += processedEntry.byteSize;
    this.#bindEntityToProcessed(entity.id, processedKey, processedEntry);
    return processedEntry.compositionSource;
  }

  getDisplayedEntityTexture(entity: ShaderCanvasEntity): GPUTexture | null {
    if (entity.shaderParams.showOriginal) {
      return (
        this.getSourceEntityTexture(entity.id) ?? this.getProcessedEntityTexture(entity.id) ?? null
      );
    }

    return this.getProcessedEntityTexture(entity.id);
  }

  getProcessedEntityTexture(entityId: string): GPUTexture | null {
    return this.#entityProcessedBindings.get(entityId)?.texture ?? null;
  }

  getSourceEntityTexture(entityId: string): GPUTexture | null {
    return this.#entitySourceBindings.get(entityId)?.texture ?? null;
  }

  needsContinuousRenderForEntity(entity: ShaderCanvasEntity): boolean {
    return !entity.shaderParams.showOriginal && this.#runtime.needsContinuousRender(entity);
  }

  getReusableStaticCompositionSource(
    entity: ShaderCanvasEntity,
    desired: { width: number; height: number },
    needsContinuousRender: boolean,
  ): EntityCompositionSource | null {
    if (
      entity.textureDirty ||
      entity.mediaSource.type !== MediaType.image ||
      needsContinuousRender
    ) {
      return null;
    }

    const entry = entity.shaderParams.showOriginal
      ? this.#entitySourceBindings.get(entity.id)
      : this.#entityProcessedBindings.get(entity.id);
    if (
      !entry ||
      entry.texture.width !== desired.width ||
      entry.texture.height !== desired.height
    ) {
      return null;
    }

    entry.lastUsedFrame = this.#currentFrame;
    return entry.compositionSource;
  }

  beginFrame(allowLodTransitions: boolean): void {
    this.#allowLodTransitions = allowLodTransitions;
    this.#lodTransitionsRemaining = config.rendering.lodTransitionsPerFrame;
    this.#lodTransitionPixelsRemaining = config.rendering.lodTransitionPixelBudget;
    this.#lodTransitionsUsed = 0;
    this.#pendingLodWork = false;
    this.#lodCacheLookups.clear();
  }

  resolveRenderSize(
    entity: ShaderCanvasEntity,
    desired: { width: number; height: number },
    output: { width: number; height: number } = { width: 0, height: 0 },
  ): { width: number; height: number } | null {
    if (entity.shaderParams.showOriginal && entity.mediaSource.type === MediaType.video) {
      output.width = desired.width;
      output.height = desired.height;
      return output;
    }

    const currentEntry = entity.shaderParams.showOriginal
      ? this.#entitySourceBindings.get(entity.id)
      : this.#entityProcessedBindings.get(entity.id);
    const current = currentEntry?.texture;
    if (current?.width === desired.width && current.height === desired.height) {
      output.width = desired.width;
      output.height = desired.height;
      return output;
    }

    // Shared static-image tiers are already rendered GPU resources. Switching another
    // instance to one is only a cache rebind, so it must not consume the transition
    // budget. Otherwise thousands of duplicates visibly converge a few entities per
    // frame even though they all use the same source and processed texture.
    const lookupToken = current ?? getSharedImageAsset(entity);
    const canReuseSharedTier =
      !current || (currentEntry?.entityIds.size ?? 0) > 1 || this.#lodCacheLookups.has(current);
    if (
      lookupToken &&
      canReuseSharedTier &&
      this.#hasCachedRenderSizeMemoized(entity, desired.width, desired.height, lookupToken)
    ) {
      output.width = desired.width;
      output.height = desired.height;
      return output;
    }

    if (!current) {
      // Cold visible entities are real upload/shader work. Keep that work under the
      // transition budget even during viewport motion so pan/zoom frames do not spike.
      if (!this.#tryAdmitLodTransition(desired.width * desired.height, true)) {
        this.#pendingLodWork = true;
        return null;
      }
      output.width = desired.width;
      output.height = desired.height;
      return output;
    }

    const pixelCost = desired.width * desired.height;
    const currentPixelCount = current.width * current.height;
    const allowAnimatedDemotion = isAnimatedEntity(entity) && pixelCost < currentPixelCount;
    const allowSharedImageDemotion =
      entity.mediaSource.type === MediaType.image &&
      (currentEntry?.entityIds.size ?? 0) > 1 &&
      pixelCost < currentPixelCount;
    if (
      !this.#tryAdmitLodTransition(pixelCost, allowAnimatedDemotion || allowSharedImageDemotion)
    ) {
      this.#pendingLodWork = true;
      output.width = current.width;
      output.height = current.height;
      return output;
    }

    output.width = desired.width;
    output.height = desired.height;
    return output;
  }

  get hasPendingLodWork(): boolean {
    return this.#pendingLodWork;
  }

  get textureCacheRevision(): number {
    return this.#textureCacheRevision;
  }

  pinCachedTexture(texture: GPUTexture): boolean {
    const entry = this.#residentTextureEntries.get(texture);
    if (!entry) return false;
    entry.lastUsedFrame = this.#currentFrame;
    return true;
  }

  endFrame(): void {
    this.#runtime.endFrame();
    this.#evictToBudget();
    this.#currentFrame++;
  }

  getResidencyStats(): EntityTextureResidencyStats {
    return {
      budgetBytes: this.#textureBudgetBytes,
      residentBytes: this.#sourceBytes + this.#processedBytes,
      sourceBytes: this.#sourceBytes,
      processedBytes: this.#processedBytes,
      sourceTextureCount: this.#sourceTextures.size,
      processedTextureCount: this.#processedTextures.size,
      sourceTextureAllocations: this.#sourceTextureAllocations,
      processedTextureAllocations: this.#processedTextureAllocations,
      sourceUploads: this.#sourceUploads,
      evictions: this.#evictions,
    };
  }

  removeEntity(entityId: string): void {
    // Remove texture
    this.#releaseEntityProcessedTexture(entityId);

    this.#releaseEntitySourceTexture(entityId);

    this.#entityContentRevisions.delete(entityId);
    const resizeSurface = this.#gifResizeSurfaces.get(entityId);
    if (resizeSurface) {
      resizeSurface.canvas.width = 1;
      resizeSurface.canvas.height = 1;
      this.#gifResizeSurfaces.delete(entityId);
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
    for (const cached of this.#processedTextures.values()) {
      cached.texture.destroy();
    }
    this.#processedTextures.clear();
    this.#entityProcessedBindings.clear();
    this.#processedBytes = 0;

    // Destroy cached source textures
    for (const cached of this.#sourceTextures.values()) {
      cached.texture.destroy();
    }
    this.#sourceTextures.clear();
    this.#entitySourceBindings.clear();
    this.#sourceBytes = 0;

    for (const { canvas } of this.#gifResizeSurfaces.values()) {
      canvas.width = 1;
      canvas.height = 1;
    }
    this.#gifResizeSurfaces.clear();
    this.#entityContentRevisions.clear();

    this.#runtime.destroy();
  }

  #uploadStaticEntitySourceToTexture(
    entity: ShaderCanvasEntity,
    texture: GPUTexture,
    width: number,
    height: number,
  ): void {
    let source: CanvasImageSource =
      entity.mediaSource.type === MediaType.image
        ? entity.mediaSource.asset.imageBitmap
        : entity.imageBitmap;
    if (source.width !== width || source.height !== height) {
      const surface =
        entity.mediaSource.type === MediaType.gif
          ? this.#getGifResizeSurface(entity.id, width, height)
          : createResizeSurface(width, height, getSourceAlphaMode(entity) !== "none");
      surface.context.drawImage(source, 0, 0, width, height);
      source = surface.canvas;
    }
    this.#device.queue.copyExternalImageToTexture(
      { source },
      { texture, colorSpace: this.#colorConfig.textureColorSpace },
      [width, height],
    );
    this.#sourceUploads++;
  }

  #getGifResizeSurface(entityId: string, width: number, height: number): GifResizeSurface {
    let surface = this.#gifResizeSurfaces.get(entityId);
    if (!surface) {
      surface = createResizeSurface(width, height, true);
      this.#gifResizeSurfaces.set(entityId, surface);
      return surface;
    }

    if (surface.canvas.width !== width) surface.canvas.width = width;
    if (surface.canvas.height !== height) surface.canvas.height = height;
    return surface;
  }

  #resolveContentRevision(entity: ShaderCanvasEntity): number {
    if (!isAnimatedEntity(entity)) return 0;

    const current = this.#entityContentRevisions.get(entity.id) ?? 0;
    if (!entity.textureDirty) return current;

    const next = current + 1;
    this.#entityContentRevisions.set(entity.id, next);
    return next;
  }

  #getRenderEntityView(
    entity: ShaderCanvasEntity,
    width: number,
    height: number,
  ): EffectRenderEntity {
    let view = this.#renderEntityView;
    const pixelScale = getEntityRenderPixelScale(entity, width, height);
    if (!view) {
      view = {
        id: entity.id,
        originalSize: { width, height },
        pixelScale,
        shaderType: entity.shaderType,
        shaderParams: entity.shaderParams,
      };
      this.#renderEntityView = view;
      return view;
    }

    view.id = entity.id;
    view.originalSize.width = width;
    view.originalSize.height = height;
    view.pixelScale = pixelScale;
    view.shaderType = entity.shaderType;
    view.shaderParams = entity.shaderParams;
    return view;
  }

  #hasCachedRenderSize(entity: ShaderCanvasEntity, width: number, height: number): boolean {
    if (entity.shaderParams.showOriginal) {
      if (entity.mediaSource.type !== MediaType.image) return false;
      return this.#sourceTextures.has(this.#getSourceCacheKey(entity, width, height));
    }

    if (entity.mediaSource.type !== MediaType.image) return false;
    const needsContinuousShaderRender = this.#runtime.needsContinuousRender(entity);
    if (needsContinuousShaderRender) return false;
    return this.#processedTextures.has(
      this.#getProcessedCacheKey(entity, width, height, needsContinuousShaderRender),
    );
  }

  #hasCachedRenderSizeMemoized(
    entity: ShaderCanvasEntity,
    width: number,
    height: number,
    token: object,
  ): boolean {
    let lookup = this.#lodCacheLookups.get(token);
    if (
      lookup &&
      lookup.width === width &&
      lookup.height === height &&
      lookup.textureCacheRevision === this.#textureCacheRevision
    ) {
      return lookup.isCached;
    }

    const isCached = this.#hasCachedRenderSize(entity, width, height);
    if (!lookup) {
      lookup = { width, height, textureCacheRevision: this.#textureCacheRevision, isCached };
      this.#lodCacheLookups.set(token, lookup);
      return isCached;
    }

    lookup.width = width;
    lookup.height = height;
    lookup.textureCacheRevision = this.#textureCacheRevision;
    lookup.isCached = isCached;
    return isCached;
  }

  #tryAdmitLodTransition(pixelCost: number, allowDuringViewportMotion: boolean): boolean {
    const withinPixelBudget = pixelCost <= this.#lodTransitionPixelsRemaining;
    const canAdmit =
      (this.#allowLodTransitions || allowDuringViewportMotion) &&
      this.#lodTransitionsRemaining > 0 &&
      (withinPixelBudget || this.#lodTransitionsUsed === 0);
    if (!canAdmit) return false;

    this.#lodTransitionsRemaining--;
    this.#lodTransitionsUsed++;
    this.#lodTransitionPixelsRemaining = Math.max(
      0,
      this.#lodTransitionPixelsRemaining - pixelCost,
    );
    return true;
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

  #getProcessedCacheKey(
    entity: ShaderCanvasEntity,
    width: number,
    height: number,
    needsContinuousShaderRender: boolean,
  ): string {
    if (entity.mediaSource.type !== MediaType.image || needsContinuousShaderRender) {
      return `entity:${entity.id}:${width}x${height}`;
    }

    // Do not retain one serialized signature per entity. Deserialized workspaces can
    // contain hundreds of thousands of distinct parameter objects with only a few
    // structural values; caching by object identity retained every duplicate string.
    const signature = JSON.stringify(entity.shaderParams);
    const asset = entity.mediaSource.asset;
    return `image:${asset.id}:${asset.revision}:${width}x${height}:${entity.shaderType}:${signature}`;
  }

  #bindEntityToProcessed(
    entityId: string,
    processedKey: string,
    cachedProcessed: CachedProcessedTexture,
  ): void {
    const previous = this.#entityProcessedBindings.get(entityId);
    const previousKey = previous?.key;
    if (previousKey === processedKey) {
      cachedProcessed.entityIds.add(entityId);
      this.#entityProcessedBindings.set(entityId, cachedProcessed);
      return;
    }
    if (previousKey) this.#releaseEntityProcessedTexture(entityId, false);

    cachedProcessed.entityIds.add(entityId);
    this.#entityProcessedBindings.set(entityId, cachedProcessed);
  }

  #releaseEntityProcessedTexture(entityId: string, destroyOrphan = true): void {
    const cachedProcessed = this.#entityProcessedBindings.get(entityId);
    if (!cachedProcessed) return;

    this.#entityProcessedBindings.delete(entityId);

    cachedProcessed.entityIds.delete(entityId);
    if (destroyOrphan && cachedProcessed.entityIds.size === 0) {
      cachedProcessed.texture.destroy();
      this.#residentTextureEntries.delete(cachedProcessed.texture);
      this.#processedTextures.delete(cachedProcessed.key);
      this.#processedBytes -= cachedProcessed.byteSize;
    }
  }

  #bindEntityToSource(
    entityId: string,
    sourceKey: string,
    cachedSource: CachedSourceTexture,
  ): void {
    const previous = this.#entitySourceBindings.get(entityId);
    const previousKey = previous?.key;
    if (previousKey === sourceKey) return;
    if (previousKey) this.#releaseEntitySourceTexture(entityId, false);

    cachedSource.entityIds.add(entityId);
    this.#entitySourceBindings.set(entityId, cachedSource);
  }

  #releaseEntitySourceTexture(entityId: string, destroyOrphan = true): void {
    const cachedSource = this.#entitySourceBindings.get(entityId);
    if (!cachedSource) return;

    this.#entitySourceBindings.delete(entityId);

    cachedSource.entityIds.delete(entityId);
    if (destroyOrphan && cachedSource.entityIds.size === 0) {
      cachedSource.texture.destroy();
      this.#residentTextureEntries.delete(cachedSource.texture);
      this.#sourceTextures.delete(cachedSource.key);
      this.#sourceBytes -= cachedSource.byteSize;
    }
  }

  #evictToBudget(): void {
    if (this.#sourceBytes + this.#processedBytes <= this.#textureBudgetBytes) return;

    let residentBytes = this.#sourceBytes + this.#processedBytes;
    const candidates: Array<
      | { kind: "processed"; key: string; cached: CachedProcessedTexture }
      | { kind: "source"; key: string; cached: CachedSourceTexture }
    > = [];

    for (const [key, cached] of this.#processedTextures) {
      if (cached.lastUsedFrame !== this.#currentFrame) {
        candidates.push({ kind: "processed", key, cached });
      }
    }
    for (const [key, cached] of this.#sourceTextures) {
      if (cached.lastUsedFrame !== this.#currentFrame) {
        candidates.push({ kind: "source", key, cached });
      }
    }
    candidates.sort((a, b) => a.cached.lastUsedFrame - b.cached.lastUsedFrame);

    for (const candidate of candidates) {
      if (residentBytes <= this.#textureBudgetBytes) break;
      candidate.cached.texture.destroy();
      this.#residentTextureEntries.delete(candidate.cached.texture);
      residentBytes -= candidate.cached.byteSize;
      this.#evictions++;
      this.#textureCacheRevision++;

      if (candidate.kind === "processed") {
        this.#processedTextures.delete(candidate.key);
        this.#processedBytes -= candidate.cached.byteSize;
        for (const entityId of candidate.cached.entityIds) {
          this.#entityProcessedBindings.delete(entityId);
        }
        this.#onTextureEvicted?.(candidate.cached.entityIds);
        continue;
      }

      this.#sourceTextures.delete(candidate.key);
      this.#sourceBytes -= candidate.cached.byteSize;
      for (const entityId of candidate.cached.entityIds) {
        this.#entitySourceBindings.delete(entityId);
      }
      this.#onTextureEvicted?.(candidate.cached.entityIds);
    }
  }
}

function createResizeSurface(width: number, height: number, alpha: boolean): GifResizeSurface {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha });
  if (!context) throw new Error("Could not create static-image LOD resize context");
  return { canvas, context };
}

function getSharedImageAsset(entity: ShaderCanvasEntity): object | null {
  return entity.mediaSource.type === MediaType.image ? entity.mediaSource.asset : null;
}

function getSourceAlphaMode(entity: ShaderCanvasEntity): MediaAlphaMode | undefined {
  if (entity.mediaSource.type === MediaType.video) return entity.mediaSource.alphaMode;
  if (entity.mediaSource.type === MediaType.image) return entity.mediaSource.asset.alphaMode;
  return undefined;
}
