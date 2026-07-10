import { config, getViewportLensDistortionConfig, type GridConfig } from "#config";
import { logger } from "#lib/client.logger.ts";
import { boundsIntersect, getRotatedAABB, getViewportWorldBounds } from "#lib/canvas-math.ts";
import { getFrameAtTime } from "#lib/gif-decoder.ts";
import { setGpuContext } from "./gpu-color-space.ts";
import type { DisintegrationRenderOverlay, RenderState } from "#engine";
import { MediaType, type Bounds, type ShaderCanvasEntity, type Viewport } from "#types/canvas.ts";
import { CanvasLensing } from "#types/enums.ts";
import { ActionLayerBlurPass } from "./action-layer-blur-pass.ts";
import { CanvasCalloutPass } from "./canvas-callout-pass.ts";
import { CompositionPass, type CompositionDrawItem } from "./composition-pass.ts";
import { DisintegrationPass } from "./disintegration-pass.ts";
import { EntityDrawItemPreparer } from "./entity-draw-item-preparer.ts";
import { EntityLabelPass } from "./entity-label-pass.ts";
import {
  EntityTexturePipeline,
  type EntityCompositionSource,
  type EntityTextureResidencyStats,
} from "./entity-texture-pipeline.ts";
import { ExportService } from "./export-service.ts";
import { ExternalTextureCopyPass } from "./external-texture-copy-pass.ts";
import type { ImageExportOptions } from "./export-formats.ts";
import { detectGpuColorConfig, type GpuColorConfig } from "./gpu-color-space.ts";
import { GridPass } from "./grid-pass.ts";
import type { ByteBudgetCacheStats } from "./byte-budget-cache.ts";
import { SelectionRectPass } from "./selection-rect-pass.ts";
import { TexturePool, type TexturePoolStats } from "./texture-pool.ts";
import { ViewportLensPass, type ViewportLensDistortionConfig } from "./viewport-lens-pass.ts";
import { ViewportUniforms } from "./viewport-uniforms.ts";
import type { WlurOverlayConfig } from "./wlur-overlay.ts";
import { WlurOverlayPass } from "./wlur-overlay-pass.ts";

export type { ViewportLensDistortionConfig } from "./viewport-lens-pass.ts";

export interface RendererResourceStats {
  entityTextures: EntityTextureResidencyStats;
  processingTextures: ByteBudgetCacheStats;
  texturePool: TexturePoolStats;
}

export class InfiniteCanvasRenderer {
  readonly canvas: HTMLCanvasElement;

  #device: GPUDevice | null = null;
  #context: GPUCanvasContext | null = null;
  #canvasFormat!: GPUTextureFormat;
  #colorConfig!: GpuColorConfig;

  #gridPass: GridPass | null = null;

  #compositionPass: CompositionPass | null = null;
  #externalTextureCopyPass: ExternalTextureCopyPass | null = null;
  #viewportUniforms: ViewportUniforms | null = null;

  // Entity error tracking (entityId -> error message)
  #entityErrors: Map<string, string> = new Map();
  // Callback for error notifications (e.g., to show toast)
  onEntityError?: (entityId: string, error: string) => void;
  // Callback for GPU device lost events
  onDeviceLost?: (reason: string) => void;

  #actionLayerBlurPass: ActionLayerBlurPass | null = null;

  // Texture pool for eliminating per-frame allocation churn
  #texturePool: TexturePool | null = null;

  #disintegrationPass: DisintegrationPass | null = null;

  // Entity label pass (Canvas 2D rasterized → GPU textured quad)
  #entityLabelPass: EntityLabelPass | null = null;
  #canvasCalloutPass: CanvasCalloutPass | null = null;

  // Cached canvas dimensions (updated by ResizeObserver, avoids getBoundingClientRect in render loop)
  #cachedCanvasWidth = 0;
  #cachedCanvasHeight = 0;
  #lastFrameTime = 0;
  #resizeObserver: ResizeObserver | null = null;

  #selectionRectPass: SelectionRectPass | null = null;

