import { config, type GridConfig } from "#config";
import { logger } from "#lib/client.logger.ts";
import { WlurPass } from "#wlur";
import { setGpuContext } from "./gpu-color-space.ts";
import type { RenderState } from "../engine/canvas-store.ts";
import { actionLayerController } from "../engine/action-layer-controller.ts";
import { disintegrationController } from "../engine/disintegration-controller.ts";
import { entityDragVisual } from "../engine/entity-drag-visual.ts";
import {
  boundsIntersect,
  calculateGridLevel,
  getRotatedAABB,
  getViewportMatrix,
  getViewportWorldBounds,
} from "../lib/canvas-math.ts";
import {
  type Bounds,
  type RGBA,
  type ShaderCanvasEntity,
  type ShaderParams,
  type Viewport,
} from "#types/canvas.ts";
import compositionShaderSource from "./composition.wgsl?raw";
import { CopyPass } from "./copy-pass.ts";
import { DisintegrationParticleSystem } from "./disintegration-particles.ts";
import dotGridShaderSource from "./dot-grid.wgsl?raw";
import type { EffectRenderEntity } from "./effect-render-entity.ts";
import { EntityShaderRuntime } from "./entity-shader-runtime.ts";
import { ExportService } from "./export-service.ts";
import { detectGpuColorConfig, type GpuColorConfig } from "./gpu-color-space.ts";
import selectionRectShaderSource from "./selection-rect.wgsl?raw";
import { CanvasCalloutPass } from "./canvas-callout-pass.ts";
import { EntityLabelPass } from "./entity-label-pass.ts";
import { TexturePool } from "./texture-pool.ts";
import {
  blockVideoPreviewFrameGovernorUpgrades,
  createVideoPreviewFrameGovernorState,
  createVideoPreviewAdaptiveState,
  recordVideoPreviewFrameGovernorSample,
  recordVideoPreviewRenderSample,
  resolveVideoPreviewResolution,
  type PreviewResolution,
  type VideoPreviewAdaptiveState,
  type VideoPreviewFrameGovernorState,
  type VideoPreviewGovernorEntity,
  type VideoPreviewQualityTransition,
} from "./video-preview-resolution.ts";
import { resolveWlurOverlayRuntimeConfig, type WlurOverlayConfig } from "./wlur-overlay.ts";
import actionLayerBlitShaderSource from "./action-layer-blit.wgsl?raw";

interface CompositionDrawItem {
  bindGroup: GPUBindGroup;
  entity: ShaderCanvasEntity;
  isSelected: boolean;
  offsetX: number;
  offsetY: number;
}

interface EntityTextureRenderResult {
  texture: GPUTexture;
  changed: boolean;
}

export class InfiniteCanvasRenderer {
  readonly canvas: HTMLCanvasElement;

  #device: GPUDevice | null = null;
  #context: GPUCanvasContext | null = null;
  #canvasFormat!: GPUTextureFormat;
  #colorConfig!: GpuColorConfig;

  // Dot grid pipeline
  #gridPipeline: GPURenderPipeline | null = null;
  #gridUniformBuffer: GPUBuffer | null = null;
  #gridBindGroup: GPUBindGroup | null = null;
  #gridUniformData = new ArrayBuffer(config.rendering.gridUniformSize);
  #gridFloatView = new Float32Array(this.#gridUniformData);

  // Composition pipeline
  #compositionPipeline: GPURenderPipeline | null = null;
  #viewportUniformBuffer: GPUBuffer | null = null;
  #entityUniformBuffer: GPUBuffer | null = null;
  #compositionSampler: GPUSampler | null = null;
  #compositionBindGroupLayout: GPUBindGroupLayout | null = null;
  #viewportUniformData = new ArrayBuffer(config.rendering.viewportUniformSize);
  #viewportFloatView = new Float32Array(this.#viewportUniformData);
  #entityUniformData = new ArrayBuffer(config.rendering.entityUniformSize);
  #entityFloatView = new Float32Array(this.#entityUniformData);
  #entityUintView = new Uint32Array(this.#entityUniformData);

  // Entity error tracking (entityId -> error message)
  #entityErrors: Map<string, string> = new Map();
  // Callback for error notifications (e.g., to show toast)
  onEntityError?: (entityId: string, error: string) => void;
  // Callback for GPU device lost events
  onDeviceLost?: (reason: string) => void;

  // Entity texture cache
  #entityTextures: Map<string, GPUTexture> = new Map();

  // Cached source textures per entity (avoids re-uploading unchanged images to GPU)
  #entitySourceTextures: Map<
    string,
    {
      texture: GPUTexture;
      sourceRef: HTMLVideoElement | ImageBitmap | OffscreenCanvas;
      width: number;
      height: number;
    }
  > = new Map();
  #videoPreviewAdaptiveStates: Map<string, VideoPreviewAdaptiveState> = new Map();
  #videoPreviewFrameGovernor: VideoPreviewFrameGovernorState =
    createVideoPreviewFrameGovernorState();

  // Entity composition cache (uniform buffers, bind groups, texture views)
  // These are invalidated when entity texture changes
  #entityCompositionCache: Map<
    string,
    {
      uniformBuffer: GPUBuffer;
      textureView: GPUTextureView;
      bindGroup: GPUBindGroup;
      lastHovered: boolean;
      lastSelected: boolean;
      lastDebugMode: boolean;
    }
  > = new Map();

  #gridConfig: GridConfig = config.rendering.grid.default;
  #actionLayerTintColor: [number, number, number] = config.actionLayer.dimColor.dark;
  #selectionRectConfig = config.selectionRectangle.light;
  #multiSelectBoundingBoxConfig = config.multiSelectBoundingBox.light;

  // Texture pool for eliminating per-frame allocation churn
  #texturePool: TexturePool | null = null;

  // Reusable canvas for Firefox-compatible video frame upload
  #videoUploadCanvas: OffscreenCanvas | null = null;
  #videoUploadCtx: OffscreenCanvasRenderingContext2D | null = null;
  #directVideoUploadSupported: boolean | null = null;

  // Disintegration particle system (GPU compute + instanced rendering)
  #particleSystem: DisintegrationParticleSystem | null = null;

  // Entity label pass (Canvas 2D rasterized → GPU textured quad)
  #entityLabelPass: EntityLabelPass | null = null;
  #canvasCalloutPass: CanvasCalloutPass | null = null;

  // Disintegration overlays — GPU resources for fire-and-forget dust animations
  #disintegrationOverlays: Map<
    string,
    {
      texture: GPUTexture;
      textureView: GPUTextureView;
      uniformBuffer: GPUBuffer;
      bindGroup: GPUBindGroup;
    }
  > = new Map();

  // Cached canvas dimensions (updated by ResizeObserver, avoids getBoundingClientRect in render loop)
  #cachedCanvasWidth = 0;
  #cachedCanvasHeight = 0;
  #lastFrameTime = 0;
  #resizeObserver: ResizeObserver | null = null;

  // Selection rectangle pipeline (for drag-to-select)
  #selectionRectPipeline: GPURenderPipeline | null = null;
  #selectionRectUniformBuffer: GPUBuffer | null = null;
  #selectionRectBindGroup: GPUBindGroup | null = null;
  // New uniform layout supporting up to 4 rectangles:
  // resolution(8) + offset(8) + zoom(4) + rectCount(4) + padding(8) = 32 bytes header
  // + 4 * RectData(64 bytes each) = 256 bytes
  // Total = 288 bytes
  #selectionRectUniformSize = 288;
  #selectionRectUniformData = new ArrayBuffer(288);
  #selectionRectFloatView = new Float32Array(this.#selectionRectUniformData);

  // Action layer blit pipeline (fullscreen dimmed blit for blur overlay)
  #actionLayerBlitPipeline: GPURenderPipeline | null = null;
  #actionLayerBlitBindGroupLayout: GPUBindGroupLayout | null = null;
  #actionLayerBlitUniformBuffer: GPUBuffer | null = null;
  #actionLayerBlitSampler: GPUSampler | null = null;
  // Cached intermediate textures for full-screen blur (keyed by "WxH")
  #actionLayerBlurTextures: {
    width: number;
    height: number;
    input: GPUTexture;
    output: GPUTexture;
  } | null = null;
  // Blur result caching: skip re-running Kawase when content hasn't changed
  #actionLayerBlurCacheValid = false;
  #actionLayerBlitBindGroupCached: GPUBindGroup | null = null;

  #presentCopyPass: CopyPass | null = null;

  // Wlur progressive full-canvas overlay
  #wlurPass: WlurPass | null = null;
  #wlurOverlayConfig: WlurOverlayConfig | null = null;
  #wlurOverlayTextures: {
    width: number;
    height: number;
    input: GPUTexture;
    output: GPUTexture;
  } | null = null;
  #wlurOverlayCacheValid = false;
  #wlurOverlayCacheKey = "";
  #wlurLastQualityKey = "";

  #entityShaderRuntime: EntityShaderRuntime | null = null;

  // Export service for rendering entities to blobs/bitmaps
  #exportService: ExportService | null = null;

  // Frame stats for performance overlay
  #lastRenderTime = 0;
  #lastEntityCount = 0;
  #lastRenderedCount = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  get isReady(): boolean {
    return this.#device !== null && this.#gridPipeline !== null;
  }

  get colorConfig(): GpuColorConfig {
    return this.#colorConfig;
  }

  get device(): GPUDevice | null {
    return this.#device;
  }

  getFrameStats() {
    return {
      renderTime: this.#lastRenderTime,
      entityCount: this.#lastEntityCount,
      renderedCount: this.#lastRenderedCount,
    };
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

    this.#createGridPipeline();
    this.#createCompositionPipeline();
    this.#entityShaderRuntime = new EntityShaderRuntime({
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
    await this.#entityShaderRuntime.initialize();

    this.#createSelectionRectPipeline();
    this.#createActionLayerBlitPipeline();
    this.#presentCopyPass = new CopyPass(this.#device, this.#canvasFormat);
    this.#wlurPass = new WlurPass({
      device: this.#device,
      format: this.#colorConfig.intermediateFormat,
      label: "Wlur",
    });
    this.#wlurPass.initialize();

    // Initialize export service with callbacks into renderer
    this.#exportService = new ExportService(
      this.#device,
      this.#texturePool,
      (entity, source, output) => this.#applyShaderToTexture(entity, source, output),
      this.#colorConfig,
    );

    // Initialize disintegration particle system
    this.#particleSystem = new DisintegrationParticleSystem(this.#device);
    await this.#particleSystem.initialize(this.#canvasFormat, this.#viewportUniformBuffer!);

    // Initialize entity label pass
    this.#entityLabelPass = new EntityLabelPass(
      this.#device,
      this.#canvasFormat,
      this.#viewportUniformBuffer!,
    );
    this.#entityLabelPass.initialize();

    this.#canvasCalloutPass = new CanvasCalloutPass(
      this.#device,
      this.#canvasFormat,
      this.#viewportUniformBuffer!,
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

  #createGridPipeline(): void {
    if (!this.#device) return;

    const shaderModule = this.#device.createShaderModule({
      label: "Dot grid shader",
      code: dotGridShaderSource,
    });

    const bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Grid bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.#gridUniformBuffer = this.#device.createBuffer({
      label: "Grid uniforms",
      size: config.rendering.gridUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#gridBindGroup = this.#device.createBindGroup({
      label: "Grid bind group",
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.#gridUniformBuffer } }],
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Grid pipeline layout",
      bindGroupLayouts: [bindGroupLayout],
    });

    this.#gridPipeline = this.#device.createRenderPipeline({
      label: "Grid pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#canvasFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  #createCompositionPipeline(): void {
    if (!this.#device) return;

    const shaderModule = this.#device.createShaderModule({
      label: "Composition shader",
      code: compositionShaderSource,
    });

    this.#compositionBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Composition bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.#viewportUniformBuffer = this.#device.createBuffer({
      label: "Viewport uniforms",
      size: config.rendering.viewportUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#entityUniformBuffer = this.#device.createBuffer({
      label: "Entity uniforms",
      size: config.rendering.entityUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#compositionSampler = this.#device.createSampler({
      label: "Composition sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Composition pipeline layout",
      bindGroupLayouts: [this.#compositionBindGroupLayout],
    });

    this.#compositionPipeline = this.#device.createRenderPipeline({
      label: "Composition pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.#canvasFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  #createSelectionRectPipeline(): void {
    if (!this.#device) return;

    const shaderModule = this.#device.createShaderModule({
      label: "Selection rect shader",
      code: selectionRectShaderSource,
    });

    const bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Selection rect bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.#selectionRectUniformBuffer = this.#device.createBuffer({
      label: "Selection rect uniforms",
      size: this.#selectionRectUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#selectionRectBindGroup = this.#device.createBindGroup({
      label: "Selection rect bind group",
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.#selectionRectUniformBuffer } }],
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Selection rect pipeline layout",
      bindGroupLayouts: [bindGroupLayout],
    });

    this.#selectionRectPipeline = this.#device.createRenderPipeline({
      label: "Selection rect pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.#canvasFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  #getOrCreateActionLayerBlurTextures(
    width: number,
    height: number,
  ): { input: GPUTexture; output: GPUTexture } | null {
    if (!this.#device) return null;

    const cached = this.#actionLayerBlurTextures;
    if (cached && cached.width === width && cached.height === height) {
      return cached;
    }

    // Destroy old textures and invalidate caches
    if (cached) {
      cached.input.destroy();
      cached.output.destroy();
    }
    this.#actionLayerBlurCacheValid = false;
    this.#actionLayerBlitBindGroupCached = null;

    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;

    const input = this.#device.createTexture({
      label: `Action layer blur input (${width}x${height})`,
      size: [width, height],
      format: this.#colorConfig.intermediateFormat,
      usage,
    });

    const output = this.#device.createTexture({
      label: `Action layer blur output (${width}x${height})`,
      size: [width, height],
      format: this.#colorConfig.intermediateFormat,
      usage,
    });

    this.#actionLayerBlurTextures = { width, height, input, output };
    return this.#actionLayerBlurTextures;
  }

  #invalidateWlurOverlayCache(): void {
    this.#wlurOverlayCacheValid = false;
    this.#wlurOverlayCacheKey = "";
  }

  #destroyWlurOverlayTextures(): void {
    if (!this.#wlurOverlayTextures) return;

    this.#wlurOverlayTextures.input.destroy();
    this.#wlurOverlayTextures.output.destroy();
    this.#wlurOverlayTextures = null;
  }

  #getOrCreateWlurOverlayTextures(
    width: number,
    height: number,
  ): { input: GPUTexture; output: GPUTexture } {
    const cached = this.#wlurOverlayTextures;
    if (cached && cached.width === width && cached.height === height) {
      return cached;
    }

    this.#destroyWlurOverlayTextures();
    this.#invalidateWlurOverlayCache();

    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;

    const input = this.#device!.createTexture({
      label: `Wlur input (${width}x${height})`,
      size: [width, height],
      format: this.#colorConfig.intermediateFormat,
      usage,
    });

    const output = this.#device!.createTexture({
      label: `Wlur output (${width}x${height})`,
      size: [width, height],
      format: this.#colorConfig.intermediateFormat,
      usage,
    });

    this.#wlurOverlayTextures = { width, height, input, output };
    return this.#wlurOverlayTextures;
  }

  #buildWlurOverlayCacheKey(
    width: number,
    height: number,
    resolvedConfig: NonNullable<ReturnType<typeof resolveWlurOverlayRuntimeConfig>>,
  ): string {
    const { params, quality } = resolvedConfig;
    return [
      width,
      height,
      quality.kernelSize,
      quality.resolutionScale,
      params.radius,
      params.offset,
      params.interpolation,
      params.direction,
      params.noise,
      params.curve?.join(",") ?? "",
      params.mixCurve?.join(",") ?? "",
      params.tint?.color.join(",") ?? "",
      params.tint?.amount ?? "",
      params.tint?.curve?.join(",") ?? "",
    ].join("|");
  }

  #createActionLayerBlitPipeline(): void {
    if (!this.#device) return;

    const shaderModule = this.#device.createShaderModule({
      label: "Action layer blit shader",
      code: actionLayerBlitShaderSource,
    });

    this.#actionLayerBlitBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Action layer blit bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.#actionLayerBlitUniformBuffer = this.#device.createBuffer({
      label: "Action layer blit uniforms",
      size: 32, // 2x vec4f: tint_amount + blend + pad, tint_color
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#actionLayerBlitSampler = this.#device.createSampler({
      label: "Action layer blit sampler",
      magFilter: "linear",
      minFilter: "linear",
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Action layer blit pipeline layout",
      bindGroupLayouts: [this.#actionLayerBlitBindGroupLayout],
    });

    this.#actionLayerBlitPipeline = this.#device.createRenderPipeline({
      label: "Action layer blit pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.#canvasFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  /** Update selection rectangle uniforms with multiple rectangles */
  #updateSelectionRectUniformsMulti(
    rects: Array<{
      bounds: Bounds;
      config: { borderColor: RGBA; backgroundColor: RGBA; borderWidth: number };
    }>,
    viewport: Viewport,
  ): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const v = this.#selectionRectFloatView;

    // Header layout (32 bytes = 8 floats):
    // resolution(8) + offset(8) + zoom(4) + rectCount(4) + padding(8)
    v[0] = width;
    v[1] = height;
    v[2] = viewport.offset.x;
    v[3] = viewport.offset.y;
    v[4] = viewport.zoom;
    v[5] = Math.min(rects.length, 4); // rectCount (max 4)
    v[6] = 0; // padding
    v[7] = 0; // padding

    // Write each RectData (64 bytes = 16 floats each)
    // RectData[i] starts at float index 8 + (i * 16)
    const maxRects = Math.min(rects.length, 4);
    for (let i = 0; i < maxRects; i++) {
      const rect = rects[i]!;
      const fillColor = rect.config.backgroundColor;
      const borderColor = rect.config.borderColor;
      const base = 8 + i * 16;

      // rect: vec4f (x, y, width, height)
      v[base + 0] = rect.bounds.x;
      v[base + 1] = rect.bounds.y;
      v[base + 2] = rect.bounds.width;
      v[base + 3] = rect.bounds.height;
      // fillColor: vec4f (straight alpha — shader handles blending)
      v[base + 4] = fillColor[0];
      v[base + 5] = fillColor[1];
      v[base + 6] = fillColor[2];
      v[base + 7] = fillColor[3];
      // borderColor: vec4f (straight alpha — shader handles blending)
      v[base + 8] = borderColor[0];
      v[base + 9] = borderColor[1];
      v[base + 10] = borderColor[2];
      v[base + 11] = borderColor[3];
      // borderWidth: vec4f (only .x used, rest padding)
      v[base + 12] = rect.config.borderWidth;
      v[base + 13] = 0;
      v[base + 14] = 0;
      v[base + 15] = 0;
    }

    // Zero out unused rect slots
    for (let i = maxRects; i < 4; i++) {
      const base = 8 + i * 16;
      for (let j = 0; j < 16; j++) {
        v[base + j] = 0;
      }
    }
  }

  /**
   * Apply entity shader to source texture, writing result to output texture.
   * Handles both compute shader (error diffusion) and fragment shader paths.
   * If adjustments are set, applies them BEFORE the main shader.
   * If post-processing is enabled, applies effects AFTER the main shader.
   * This is the core shader application logic used by all rendering methods.
   *
   * Pipeline order: Source -> Adjustments -> Main Shader -> Post-Processing -> Output
   *
   * @param entity - The entity containing shader params
   * @param sourceTexture - Input texture with the source image
   * @param outputTexture - Output texture to write results to
   * @param outputTextureHasStorageBinding - Whether outputTexture has STORAGE_BINDING (for compute shader direct write)
   */
  #applyShaderToTexture(
    entity: EffectRenderEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    _outputTextureHasStorageBinding: boolean = false,
  ): void {
    if (!this.#device || !this.#entityShaderRuntime) {
      return;
    }

    // Single encoder for the entire entity pipeline: blur -> adjustments -> shader -> post-process
    const encoder = this.#device.createCommandEncoder({
      label: `Entity ${entity.id} pipeline`,
    });
    this.#entityShaderRuntime.encode({
      entity,
      sourceTexture,
      outputTexture,
      encoder,
      width: entity.originalSize.width,
      height: entity.originalSize.height,
      respectShowOriginal: true,
    });

    this.#device.queue.submit([encoder.finish()]);
  }

  #resolveEntityPreviewResolution(
    entity: ShaderCanvasEntity,
    viewport: Viewport,
    nowMs: number,
  ): PreviewResolution {
    const state =
      entity.mediaSource.type === "video"
        ? this.#getVideoPreviewAdaptiveState(entity.id)
        : undefined;

    return resolveVideoPreviewResolution(
      {
        isVideo: entity.mediaSource.type === "video",
        originalSize: entity.originalSize,
        entitySize: entity.size,
        viewportZoom: viewport.zoom,
        nowMs,
        state,
      },
      config.rendering.videoPreviewAdaptive,
    );
  }

  #recordVideoPreviewFrameTime(
    visibleEntities: readonly ShaderCanvasEntity[],
    rafDeltaMs: number,
  ): void {
    const videoEntities = visibleEntities.filter(
      (entity) => entity.mediaSource.type === "video" && entity.playback?.isPlaying,
    );
    if (videoEntities.length === 0) return;

    const entityById = new Map(videoEntities.map((entity) => [entity.id, entity]));
    const governorEntities: VideoPreviewGovernorEntity[] = videoEntities.map((entity) => ({
      id: entity.id,
      quality: this.#getVideoPreviewAdaptiveState(entity.id).quality,
      originalSize: entity.originalSize,
    }));
    const transitions = recordVideoPreviewFrameGovernorSample(
      this.#videoPreviewFrameGovernor,
      governorEntities,
      rafDeltaMs,
      config.rendering.videoPreviewAdaptive,
    );

    for (const transition of transitions) {
      if (!transition.entityId) continue;
      const entity = entityById.get(transition.entityId);
      if (!entity) continue;
      const adaptiveState = this.#getVideoPreviewAdaptiveState(entity.id);
      adaptiveState.quality = transition.to;
      adaptiveState.forceResolutionUpdate = true;
      adaptiveState.samples = [];

      this.#logVideoPreviewTransition(entity, transition, {
        rafDeltaMs: Number(rafDeltaMs.toFixed(2)),
        visibleVideoCount: videoEntities.length,
        thisFrameWillResolveNewQuality: true,
      });
    }
  }

  #logVideoPreviewTransition(
    entity: ShaderCanvasEntity,
    transition: VideoPreviewQualityTransition,
    extra: Record<string, unknown>,
  ): void {
    const direction =
      transition.from === "full" ||
      (transition.from === "threeQuarter" && transition.to === "floor")
        ? "downgraded"
        : "upgraded";

    logger.info(`[renderer] Video preview ${direction}`, {
      entityId: entity.id,
      entityName: entity.name,
      source: transition.source,
      from: transition.from,
      to: transition.to,
      ...(transition.action ? { action: transition.action } : {}),
      medianMs: Number(transition.medianMs.toFixed(2)),
      p95Ms: Number(transition.p95Ms.toFixed(2)),
      ...(transition.targetMs ? { targetMs: Number(transition.targetMs.toFixed(2)) } : {}),
      ...extra,
    });
  }

  #getVideoPreviewAdaptiveState(entityId: string): VideoPreviewAdaptiveState {
    let state = this.#videoPreviewAdaptiveStates.get(entityId);
    if (!state) {
      state = createVideoPreviewAdaptiveState();
      this.#videoPreviewAdaptiveStates.set(entityId, state);
    }
    return state;
  }

  #createRenderEntity(
    entity: ShaderCanvasEntity,
    renderResolution: PreviewResolution,
  ): EffectRenderEntity {
    if (renderResolution.renderScale === 1) return entity;
    return {
      id: entity.id,
      originalSize: {
        width: renderResolution.width,
        height: renderResolution.height,
      },
      shaderType: entity.shaderType,
      shaderParams: this.#scaleRenderParams(entity.shaderParams, renderResolution.renderScale),
    };
  }

  #scaleRenderParams(params: ShaderParams, renderScale: number): ShaderParams {
    const postProcess = params.postProcess;
    const scaledPostProcess = postProcess
      ? {
          ...postProcess,
          grain: postProcess.grain
            ? {
                ...postProcess.grain,
                size: postProcess.grain.size * renderScale,
              }
            : postProcess.grain,
          chromaticAberration: postProcess.chromaticAberration
            ? {
                ...postProcess.chromaticAberration,
                offset: postProcess.chromaticAberration.offset * renderScale,
              }
            : postProcess.chromaticAberration,
        }
      : postProcess;

    return {
      ...params,
      size: params.size * renderScale,
      ...(scaledPostProcess ? { postProcess: scaledPostProcess } : {}),
    };
  }

  #updateGridUniforms(viewport: Viewport): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const config = this.#gridConfig;

    // Multi-level grid: compute fine grid size and crossfade factor
    const { fineGridSize, fadeFactor } = calculateGridLevel(config.gridSize, viewport.zoom);

    // Scale dot size by DPR so it's in physical pixels (matching fragCoord space)
    const dpr = window.devicePixelRatio || 1;
    const effectiveDotSize = Math.max(1.0, config.dotSize) * dpr;

    // Layout: resolution(8) + offset(8) + zoom(4) + fineGridSize(4) + dotSize(4) + fadeFactor(4) + bgColor(16) + dotColor(16)
    this.#gridFloatView[0] = width;
    this.#gridFloatView[1] = height;
    this.#gridFloatView[2] = viewport.offset.x;
    this.#gridFloatView[3] = viewport.offset.y;
    this.#gridFloatView[4] = viewport.zoom;
    this.#gridFloatView[5] = fineGridSize;
    this.#gridFloatView[6] = effectiveDotSize;
    this.#gridFloatView[7] = fadeFactor;
    this.#gridFloatView[8] = config.backgroundColor[0];
    this.#gridFloatView[9] = config.backgroundColor[1];
    this.#gridFloatView[10] = config.backgroundColor[2];
    this.#gridFloatView[11] = config.backgroundColor[3];
    this.#gridFloatView[12] = config.dotColor[0];
    this.#gridFloatView[13] = config.dotColor[1];
    this.#gridFloatView[14] = config.dotColor[2];
    this.#gridFloatView[15] = config.dotColor[3];
  }

  #updateViewportUniforms(viewport: Viewport): void {
    const width = this.canvas.width;
    const height = this.canvas.height;
    const matrix = getViewportMatrix(viewport, width, height);

    // Copy matrix rows (3x4 layout for alignment)
    for (let i = 0; i < 12; i++) {
      this.#viewportFloatView[i] = matrix[i]!;
    }
    // resolution
    this.#viewportFloatView[12] = width;
    this.#viewportFloatView[13] = height;
    // zoom level (for screen-space border calculation)
    this.#viewportFloatView[14] = viewport.zoom;
    // padding
    this.#viewportFloatView[15] = 0;
  }

  #updateEntityUniforms(
    entity: ShaderCanvasEntity,
    isHovered: boolean,
    isSelected: boolean,
    debugMode: boolean,
    positionOffsetX = 0,
    positionOffsetY = 0,
  ): void {
    this.#entityFloatView[0] = entity.position.x + positionOffsetX;
    this.#entityFloatView[1] = entity.position.y + positionOffsetY;
    this.#entityFloatView[2] = entity.size.width;
    this.#entityFloatView[3] = entity.size.height;
    this.#entityFloatView[4] = (entity.rotation * Math.PI) / 180; // Convert to radians
    this.#entityUintView[5] = isHovered ? 1 : 0; // isHovered flag
    this.#entityUintView[6] = isSelected ? 1 : 0; // isSelected flag
    this.#entityUintView[7] = debugMode ? 1 : 0; // debugMode flag
    this.#entityFloatView[8] = entityDragVisual.getScale(entity.id); // visual drag scale
    this.#entityFloatView[9] = 0; // disintProgress (unused for live entities)
    this.#entityFloatView[10] = 0; // disintSeed (unused for live entities)
    this.#entityFloatView[11] = 0;
  }

  #drawCompositionItems(
    pass: GPURenderPassEncoder,
    items: readonly CompositionDrawItem[],
    selectedEntityCount: number,
  ): void {
    for (const item of items) {
      pass.setPipeline(this.#compositionPipeline!);
      pass.setBindGroup(0, item.bindGroup);
      pass.draw(6);

      if (item.isSelected && selectedEntityCount === 1 && this.#entityLabelPass) {
        this.#entityLabelPass.drawLabel(pass, item.entity, item.offsetX, item.offsetY);
      }
    }
  }

  #renderDisintegrationOverlays(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    dt: number,
  ): void {
    if (this.#disintegrationOverlays.size === 0) return;

    // Clean up GPU resources for overlays whose animations have completed
    // (controller removes them from its map when tick() finds them finished)
    const completedIds: string[] = [];
    for (const id of this.#disintegrationOverlays.keys()) {
      if (!disintegrationController.hasOverlay(id)) {
        completedIds.push(id);
      }
    }
    for (const id of completedIds) {
      this.#cleanupDisintegrationOverlay(id);
    }

    // Render active overlays
    const now = performance.now();
    for (const overlay of disintegrationController.getOverlays()) {
      const gpu = this.#disintegrationOverlays.get(overlay.id);
      if (!gpu) continue;
      if (now < overlay.startTime) continue;

      const progress = disintegrationController.getProgress(overlay.id);

      // Render dissolve front only while dissolve is still in progress (< 1.0)
      if (progress > 0 && progress < 1) {
        this.#entityFloatView[0] = overlay.position.x;
        this.#entityFloatView[1] = overlay.position.y;
        this.#entityFloatView[2] = overlay.size.width;
        this.#entityFloatView[3] = overlay.size.height;
        this.#entityFloatView[4] = (overlay.rotation * Math.PI) / 180;
        this.#entityUintView[5] = 0; // not hovered
        this.#entityUintView[6] = 0; // not selected
        this.#entityUintView[7] = 0; // no debug
        this.#entityFloatView[8] = 1.0; // scale
        this.#entityFloatView[9] = progress; // disintProgress
        this.#entityFloatView[10] = overlay.seed; // disintSeed
        this.#entityFloatView[11] = 0;

        this.#device!.queue.writeBuffer(gpu.uniformBuffer, 0, this.#entityUniformData);

        const pass = encoder.beginRenderPass({
          label: `Disintegration overlay ${overlay.id}`,
          colorAttachments: [
            {
              view: targetView,
              loadOp: "load",
              storeOp: "store",
            },
          ],
        });

        pass.setPipeline(this.#compositionPipeline!);
        pass.setBindGroup(0, gpu.bindGroup);
        pass.draw(6);
        pass.end();
      }

      // Update + render particles (compute pass must precede render pass)
      const elapsed = Math.max(now - overlay.startTime, 0) / 1000;
      this.#particleSystem?.update(overlay.id, elapsed, dt, encoder);
      this.#particleSystem?.render(overlay.id, encoder, targetView);
    }
  }

  /**
   * Get a video frame as an OffscreenCanvas source compatible with all browsers.
   * Firefox doesn't support HTMLVideoElement in copyExternalImageToTexture,
   * so we draw to an OffscreenCanvas first.
   */
  #getVideoFrameSource(video: HTMLVideoElement, width: number, height: number): OffscreenCanvas {
    if (
      !this.#videoUploadCanvas ||
      this.#videoUploadCanvas.width !== width ||
      this.#videoUploadCanvas.height !== height
    ) {
      this.#videoUploadCanvas = new OffscreenCanvas(width, height);
      this.#videoUploadCtx = this.#videoUploadCanvas.getContext("2d", {
        colorSpace: this.#colorConfig.textureColorSpace,
      });
    }
    this.#videoUploadCtx!.drawImage(video, 0, 0, width, height);
    return this.#videoUploadCanvas;
  }

  #uploadEntitySourceToTexture(
    entity: ShaderCanvasEntity,
    texture: GPUTexture,
    width: number,
    height: number,
  ): HTMLVideoElement | ImageBitmap | OffscreenCanvas {
    if (entity.mediaSource.type === "video") {
      const video = entity.mediaSource.videoElement;
      const needsScaledUpload =
        width !== entity.originalSize.width || height !== entity.originalSize.height;

      if (!needsScaledUpload && this.#directVideoUploadSupported !== false) {
        try {
          this.#device!.queue.copyExternalImageToTexture(
            { source: video },
            { texture, colorSpace: this.#colorConfig.textureColorSpace },
            [width, height],
          );
          this.#directVideoUploadSupported = true;
          return video;
        } catch (error) {
          this.#directVideoUploadSupported = false;
          logger.debug(
            "[renderer] Direct video texture upload unavailable; using canvas fallback",
            {
              error,
            },
          );
        }
      }

      const source = this.#getVideoFrameSource(video, width, height);
      this.#device!.queue.copyExternalImageToTexture(
        { source },
        { texture, colorSpace: this.#colorConfig.textureColorSpace },
        [width, height],
      );
      return source;
    }

    const source =
      entity.mediaSource.type === "image" ? entity.mediaSource.imageBitmap : entity.imageBitmap;
    this.#device!.queue.copyExternalImageToTexture(
      { source },
      { texture, colorSpace: this.#colorConfig.textureColorSpace },
      [width, height],
    );
    return source;
  }

  #recordVideoPreviewRenderTime(
    entity: ShaderCanvasEntity,
    didReprocess: boolean,
    renderStart: number,
    resolution: PreviewResolution,
  ): void {
    if (!didReprocess || entity.mediaSource.type !== "video") return;
    const state = this.#videoPreviewAdaptiveStates.get(entity.id);
    if (!state) return;
    const renderTimeMs = performance.now() - renderStart;
    const transition = recordVideoPreviewRenderSample(
      state,
      renderTimeMs,
      config.rendering.videoPreviewAdaptive,
    );
    if (!transition) return;
    blockVideoPreviewFrameGovernorUpgrades(
      this.#videoPreviewFrameGovernor,
      config.rendering.videoPreviewAdaptive,
    );

    this.#logVideoPreviewTransition(entity, transition, {
      renderTimeMs: Number(renderTimeMs.toFixed(2)),
      renderedTextureSize: `${resolution.width}x${resolution.height}`,
      nextFrameWillResolveNewQuality: true,
    });
  }

  /**
   * Render an entity's image through its shader to a texture.
   * Returns the texture, caching it for future frames.
   */
  renderEntityToTexture(
    entity: ShaderCanvasEntity,
    renderResolution?: PreviewResolution,
  ): EntityTextureRenderResult | null {
    if (!this.#device || !this.#entityShaderRuntime) {
      return null;
    }

    const resolution = renderResolution ?? {
      width: entity.originalSize.width,
      height: entity.originalSize.height,
      renderScale: 1,
      quality: "full" as const,
    };
    const width = resolution.width;
    const height = resolution.height;
    const renderStart = performance.now();
    let didReprocess = false;

    // Time-based shaders need the shader pass every frame, but animated media only
    // re-uploads/re-shades when the game loop marks a new decoded frame dirty.
    const needsContinuousShaderRender = this.#entityShaderRuntime.needsContinuousRender(entity);

    // Check if we have a valid processed texture.
    const cachedTexture = this.#entityTextures.get(entity.id);
    if (
      !entity.shaderParams.showOriginal &&
      !needsContinuousShaderRender &&
      cachedTexture &&
      cachedTexture.width === width &&
      cachedTexture.height === height &&
      !entity.textureDirty
    ) {
      return { texture: cachedTexture, changed: false };
    }

    // Source texture usage flags
    const sourceUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT;

    // Check source texture cache: reuse when source dimensions match and no new media frame
    // was marked dirty. This lets viewport/UI redraws sample the previous video frame.
    const cachedSource = this.#entitySourceTextures.get(entity.id);
    let sourceTexture: GPUTexture;
    let sourceTextureChanged = false;

    if (
      !entity.textureDirty &&
      cachedSource &&
      cachedSource.width === width &&
      cachedSource.height === height
    ) {
      sourceTexture = cachedSource.texture;
    } else {
      didReprocess = true;
      // Source changed, dimensions changed, or a new animated frame arrived: upload.
      if (cachedSource && (cachedSource.width !== width || cachedSource.height !== height)) {
        // Dimensions changed — destroy old, create new
        cachedSource.texture.destroy();
        sourceTextureChanged = true;
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
        sourceTextureChanged = true;
        sourceTexture = this.#device.createTexture({
          label: `Entity ${entity.id} cached source`,
          size: [width, height],
          format: "rgba8unorm",
          usage: sourceUsage,
        });
      }

      const sourceRef = this.#uploadEntitySourceToTexture(entity, sourceTexture, width, height);

      this.#entitySourceTextures.set(entity.id, {
        texture: sourceTexture,
        sourceRef,
        width,
        height,
      });
    }

    // If showOriginal is enabled, compose the source texture directly. The source texture
    // is owned by #entitySourceTextures, so keep it out of #entityTextures to avoid
    // double-destroying the same GPU resource during cleanup.
    if (entity.shaderParams.showOriginal) {
      if (cachedTexture) {
        cachedTexture.destroy();
        this.#entityTextures.delete(entity.id);
        sourceTextureChanged = true;
      }
      this.#recordVideoPreviewRenderTime(entity, didReprocess, renderStart, resolution);
      return { texture: sourceTexture, changed: sourceTextureChanged };
    }

    // Reuse output texture if dimensions match, otherwise create new
    const outputUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;

    let outputTexture: GPUTexture;
    let outputTextureChanged = false;
    if (cachedTexture && cachedTexture.width === width && cachedTexture.height === height) {
      // Reuse existing output texture — content will be overwritten by shader
      outputTexture = cachedTexture;
    } else {
      // Dimensions changed or first render — destroy old, create new
      cachedTexture?.destroy();
      outputTextureChanged = true;
      outputTexture = this.#device.createTexture({
        label: `Entity ${entity.id} processed texture`,
        size: [width, height],
        format: this.#colorConfig.intermediateFormat,
        usage: outputUsage,
      });
    }

    // Apply shader using unified method (handles both compute and fragment shader paths)
    didReprocess = true;
    const renderEntity = this.#createRenderEntity(entity, resolution);
    this.#applyShaderToTexture(renderEntity, sourceTexture, outputTexture);
    if (renderEntity !== entity && renderEntity.shaderParams.time !== entity.shaderParams.time) {
      entity.shaderParams.time = renderEntity.shaderParams.time;
    }
    this.#recordVideoPreviewRenderTime(entity, didReprocess, renderStart, resolution);

    // Cache and return (source texture stays in #entitySourceTextures)
    this.#entityTextures.set(entity.id, outputTexture);
    return { texture: outputTexture, changed: outputTextureChanged };
  }

  /**
   * Main render function - renders the entire canvas.
   * Optimized to batch all render passes into a single GPU submission.
   */
  render(state: RenderState): void {
    if (!this.#device || !this.#context || !this.#gridPipeline || !this.#compositionPipeline) {
      return;
    }

    const renderStart = performance.now();
    const frameDt = this.#lastFrameTime > 0 ? (renderStart - this.#lastFrameTime) / 1000 : 1 / 60;
    this.#lastFrameTime = renderStart;
    const { entities, viewport, hoveredEntityId, selectedEntityIds, debugMode } = state;
    const traceId = Math.round(renderStart * 1000).toString(36);
    const markPhaseStart = (phase: string) => {
      if (!debugMode) return;
      performance.mark(`canvas:${phase}:start:${traceId}`);
    };
    const markPhaseEnd = (phase: string) => {
      if (!debugMode) return;
      performance.mark(`canvas:${phase}:end:${traceId}`);
      performance.measure(
        `canvas:${phase}`,
        `canvas:${phase}:start:${traceId}`,
        `canvas:${phase}:end:${traceId}`,
      );
    };

    // Compute action layer rubber-band offset in world coordinates
    // Use controller state (not store) — offset continues during dismiss animation
    let actionLayerOffsetX = 0;
    let actionLayerOffsetY = 0;
    const actionLayerControllerActive = actionLayerController.isActive();
    if (actionLayerControllerActive) {
      const cssOffset = actionLayerController.getEntityOffset();
      const dprLocal = window.devicePixelRatio || 1;
      actionLayerOffsetX = (cssOffset.x * dprLocal) / viewport.zoom;
      actionLayerOffsetY = (cssOffset.y * dprLocal) / viewport.zoom;
    }

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

    // Update grid and viewport uniforms
    this.#updateGridUniforms(viewport);
    this.#updateViewportUniforms(viewport);

    this.#device.queue.writeBuffer(this.#gridUniformBuffer!, 0, this.#gridUniformData);
    this.#device.queue.writeBuffer(this.#viewportUniformBuffer!, 0, this.#viewportUniformData);

    // Sort entities in-place by z-index (avoid array copying)
    entities.sort((a, b) => a.zIndex - b.zIndex);

    // Pre-process entities: render to textures and prepare bind groups
    // Uses caching to avoid per-frame allocations
    const entityDrawItems: CompositionDrawItem[] = [];
    const actionLayerDrawItems: CompositionDrawItem[] = [];
    let hasAnimatingContent = false;
    markPhaseStart("entity-prep");

    // Compute viewport world bounds once for culling (with buffer to prevent pop-in)
    const viewportBounds = getViewportWorldBounds(
      viewport,
      width,
      height,
      config.canvas.cullingBufferFraction,
    );
    const visibleEntities: ShaderCanvasEntity[] = [];
    for (const entity of entities) {
      // Viewport culling: skip all GPU work for entities entirely outside the viewport.
      // textureDirty is intentionally NOT cleared here — it stays true so the entity
      // re-renders correctly when it scrolls back into view.
      const entityAABB = getRotatedAABB(entity.position, entity.size, entity.rotation);
      if (!boundsIntersect(entityAABB, viewportBounds)) {
        continue;
      }
      visibleEntities.push(entity);
    }

    this.#recordVideoPreviewFrameTime(visibleEntities, state.rafDeltaMs);

    for (const entity of visibleEntities) {
      // Check if texture needs regeneration. Animated media is marked dirty by the
      // game loop only when the decoded frame changes.
      const textureWasDirty = !!entity.textureDirty;
      if (textureWasDirty || this.needsContinuousRenderForEntity(entity)) {
        hasAnimatingContent = true;
      }

      const previewResolution = this.#resolveEntityPreviewResolution(entity, viewport, renderStart);

      // Render entity to texture if needed (this has its own submission for dirty textures)
      const entityTextureResult = this.renderEntityToTexture(entity, previewResolution);
      if (!entityTextureResult) continue;
      const { texture: entityTexture, changed: entityTextureChanged } = entityTextureResult;
      if (entityTextureChanged) {
        hasAnimatingContent = true;
      }

      // Clear dirty flag
      entity.textureDirty = false;

      // Determine if this entity is hovered or selected
      const isHovered = entity.id === hoveredEntityId;
      const isSelected = selectedEntityIds.has(entity.id);

      // Check cache for existing composition resources
      const cached = this.#entityCompositionCache.get(entity.id);
      const needsNewBindGroup =
        !cached ||
        textureWasDirty ||
        entityTextureChanged ||
        cached.lastHovered !== isHovered ||
        cached.lastSelected !== isSelected ||
        cached.lastDebugMode !== debugMode;

      let bindGroup: GPUBindGroup;

      if (needsNewBindGroup) {
        // Destroy old uniform buffer if exists (texture view is tied to texture lifecycle)
        if (cached && (textureWasDirty || entityTextureChanged)) {
          cached.uniformBuffer.destroy();
        }

        // Create or reuse uniform buffer
        const uniformBuffer =
          cached && !textureWasDirty && !entityTextureChanged
            ? cached.uniformBuffer
            : this.#device.createBuffer({
                label: `Entity ${entity.id} composition uniform`,
                size: config.rendering.entityUniformSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              });

        // Update and write entity uniforms (apply rubber-band offset for action layer entities)
        const applyOffset =
          actionLayerControllerActive && actionLayerController.hasEntity(entity.id);
        this.#updateEntityUniforms(
          entity,
          isHovered,
          isSelected,
          debugMode,
          applyOffset ? actionLayerOffsetX : 0,
          applyOffset ? actionLayerOffsetY : 0,
        );
        this.#device.queue.writeBuffer(uniformBuffer, 0, this.#entityUniformData);

        // Create texture view (reuse if texture didn't change)
        const textureView =
          cached && !textureWasDirty && !entityTextureChanged
            ? cached.textureView
            : entityTexture.createView();

        // Create bind group with dedicated uniform buffer
        bindGroup = this.#device.createBindGroup({
          label: `Entity ${entity.id} composition bind group`,
          layout: this.#compositionBindGroupLayout!,
          entries: [
            { binding: 0, resource: { buffer: this.#viewportUniformBuffer! } },
            { binding: 1, resource: { buffer: uniformBuffer } },
            { binding: 2, resource: textureView },
            { binding: 3, resource: this.#compositionSampler! },
          ],
        });

        // Update cache
        this.#entityCompositionCache.set(entity.id, {
          uniformBuffer,
          textureView,
          bindGroup,
          lastHovered: isHovered,
          lastSelected: isSelected,
          lastDebugMode: debugMode,
        });
      } else {
        // Reuse cached bind group, but ALWAYS update uniform buffer with current position
        // This is critical for drag operations where position changes every frame
        const applyOffset2 =
          actionLayerControllerActive && actionLayerController.hasEntity(entity.id);
        this.#updateEntityUniforms(
          entity,
          isHovered,
          isSelected,
          debugMode,
          applyOffset2 ? actionLayerOffsetX : 0,
          applyOffset2 ? actionLayerOffsetY : 0,
        );
        this.#device.queue.writeBuffer(cached.uniformBuffer, 0, this.#entityUniformData);
        bindGroup = cached.bindGroup;
      }

      // Action layer entities are drawn AFTER blur (not in main pass) to avoid halo
      const isActionLayerEntity =
        actionLayerControllerActive && actionLayerController.hasEntity(entity.id);
      if (isActionLayerEntity) {
        actionLayerDrawItems.push({
          bindGroup,
          entity,
          isSelected,
          offsetX: actionLayerOffsetX,
          offsetY: actionLayerOffsetY,
        });
      } else {
        entityDrawItems.push({
          bindGroup,
          entity,
          isSelected,
          offsetX: 0,
          offsetY: 0,
        });
      }
    }
    markPhaseEnd("entity-prep");

    // Create single command encoder for grid + all entities
    const encoder = this.#device.createCommandEncoder({
      label: "Canvas render encoder",
    });

    const texture = this.#context.getCurrentTexture();
    // Skip render if swapchain texture is invalid
    if (texture.width === 0 || texture.height === 0) {
      return;
    }
    const targetView = texture.createView();

    // Pass 1: Render dot grid background
    markPhaseStart("grid-pass");
    const gridPass = encoder.beginRenderPass({
      label: "Grid render pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    gridPass.setPipeline(this.#gridPipeline);
    gridPass.setBindGroup(0, this.#gridBindGroup!);
    gridPass.draw(3);
    gridPass.end();
    markPhaseEnd("grid-pass");

    // Pass 2: Render all entities with interleaved labels (z-ordered)
    markPhaseStart("entity-pass");

    // Update label animation state once per frame
    this.#entityLabelPass?.beginFrame(viewport, width, height);
    const selectedEntityCount = selectedEntityIds.size;
    const entityPass = encoder.beginRenderPass({
      label: "Entity composition pass",
      colorAttachments: [
        {
          view: targetView,
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

    markPhaseEnd("entity-pass");

    // Pass 2a: Action layer blur overlay
    // Blur+dim everything, then re-render selected entities sharp on top
    const blurIntensity = actionLayerController.getBlurIntensity();
    if (
      blurIntensity > 0.01 &&
      this.#canvasFormat === this.#colorConfig.intermediateFormat &&
      this.#entityShaderRuntime &&
      this.#actionLayerBlitPipeline &&
      this.#actionLayerBlitBindGroupLayout &&
      this.#actionLayerBlitUniformBuffer &&
      this.#actionLayerBlitSampler
    ) {
      markPhaseStart("action-layer-blur");
      // Get or create intermediate textures for full-screen blur
      const blurTextures = this.#getOrCreateActionLayerBlurTextures(width, height);
      if (blurTextures) {
        // Only re-run the expensive Kawase blur pipeline when content has actually changed
        const blurNeedsUpdate =
          !this.#actionLayerBlurCacheValid || state.dirty || hasAnimatingContent;

        if (blurNeedsUpdate) {
          // Copy swapchain → input texture
          encoder.copyTextureToTexture(
            { texture },
            { texture: blurTextures.input },
            { width, height },
          );

          // Kawase blur: input → output
          this.#entityShaderRuntime.processingPipeline.encodeFullScreenBlur(
            encoder,
            blurTextures.input,
            blurTextures.output,
            width,
            height,
          );

          this.#actionLayerBlurCacheValid = true;
        }

        // Always update uniforms (intensity may change during fade animation)
        const tintAmount = config.actionLayer.dimOpacity * blurIntensity;
        const [tr, tg, tb] = this.#actionLayerTintColor;
        const uniformData = new Float32Array([tintAmount, blurIntensity, 0, 0, tr, tg, tb, 0]);
        this.#device.queue.writeBuffer(this.#actionLayerBlitUniformBuffer, 0, uniformData);

        // Cache blit bind group (only recreate when textures change)
        if (!this.#actionLayerBlitBindGroupCached) {
          this.#actionLayerBlitBindGroupCached = this.#device.createBindGroup({
            label: "Action layer blit bind group",
            layout: this.#actionLayerBlitBindGroupLayout,
            entries: [
              { binding: 0, resource: blurTextures.output.createView() },
              { binding: 1, resource: this.#actionLayerBlitSampler },
              { binding: 2, resource: { buffer: this.#actionLayerBlitUniformBuffer } },
            ],
          });
        }

        const blitPass = encoder.beginRenderPass({
          label: "Action layer blit pass",
          colorAttachments: [
            {
              view: targetView,
              loadOp: "load",
              storeOp: "store",
            },
          ],
        });
        blitPass.setPipeline(this.#actionLayerBlitPipeline);
        blitPass.setBindGroup(0, this.#actionLayerBlitBindGroupCached);
        blitPass.draw(3);
        blitPass.end();
      }
      markPhaseEnd("action-layer-blur");
    }

    // Reset blur cache when action layer blur is no longer rendering
    if (blurIntensity <= 0.01) {
      this.#actionLayerBlurCacheValid = false;
    }

    // Always render action layer entities on top (sharp, after blur or normally)
    markPhaseStart("action-layer-sharp");
    if (actionLayerDrawItems.length > 0) {
      const sharpPass = encoder.beginRenderPass({
        label: "Action layer sharp entity pass",
        colorAttachments: [
          {
            view: targetView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      this.#drawCompositionItems(sharpPass, actionLayerDrawItems, selectedEntityCount);
      sharpPass.end();
    }
    markPhaseEnd("action-layer-sharp");

    if (state.canvasCallouts.length > 0 && this.#canvasCalloutPass) {
      this.#canvasCalloutPass.beginFrame(viewport, width);
      const calloutPass = encoder.beginRenderPass({
        label: "Canvas callout pass",
        colorAttachments: [
          {
            view: targetView,
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
    this.#renderDisintegrationOverlays(encoder, targetView, frameDt);

    // Pass 3: Render all selection rectangles (drag-select and multi-select bounds)
    // Collect all active rectangles
    const selectionRects: Array<{
      bounds: Bounds;
      config: { borderColor: RGBA; backgroundColor: RGBA; borderWidth: number };
    }> = [];

    if (state.dragSelectBounds) {
      selectionRects.push({
        bounds: state.dragSelectBounds,
        config: this.#selectionRectConfig,
      });
    }

    if (state.multiSelectBounds) {
      selectionRects.push({
        bounds: state.multiSelectBounds,
        config: this.#multiSelectBoundingBoxConfig,
      });
    }

    if (
      selectionRects.length > 0 &&
      this.#selectionRectPipeline &&
      this.#selectionRectUniformBuffer &&
      this.#selectionRectBindGroup
    ) {
      markPhaseStart("selection-rects");
      this.#updateSelectionRectUniformsMulti(selectionRects, viewport);
      this.#device.queue.writeBuffer(
        this.#selectionRectUniformBuffer,
        0,
        this.#selectionRectUniformData,
      );

      const selectionRectPass = encoder.beginRenderPass({
        label: "Selection rectangles render pass",
        colorAttachments: [
          {
            view: targetView,
            loadOp: "load", // Preserve previous content
            storeOp: "store",
          },
        ],
      });

      selectionRectPass.setPipeline(this.#selectionRectPipeline);
      selectionRectPass.setBindGroup(0, this.#selectionRectBindGroup);
      selectionRectPass.draw(3); // Fullscreen triangle
      selectionRectPass.end();
      markPhaseEnd("selection-rects");
    }

    // Final pass: WLUR progressive blur overlay (renders on top of everything)
    const resolvedWlurOverlay = resolveWlurOverlayRuntimeConfig(
      this.#wlurOverlayConfig,
      height,
      dpr,
    );
    if (
      resolvedWlurOverlay &&
      this.#wlurPass &&
      this.#entityShaderRuntime &&
      this.#presentCopyPass
    ) {
      const wlurTextures = this.#getOrCreateWlurOverlayTextures(width, height);
      const wlurCacheKey = this.#buildWlurOverlayCacheKey(width, height, resolvedWlurOverlay);
      const wlurNeedsUpdate =
        !resolvedWlurOverlay.cache ||
        !this.#wlurOverlayCacheValid ||
        this.#wlurOverlayCacheKey !== wlurCacheKey ||
        state.dirty ||
        hasAnimatingContent ||
        this.#disintegrationOverlays.size > 0 ||
        blurIntensity > 0.01 ||
        state.dragSelectBounds !== null;

      const qualityKey = [
        resolvedWlurOverlay.quality.kernelSize,
        resolvedWlurOverlay.quality.resolutionScale,
      ].join("|");
      if (qualityKey !== this.#wlurLastQualityKey) {
        this.#wlurPass.updateConfig({ quality: resolvedWlurOverlay.quality });
        this.#wlurLastQualityKey = qualityKey;
      }

      markPhaseStart("wlur-overlay");
      if (wlurNeedsUpdate) {
        if (this.#canvasFormat === this.#colorConfig.intermediateFormat) {
          encoder.copyTextureToTexture(
            { texture },
            { texture: wlurTextures.input },
            { width, height },
          );
        } else {
          this.#entityShaderRuntime.passthroughCopyPass.encode(
            encoder,
            texture,
            wlurTextures.input,
          );
        }

        this.#wlurPass.encode(
          encoder,
          wlurTextures.input,
          wlurTextures.output,
          width,
          height,
          resolvedWlurOverlay.params,
        );

        if (resolvedWlurOverlay.cache) {
          this.#wlurOverlayCacheValid = true;
          this.#wlurOverlayCacheKey = wlurCacheKey;
        } else {
          this.#invalidateWlurOverlayCache();
        }
      }

      if (this.#canvasFormat === this.#colorConfig.intermediateFormat) {
        encoder.copyTextureToTexture(
          { texture: wlurTextures.output },
          { texture },
          { width, height },
        );
      } else {
        this.#presentCopyPass!.encode(encoder, wlurTextures.output, targetView);
      }
      markPhaseEnd("wlur-overlay");
    } else {
      this.#invalidateWlurOverlayCache();
    }

    // Single submission for all passes
    markPhaseStart("queue-submit");
    this.#device.queue.submit([encoder.finish()]);
    markPhaseEnd("queue-submit");

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
    this.#gridConfig = { ...this.#gridConfig, ...config };
    this.#invalidateWlurOverlayCache();
  }

  setActionLayerTint(color: [number, number, number]): void {
    this.#actionLayerTintColor = color;
  }

  setSelectionRectConfig(
    selectionRect: typeof config.selectionRectangle.light,
    multiSelectBox: typeof config.multiSelectBoundingBox.light,
  ): void {
    this.#selectionRectConfig = selectionRect;
    this.#multiSelectBoundingBoxConfig = multiSelectBox;
  }

  setWlurOverlay(config: WlurOverlayConfig | null): void {
    this.#wlurOverlayConfig = config;
    this.#wlurLastQualityKey = "";
    if (config?.quality) {
      this.#wlurPass?.updateConfig({ quality: config.quality });
    } else if (!config) {
      this.#destroyWlurOverlayTextures();
    }
    this.#invalidateWlurOverlayCache();
  }

  /**
   * Remove cached resources for an entity
   */
  removeEntityTexture(entityId: string): void {
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

    // Remove composition cache (uniform buffer, bind group, texture view)
    const cached = this.#entityCompositionCache.get(entityId);
    if (cached) {
      cached.uniformBuffer.destroy();
      this.#entityCompositionCache.delete(entityId);
    }

    this.#entityShaderRuntime?.removeEntity(entityId);
    this.#videoPreviewAdaptiveStates.delete(entityId);

    // Clear any errors for this entity
    this.#entityErrors.delete(entityId);
  }

  /**
   * Snapshot an entity's rendered texture and create a disintegration overlay.
   * Called before removeEntityTexture — copies the GPU texture so the entity
   * can be removed immediately while the dust animation plays independently.
   */
  #createDisintegrationSnapshot(entityId: string): GPUTexture | null {
    if (!this.#device) return null;

    const renderedTexture = this.#entityTextures.get(entityId);
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

    const sourceTexture = this.#entitySourceTextures.get(entityId)?.texture;
    if (!sourceTexture || !this.#entityShaderRuntime) return null;

    const snapshotTexture = this.#device.createTexture({
      label: `Disintegration snapshot ${entityId}`,
      size: [sourceTexture.width, sourceTexture.height],
      format: this.#colorConfig.intermediateFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const encoder = this.#device.createCommandEncoder();
    this.#entityShaderRuntime.passthroughCopyPass.encode(encoder, sourceTexture, snapshotTexture);
    this.#device.queue.submit([encoder.finish()]);
    return snapshotTexture;
  }

  startDisintegration(entity: {
    id: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    rotation: number;
  }): void {
    if (!this.#device || !this.#compositionBindGroupLayout) return;

    const snapshotTexture = this.#createDisintegrationSnapshot(entity.id);
    if (!snapshotTexture) return;

    const textureView = snapshotTexture.createView();
    const uniformBuffer = this.#device.createBuffer({
      label: `Disintegration uniform ${entity.id}`,
      size: config.rendering.entityUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = this.#device.createBindGroup({
      label: `Disintegration bind group ${entity.id}`,
      layout: this.#compositionBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer! } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: textureView },
        { binding: 3, resource: this.#compositionSampler! },
      ],
    });

    this.#disintegrationOverlays.set(entity.id, {
      texture: snapshotTexture,
      textureView,
      uniformBuffer,
      bindGroup,
    });

    // Register with the animation controller
    disintegrationController.addOverlay(entity.id, entity.position, entity.size, entity.rotation);

    // Spawn particles from the snapshot texture
    const overlayData = disintegrationController.getOverlay(entity.id);
    if (overlayData) {
      this.#particleSystem?.spawn(entity.id, snapshotTexture, overlayData);
    }
  }

  /**
   * Cancel a disintegration overlay (e.g., on undo when entity is restored).
   */
  cancelDisintegration(id: string): void {
    disintegrationController.cancelOverlay(id);
    this.#cleanupDisintegrationOverlay(id);
  }

  #cleanupDisintegrationOverlay(id: string): void {
    const overlay = this.#disintegrationOverlays.get(id);
    if (!overlay) return;
    overlay.texture.destroy();
    overlay.uniformBuffer.destroy();
    this.#disintegrationOverlays.delete(id);
    this.#particleSystem?.remove(id);
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
   * Delegates to ExportService. Supports PNG (default) and JPEG.
   */
  async renderEntityToBlob(
    entity: ShaderCanvasEntity,
    options?: import("./export-formats.ts").ImageExportOptions,
  ): Promise<Blob | null> {
    return this.#exportService!.renderEntityToBlob(entity, options);
  }

  /** Whether a shader needs continuous re-rendering for the given entity (e.g., time-based animation). */
  needsContinuousRenderForEntity(entity: ShaderCanvasEntity): boolean {
    return this.#entityShaderRuntime?.needsContinuousRender(entity) ?? false;
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
      this.#entityShaderRuntime?.removeGlassEntity(entity.id);
    }
  }

  /** Whether time auto-increments for an entity. */
  getEntityTimeAutoPlay(entity: ShaderCanvasEntity): boolean {
    return entity.shaderParams.timeAutoPlay !== false;
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
    this.#videoPreviewAdaptiveStates.clear();
    this.#videoPreviewFrameGovernor = createVideoPreviewFrameGovernorState();

    // Destroy entity composition cache
    for (const cached of this.#entityCompositionCache.values()) {
      cached.uniformBuffer.destroy();
    }
    this.#entityCompositionCache.clear();

    // Destroy disintegration overlays + particle system
    for (const overlay of this.#disintegrationOverlays.values()) {
      overlay.texture.destroy();
      overlay.uniformBuffer.destroy();
    }
    this.#disintegrationOverlays.clear();
    this.#particleSystem?.destroy();
    this.#particleSystem = null;

    // Destroy entity label pass
    this.#entityLabelPass?.destroy();
    this.#entityLabelPass = null;
    this.#canvasCalloutPass?.destroy();
    this.#canvasCalloutPass = null;

    this.#entityShaderRuntime?.destroy();
    this.#entityShaderRuntime = null;
    this.#presentCopyPass = null;
    this.#wlurPass?.destroy();
    this.#wlurPass = null;
    this.#wlurOverlayConfig = null;
    this.#wlurLastQualityKey = "";
    this.#destroyWlurOverlayTextures();
    this.#invalidateWlurOverlayCache();

    // Destroy export service
    this.#exportService = null;

    // Destroy texture pool
    this.#texturePool?.destroy();
    this.#texturePool = null;

    // Destroy action layer blur resources
    if (this.#actionLayerBlurTextures) {
      this.#actionLayerBlurTextures.input.destroy();
      this.#actionLayerBlurTextures.output.destroy();
      this.#actionLayerBlurTextures = null;
    }
    this.#actionLayerBlurCacheValid = false;
    this.#actionLayerBlitBindGroupCached = null;
    this.#actionLayerBlitUniformBuffer?.destroy();
    this.#actionLayerBlitPipeline = null;
    this.#actionLayerBlitBindGroupLayout = null;
    this.#actionLayerBlitSampler = null;

    // Destroy buffers
    this.#gridUniformBuffer?.destroy();
    this.#viewportUniformBuffer?.destroy();
    this.#entityUniformBuffer?.destroy();
    this.#selectionRectUniformBuffer?.destroy();

    // Clear entity errors
    this.#entityErrors.clear();

    // Disconnect resize observer
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;

    // Destroy device
    this.#device?.destroy();

    // Clear references
    this.#gridPipeline = null;
    this.#compositionPipeline = null;
    this.#selectionRectPipeline = null;
    this.#gridBindGroup = null;
    this.#selectionRectBindGroup = null;
    this.#compositionBindGroupLayout = null;
    this.#context = null;
    this.#device = null;
  }
}