  #viewportLensPass: ViewportLensPass | null = null;

  #wlurOverlayPass: WlurOverlayPass | null = null;

  #entityDrawItemPreparer: EntityDrawItemPreparer | null = null;
  #entityTexturePipeline: EntityTexturePipeline | null = null;

  // Export service for rendering entities to blobs/bitmaps
  #exportService: ExportService | null = null;

  // Frame stats for performance overlay
  #lastRenderTime = 0;
  #lastEntityCount = 0;
  #lastRenderedCount = 0;
  #hasLastLodViewport = false;
  #lastLodOffsetX = 0;
  #lastLodOffsetY = 0;
  #lastLodZoom = 0;
  #lodStableFrames = 0;
  readonly #visibilityViewportBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #visibilityEntityBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  get isReady(): boolean {
    return this.#device !== null && this.#gridPass !== null;
  }

  get colorConfig(): GpuColorConfig {
    return this.#colorConfig;
  }

  get device(): GPUDevice | null {
    return this.#device;
  }

  isEntityVisible(entity: ShaderCanvasEntity, viewport: Viewport): boolean {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(this.#cachedCanvasWidth * dpr);
    const height = Math.floor(this.#cachedCanvasHeight * dpr);
    if (width <= 0 || height <= 0) return true;

    return boundsIntersect(
      getRotatedAABB(entity.position, entity.size, entity.rotation, this.#visibilityEntityBounds),
      getViewportWorldBounds(
        viewport,
        width,
        height,
        config.canvas.cullingBufferFraction,
        this.#visibilityViewportBounds,
      ),
    );
  }

  getFrameStats() {
    return {
      renderTime: this.#lastRenderTime,
      entityCount: this.#lastEntityCount,
      renderedCount: this.#lastRenderedCount,
    };
  }

  /** Snapshot of GPU texture residency and cumulative allocation churn. */
  getResourceStats(): RendererResourceStats {
    return {
      entityTextures: this.#entityTexturePipeline?.getResidencyStats() ?? {
        budgetBytes: config.rendering.entityTextureBudgetBytes,
        residentBytes: 0,
        sourceBytes: 0,
        processedBytes: 0,
        sourceTextureCount: 0,
        processedTextureCount: 0,
        sourceTextureAllocations: 0,
        processedTextureAllocations: 0,
        sourceUploads: 0,
        evictions: 0,
      },
      processingTextures:
        this.#entityTexturePipeline?.processingPipeline.getTextureCacheStats() ?? {
          budgetBytes: config.rendering.processingTextureBudgetBytes,
          residentBytes: 0,
          entryCount: 0,
          evictions: 0,
        },
      texturePool: this.#texturePool?.getStats() ?? {
        budgetBytes: config.rendering.texturePoolBudgetBytes,
        residentBytes: 0,
        textureCount: 0,
      },
    };
  }

  hasPendingRenderWork(): boolean {
    return this.#entityTexturePipeline?.hasPendingLodWork ?? false;
  }

  async initialize(): Promise<void> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) {
      throw new Error("WebGPU adapter not available");
    }

    // Request higher storage buffer limit for large images (error diffusion dithering)
    // The error buffer needs width × height × 4 floats × 4 bytes per pixel
    // For a 4K image (3840×2160), that's ~132 MB, exceeding the default 128 MB limit
    const adapterLimits = adapter.limits;
    const requiredLimits: Record<string, number> = {};

    if (adapterLimits.maxStorageBufferBindingSize > config.rendering.maxStorageBufferSizeBytes) {
      requiredLimits.maxStorageBufferBindingSize = adapterLimits.maxStorageBufferBindingSize;
    }

    // Request higher buffer size limit for very large images (error diffusion dithering)
    // Default maxBufferSize is 256MB, but large images can need more
    if (adapterLimits.maxBufferSize > 268435456) {
      requiredLimits.maxBufferSize = adapterLimits.maxBufferSize;
    }

    this.#device = await adapter.requestDevice({ requiredLimits });

    this.#device.lost.then((info) => {
      logger.error(`[WebGPU] Device lost: ${info.reason}`, info.message);
      this.onDeviceLost?.(info.reason);
    });

    this.#device.addEventListener("uncapturederror", (event) => {
      logger.warn("[WebGPU] Uncaptured error:", (event as GPUUncapturedErrorEvent).error);
    });

    this.#context = this.canvas.getContext("webgpu");
    if (!this.#context) {
      throw new Error("WebGPU context not available");
    }

    // Detect GPU color space capability and set module-level flag for color-utils
    this.#colorConfig = detectGpuColorConfig(this.#device);
    setGpuContext(this.#device, this.#colorConfig.canvasFormat, this.#colorConfig.canvasColorSpace);

    this.#canvasFormat = this.#colorConfig.canvasFormat;
    this.#context.configure({
      device: this.#device,
      format: this.#canvasFormat,
      colorSpace: this.#colorConfig.canvasColorSpace,
      alphaMode: "premultiplied",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING,
    });

    // Initialize texture pool
    this.#texturePool = new TexturePool(this.#device, this.#colorConfig.intermediateFormat);

    this.#gridPass = new GridPass(this.#device, this.#canvasFormat);
    this.#viewportUniforms = new ViewportUniforms(this.#device);
    this.#compositionPass = new CompositionPass({
      device: this.#device,
      format: this.#canvasFormat,
      viewportUniformBuffer: this.#viewportUniforms.buffer,
    });
    this.#externalTextureCopyPass = new ExternalTextureCopyPass(
      this.#device,
      this.#colorConfig.intermediateFormat,
    );
    this.#entityTexturePipeline = new EntityTexturePipeline({
      device: this.#device,
      colorConfig: this.#colorConfig,
      texturePool: this.#texturePool,
      onEntityError: (entityId, error) => {
        if (!this.#entityErrors.has(entityId)) {
          this.#entityErrors.set(entityId, error);
          this.onEntityError?.(entityId, error);
        }
      },
    });
    await this.#entityTexturePipeline.initialize();
    this.#entityDrawItemPreparer = new EntityDrawItemPreparer({
      texturePipeline: this.#entityTexturePipeline,
      compositionPass: this.#compositionPass,
    });

    this.#selectionRectPass = new SelectionRectPass(this.#device, this.#canvasFormat);
    this.#actionLayerBlurPass = new ActionLayerBlurPass({
      device: this.#device,
      canvasFormat: this.#canvasFormat,
      intermediateFormat: this.#colorConfig.intermediateFormat,
      tintColor: config.actionLayer.dimColor.dark,
    });
    this.#viewportLensPass = new ViewportLensPass({
      device: this.#device,
      format: this.#canvasFormat,
      initialConfig: getViewportLensDistortionConfig(CanvasLensing.off),
    });
    this.#wlurOverlayPass = new WlurOverlayPass({
      device: this.#device,
      canvasFormat: this.#canvasFormat,
      intermediateFormat: this.#colorConfig.intermediateFormat,
    });

    // Initialize export service with callbacks into renderer
    this.#exportService = new ExportService(
      this.#device,
      this.#texturePool,
      (entity, source, output) =>
        this.#entityTexturePipeline!.applyShaderToTexture(entity, source, output),
      this.#colorConfig,
    );

    this.#disintegrationPass = new DisintegrationPass({
      device: this.#device,
      canvasFormat: this.#canvasFormat,
      viewportUniformBuffer: this.#viewportUniforms.buffer,
      compositionPass: this.#compositionPass,
    });
    await this.#disintegrationPass.initialize();

    // Initialize entity label pass
    this.#entityLabelPass = new EntityLabelPass(
      this.#device,
      this.#canvasFormat,
      this.#viewportUniforms.buffer,
    );
    this.#entityLabelPass.initialize();

    this.#canvasCalloutPass = new CanvasCalloutPass(
      this.#device,
      this.#canvasFormat,
      this.#viewportUniforms.buffer,
    );
    this.#canvasCalloutPass.initialize();

    // Set up ResizeObserver to cache canvas dimensions (avoids getBoundingClientRect in render loop)
    this.#resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // Use contentBoxSize for accurate dimensions (fallback to contentRect)
        let width: number, height: number;
        if (entry.contentBoxSize && entry.contentBoxSize[0]) {
          width = entry.contentBoxSize[0].inlineSize;
          height = entry.contentBoxSize[0].blockSize;
        } else {
          width = entry.contentRect.width;
          height = entry.contentRect.height;
        }
        // Guard against 0-size dimensions (can occur during DevTools inspection)
        if (width > 0 && height > 0) {
          this.#cachedCanvasWidth = width;
          this.#cachedCanvasHeight = height;
        }
      }
    });
    this.#resizeObserver.observe(this.canvas);

    // Initialize cached dimensions
    const initialRect = this.canvas.getBoundingClientRect();
    this.#cachedCanvasWidth = initialRect.width;
    this.#cachedCanvasHeight = initialRect.height;
  }

  #drawCompositionItems(
    pass: GPURenderPassEncoder,
    items: readonly CompositionDrawItem[],
    selectedEntityCount: number,
  ): void {
    const labelPass = selectedEntityCount === 1 ? this.#entityLabelPass : null;
    this.#compositionPass!.drawItems(
      pass,
      items,
      labelPass
        ? (item) => labelPass.drawLabel(pass, item.entity, item.offsetX, item.offsetY)
        : undefined,
    );
  }

  /**
   * Render an entity's image through its shader to a texture.
   * Returns the texture, caching it for future frames.
   */
  renderEntityToTexture(
    entity: ShaderCanvasEntity,
    encoder: GPUCommandEncoder,
  ): EntityCompositionSource | null {
    return this.#entityTexturePipeline?.renderEntityToTexture(entity, encoder) ?? null;
  }

  /**
   * Main render function - renders the entire canvas.
   * Optimized to batch all render passes into a single GPU submission.
   */
  render(state: RenderState): void {
    if (
      !this.#device ||
      !this.#context ||
      !this.#gridPass ||
      !this.#compositionPass ||
      !this.#viewportUniforms ||
      !this.#entityDrawItemPreparer
    ) {
      return;
    }

    const renderStart = performance.now();
    const frameDt = this.#lastFrameTime > 0 ? (renderStart - this.#lastFrameTime) / 1000 : 1 / 60;
    this.#lastFrameTime = renderStart;
    const { entities, viewport, hoveredEntityId, selectedEntityIds, debugMode } = state;

    // Update canvas size if needed (uses cached dimensions from ResizeObserver)
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(this.#cachedCanvasWidth * dpr);
    const height = Math.floor(this.#cachedCanvasHeight * dpr);

    // Skip entire render if cached dimensions are invalid
    if (width <= 0 || height <= 0) {
      return;
    }

    // Update canvas dimensions if changed
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.#viewportUniforms.update(viewport, width, height);
    const viewportChanged =
      !this.#hasLastLodViewport ||
      this.#lastLodZoom !== viewport.zoom ||
      this.#lastLodOffsetX !== viewport.offset.x ||
      this.#lastLodOffsetY !== viewport.offset.y;
    this.#lodStableFrames = viewportChanged ? 0 : this.#lodStableFrames + 1;
    this.#hasLastLodViewport = true;
    this.#lastLodOffsetX = viewport.offset.x;
    this.#lastLodOffsetY = viewport.offset.y;
    this.#lastLodZoom = viewport.zoom;
    this.#entityTexturePipeline?.beginFrame(
      this.#lodStableFrames >= config.rendering.lodSettleFrames,
    );

    // Entity preprocessing can encode shader passes into this same command buffer.
    // External video textures must be imported, bound, encoded, finished, and submitted
    // inside the current render task.
    const encoder = this.#device.createCommandEncoder({
      label: "Canvas render encoder",
    });

    // Pre-process entities: render to textures and prepare bind groups
    // Uses caching to avoid per-frame allocations
    const preparedEntityDrawItems = this.#entityDrawItemPreparer.prepare({
      entities,
      viewport,
      width,
      height,
      devicePixelRatio: dpr,
      encoder,
      hoveredEntityId,
      selectedEntityIds,
      actionLayer: state.actionLayer,
      dragVisual: state.dragVisual,
      debugMode,
    });
    const { entityDrawItems, actionLayerDrawItems } = preparedEntityDrawItems;
    let hasAnimatingContent = preparedEntityDrawItems.hasAnimatingContent;
    this.#compositionPass.beginFrame(entityDrawItems.length + actionLayerDrawItems.length);

    const texture = this.#context.getCurrentTexture();
    // Skip render if swapchain texture is invalid
    if (texture.width === 0 || texture.height === 0) {
      this.#entityTexturePipeline?.flushTextureReleases();
      return;
    }
    const targetView = texture.createView();
    const viewportLensTarget = this.#viewportLensPass?.getTarget(width, height) ?? null;
    const sceneTargetTexture = viewportLensTarget?.texture ?? texture;
    const sceneTargetView = viewportLensTarget?.view ?? targetView;

    // Pass 1: Render dot grid background
    this.#gridPass.encode({ encoder, targetView: sceneTargetView, viewport, width, height });

    // Pass 2: Render all entities with interleaved labels (z-ordered)
    // Update label animation state once per frame
    this.#entityLabelPass?.beginFrame(viewport, width, height, state.dragVisual.isDragPhase);
    const selectedEntityCount = selectedEntityIds.size;
    const entityPass = encoder.beginRenderPass({
      label: "Entity composition pass",
      colorAttachments: [
        {
          view: sceneTargetView,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    this.#drawCompositionItems(entityPass, entityDrawItems, selectedEntityCount);
    entityPass.end();

    // Evict label caches for deselected entities
    this.#entityLabelPass?.endFrame(selectedEntityIds);
    if (this.#entityLabelPass?.isAnimating) hasAnimatingContent = true;

    // Pass 2a: Action layer blur overlay
    // Blur+dim everything, then re-render selected entities sharp on top
    const blurIntensity = state.actionLayer.blurIntensity;
    if (
      blurIntensity > 0.01 &&
      this.#canvasFormat === this.#colorConfig.intermediateFormat &&
      this.#entityTexturePipeline &&
      this.#actionLayerBlurPass
    ) {
      this.#actionLayerBlurPass.encode({
        encoder,
        processingPipeline: this.#entityTexturePipeline.processingPipeline,
        sourceTexture: sceneTargetTexture,
        targetView: sceneTargetView,
        width,
        height,
        blurIntensity,
        contentDirty: state.dirty || hasAnimatingContent,
      });
    }

    // Reset blur cache when action layer blur is no longer rendering
    if (blurIntensity <= 0.01) {
      this.#actionLayerBlurPass?.invalidateCache();
    }

    // Always render action layer entities on top (sharp, after blur or normally)
    if (actionLayerDrawItems.length > 0) {
      const sharpPass = encoder.beginRenderPass({
        label: "Action layer sharp entity pass",
        colorAttachments: [
          {
            view: sceneTargetView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      this.#drawCompositionItems(sharpPass, actionLayerDrawItems, selectedEntityCount);
      sharpPass.end();
    }

    if (state.canvasCallouts.length > 0 && this.#canvasCalloutPass) {
      this.#canvasCalloutPass.beginFrame(viewport, width);
      const calloutPass = encoder.beginRenderPass({
        label: "Canvas callout pass",
        colorAttachments: [
          {
            view: sceneTargetView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      this.#canvasCalloutPass.drawCallouts(
        calloutPass,
        state.canvasCallouts,
        new Map(entities.map((entity) => [entity.id, entity])),
      );
      calloutPass.end();
    }

    // Pass 2b: Render disintegration overlays (on top of entities)
    this.#disintegrationPass?.encode(
      encoder,
      sceneTargetView,
      frameDt,
      state.disintegration.overlays,
    );

    // Pass 3: Render all selection rectangles (drag-select and multi-select bounds)
    if ((state.dragSelectBounds || state.multiSelectBounds) && this.#selectionRectPass) {
      this.#selectionRectPass.encode({
        encoder,
        targetView: sceneTargetView,
        viewport,
        width,
        height,
        dragSelectBounds: state.dragSelectBounds,
        multiSelectBounds: state.multiSelectBounds,
      });
    }

    const lensApplied = viewportLensTarget
      ? this.#viewportLensPass!.encode(encoder, targetView, width, height)
      : false;

    // Final pass: WLUR progressive blur overlay (renders on top of everything)
    if (this.#wlurOverlayPass) {
      this.#wlurOverlayPass.encode({
        encoder,
        sourceTexture: texture,
        targetTexture: texture,
        targetView,
        width,
        height,
        devicePixelRatio: dpr,
        contentDirty:
          state.dirty ||
          hasAnimatingContent ||
          lensApplied ||
          !!this.#disintegrationPass?.hasOverlays ||
          blurIntensity > 0.01 ||
          state.dragSelectBounds !== null,
      });
    }

    // Single submission for all passes
    this.#device.queue.submit([encoder.finish()]);
    this.#entityTexturePipeline?.flushTextureReleases();
    this.#entityTexturePipeline?.endFrame();

    // Record frame stats for performance overlay
    this.#lastRenderTime = performance.now() - renderStart;
    this.#lastEntityCount = entities.length;
    this.#lastRenderedCount = entityDrawItems.length;

    // Advance texture pool frame counter and cleanup stale textures
    this.#texturePool?.nextFrame();
  }

  /**
   * Update grid configuration
   */
  setGridConfig(config: Partial<GridConfig>): void {
    this.#gridPass?.setConfig(config);
    this.#wlurOverlayPass?.invalidateCache();
  }

  setActionLayerTint(color: [number, number, number]): void {
    this.#actionLayerBlurPass?.setTint(color);
  }

  setSelectionRectConfig(
    selectionRect: typeof config.selectionRectangle.light,
    multiSelectBox: typeof config.multiSelectBoundingBox.light,
  ): void {
    this.#selectionRectPass?.setConfig(selectionRect, multiSelectBox);
  }

  setWlurOverlay(config: WlurOverlayConfig | null): void {
    this.#wlurOverlayPass?.setConfig(config);
  }

  setViewportLensDistortion(config: ViewportLensDistortionConfig): void {
    this.#viewportLensPass?.setConfig(config);
    this.#wlurOverlayPass?.invalidateCache();
  }

  setViewportLensColorScheme(isDark: boolean): void {
    if (this.#viewportLensPass?.setColorScheme(isDark)) {
      this.#wlurOverlayPass?.invalidateCache();
    }
  }

  get viewPortLensConfig(): ViewportLensDistortionConfig {
    return this.#viewportLensPass?.config ?? getViewportLensDistortionConfig(CanvasLensing.off);
  }

  /**
   * Remove cached resources for an entity
   */
  removeEntityTexture(entityId: string): void {
    this.#entityTexturePipeline?.removeEntity(entityId);
    this.#compositionPass?.removeEntity(entityId);

    // Clear any errors for this entity
    this.#entityErrors.delete(entityId);
  }

  /**
   * Snapshot an entity's rendered texture and create a disintegration overlay.
   * Called before removeEntityTexture — copies the GPU texture so the entity
   * can be removed immediately while the dust animation plays independently.
   */
  #copyCurrentVideoFrameToTexture(entity: ShaderCanvasEntity, label: string): GPUTexture | null {
    if (!this.#device || !this.#externalTextureCopyPass || entity.mediaSource.type !== "video") {
      return null;
    }

    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const texture = this.#device.createTexture({
      label,
      size: [width, height],
      format: this.#colorConfig.intermediateFormat,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
    });
    const externalTexture = this.#device.importExternalTexture({
      source: entity.mediaSource.videoElement,
      colorSpace: this.#colorConfig.textureColorSpace,
    });
    const encoder = this.#device.createCommandEncoder({ label: `${label} encoder` });
    this.#externalTextureCopyPass.encode(encoder, externalTexture, texture);
    this.#device.queue.submit([encoder.finish()]);
    return texture;
  }

  #createDisintegrationSnapshot(entity: ShaderCanvasEntity): GPUTexture | null {
    if (!this.#device) return null;
    const entityId = entity.id;

    const renderedTexture = this.#entityTexturePipeline?.getProcessedEntityTexture(entityId);
    if (renderedTexture) {
      const snapshotTexture = this.#device.createTexture({
        label: `Disintegration snapshot ${entityId}`,
        size: [renderedTexture.width, renderedTexture.height],
        format: renderedTexture.format,
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      const encoder = this.#device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture: renderedTexture }, { texture: snapshotTexture }, [
        renderedTexture.width,
        renderedTexture.height,
      ]);
      this.#device.queue.submit([encoder.finish()]);
      return snapshotTexture;
    }

    let sourceTexture = this.#entityTexturePipeline?.getSourceEntityTexture(entityId) ?? null;
    if (!sourceTexture && entity.mediaSource.type === "video") {
      return this.#copyCurrentVideoFrameToTexture(
        entity,
        `Disintegration video snapshot ${entityId}`,
      );
    }
    if (!sourceTexture || !this.#entityTexturePipeline) return null;

    const snapshotTexture = this.#device.createTexture({
      label: `Disintegration snapshot ${entityId}`,
      size: [sourceTexture.width, sourceTexture.height],
      format: this.#colorConfig.intermediateFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const encoder = this.#device.createCommandEncoder();
    this.#entityTexturePipeline.passthroughCopyPass.encode(encoder, sourceTexture, snapshotTexture);
    this.#device.queue.submit([encoder.finish()]);
    return snapshotTexture;
  }

  startDisintegration(entity: ShaderCanvasEntity, overlay: DisintegrationRenderOverlay): boolean {
    if (!this.#device || !this.#disintegrationPass) return false;

    const snapshotTexture = this.#createDisintegrationSnapshot(entity);
    if (!snapshotTexture) return false;

    this.#disintegrationPass.start(entity, snapshotTexture, overlay);
    return true;
  }

  /**
   * Cancel a disintegration overlay (e.g., on undo when entity is restored).
   */
  cancelDisintegration(id: string): void {
    this.#disintegrationPass?.cancel(id);
  }

  /**
   * Check if an entity has a rendering error
   */
  hasEntityError(entityId: string): boolean {
    return this.#entityErrors.has(entityId);
  }

  /**
   * Get the error message for an entity, if any
   */
  getEntityError(entityId: string): string | undefined {
    return this.#entityErrors.get(entityId);
  }

  /**
   * Clear an entity's error state (e.g., when retrying)
   */
  clearEntityError(entityId: string): void {
    this.#entityErrors.delete(entityId);
  }

  /**
   * Wait for all submitted GPU work to complete
   */
  async waitForGPU(): Promise<void> {
    await this.#device?.queue.onSubmittedWorkDone();
  }

  /**
   * Render a decoded frame through shaders.
   * Used by export and upscale pipelines with WebCodecs-decoded frames.
   */
  async renderFrameWithShader(
    entity: ShaderCanvasEntity,
    frameSource: ImageBitmap | OffscreenCanvas,
    width: number,
    height: number,
  ): Promise<ImageBitmap | null> {
    return this.#exportService!.renderFrameWithShader(entity, frameSource, width, height);
  }

  /**
   * Render a GIF entity's frame at a specific timestamp through shaders.
   * Delegates to ExportService.
   */
  async renderGifFrameAtTime(
    entity: ShaderCanvasEntity,
    timestampSeconds: number,
  ): Promise<ImageBitmap | null> {
    return this.#exportService!.renderGifFrameAtTime(entity, timestampSeconds);
  }

  /**
   * Render an entity to a Blob for export/clipboard.
   * Uses only the exact GPU texture currently used for canvas composition, so
   * static entities, animated media, and time-animated shaders all export the
   * visible frame.
   */
  async renderEntityToBlob(
    entity: ShaderCanvasEntity,
    options?: ImageExportOptions,
  ): Promise<Blob | null> {
    const exportSource = this.#getNativeExportSource(entity);
    if (!exportSource || !this.#exportService) return null;

    return this.#exportService.renderSourceToBlob(
      entity,
      exportSource,
      entity.originalSize.width,
      entity.originalSize.height,
      options,
    );
  }

  #getNativeExportSource(
    entity: ShaderCanvasEntity,
  ): ImageBitmap | OffscreenCanvas | HTMLCanvasElement | HTMLVideoElement | null {
    switch (entity.mediaSource.type) {
      case MediaType.image:
        return entity.mediaSource.asset.imageBitmap;
      case MediaType.gif:
        return getFrameAtTime(
          entity.mediaSource.frames,
          entity.playback?.currentTime ?? 0,
          entity.playback?.loop ?? true,
        ).bitmap;
      case MediaType.svg:
        return entity.imageBitmap;
      case MediaType.video:
        return entity.mediaSource.videoElement;
    }
  }

  /** Whether a shader needs continuous re-rendering for the given entity (e.g., time-based animation). */
  needsContinuousRenderForEntity(entity: ShaderCanvasEntity): boolean {
    return this.#entityTexturePipeline?.needsContinuousRenderForEntity(entity) ?? false;
  }

  // ── Per-entity time control ─────────────────────────────────────────

  /** Set the shader time for an entity (used by the time slider). Mutates in-place. */
  setEntityTime(entity: ShaderCanvasEntity, time: number): void {
    entity.shaderParams.time = time;
  }

  /** Get the current shader time for an entity. */
  getEntityTime(entity: ShaderCanvasEntity): number {
    return entity.shaderParams.time ?? 0;
  }

  /** Set whether time auto-increments for an entity. Mutates in-place. */
  setEntityTimeAutoPlay(entity: ShaderCanvasEntity, playing: boolean): void {
    entity.shaderParams.timeAutoPlay = playing;
    // Reset delta tracking when pausing so we don't get a jump on resume
    if (!playing) {
      this.#entityTexturePipeline?.removeGlassEntity(entity.id);
    }
  }

  /** Whether time auto-increments for an entity. */
  getEntityTimeAutoPlay(entity: ShaderCanvasEntity): boolean {
    return entity.shaderParams.timeAutoPlay !== false;
  }

  destroy(): void {
    this.#entityDrawItemPreparer = null;
    this.#entityTexturePipeline?.destroy();
    this.#entityTexturePipeline = null;
    this.#compositionPass?.destroy();
    this.#compositionPass = null;

    this.#disintegrationPass?.destroy();
    this.#disintegrationPass = null;

    // Destroy entity label pass
    this.#entityLabelPass?.destroy();
    this.#entityLabelPass = null;
    this.#canvasCalloutPass?.destroy();
    this.#canvasCalloutPass = null;

    this.#wlurOverlayPass?.destroy();
    this.#wlurOverlayPass = null;

    this.#viewportLensPass?.destroy();
    this.#viewportLensPass = null;

    // Destroy export service
    this.#exportService = null;

    // Destroy texture pool
    this.#texturePool?.destroy();
    this.#texturePool = null;

    this.#actionLayerBlurPass?.destroy();
    this.#actionLayerBlurPass = null;

    this.#gridPass?.destroy();
    this.#gridPass = null;

    this.#viewportUniforms?.destroy();
    this.#viewportUniforms = null;

    this.#selectionRectPass?.destroy();
    this.#selectionRectPass = null;

    // Clear entity errors
    this.#entityErrors.clear();

    // Disconnect resize observer
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;

    // Destroy device
    this.#device?.destroy();

    // Clear references
    this.#externalTextureCopyPass = null;
    this.#context = null;
    this.#device = null;
  }
}
