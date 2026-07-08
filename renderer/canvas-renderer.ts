import { config, getViewportLensDistortionConfig, type GridConfig } from "#config";
import { logger } from "#lib/client.logger.ts";
import { WlurPass } from "#wlur";
import { setGpuContext } from "./gpu-color-space.ts";
import {
  type RenderState,
  actionLayerController,
  disintegrationController,
  entityDragVisual,
} from "#engine";
import {
  boundsIntersect,
  getRotatedAABB,
  getViewportMatrix,
  getViewportWorldBounds,
} from "#lib/canvas-math.ts";
import type { ShaderCanvasEntity, Viewport } from "#types/canvas.ts";
import compositionShaderSource from "./composition.wgsl?raw";
import { CopyPass } from "./copy-pass.ts";
import { DisintegrationParticleSystem } from "./disintegration-particles.ts";
import { EntityTexturePipeline, type EntityCompositionSource } from "./entity-texture-pipeline.ts";
import { ExportService } from "./export-service.ts";
import { ExternalTextureCopyPass } from "./external-texture-copy-pass.ts";
import { detectGpuColorConfig, type GpuColorConfig } from "./gpu-color-space.ts";
import { GridPass } from "./grid-pass.ts";
import { SelectionRectPass } from "./selection-rect-pass.ts";
import { CanvasCalloutPass } from "./canvas-callout-pass.ts";
import { EntityLabelPass } from "./entity-label-pass.ts";
import { TexturePool } from "./texture-pool.ts";
import { resolveWlurOverlayRuntimeConfig, type WlurOverlayConfig } from "./wlur-overlay.ts";
import actionLayerBlitShaderSource from "./action-layer-blit.wgsl?raw";
import viewportLensDistortionShaderSource from "./viewport-lens-distortion.wgsl?raw";
import { CanvasLensing } from "#types/enums.ts";
import type { ImageExportOptions } from "./export-formats.ts";

export interface ViewportLensDistortionConfig {
  enabled: boolean;
  strength: number;
  radius: number;
  falloff: number;
  dispersion: number;
  scale: number;
  reflectionIntensity: number;
  reflectionFocus: number;
  occlusion: number;
  vignetteLight: number;
  vignetteDark: number;
}

interface CompositionDrawItem {
  bindGroup: GPUBindGroup;
  pipeline: "texture" | "external";
  entity: ShaderCanvasEntity;
  isSelected: boolean;
  offsetX: number;
  offsetY: number;
}

function createExternalCompositionShaderSource(source: string): string {
  const rewritten = source
    .replace(
      /@group\(0\)\s+@binding\(2\)\s+var\s+entityTexture\s*:\s*texture_2d<f32>;/,
      "@group(0) @binding(2) var entityTexture: texture_external;",
    )
    .replace(
      /textureSample\(entityTexture,\s*entitySampler,/g,
      "textureSampleBaseClampToEdge(entityTexture, entitySampler,",
    );

  if (rewritten === source || !rewritten.includes("texture_external")) {
    throw new Error("Failed to rewrite composition shader source for external texture input.");
  }
  return rewritten;
}

export class InfiniteCanvasRenderer {
  readonly canvas: HTMLCanvasElement;

  #device: GPUDevice | null = null;
  #context: GPUCanvasContext | null = null;
  #canvasFormat!: GPUTextureFormat;
  #colorConfig!: GpuColorConfig;

  #gridPass: GridPass | null = null;

  // Composition pipeline
  #compositionPipeline: GPURenderPipeline | null = null;
  #externalCompositionPipeline: GPURenderPipeline | null = null;
  #externalTextureCopyPass: ExternalTextureCopyPass | null = null;
  #viewportUniformBuffer: GPUBuffer | null = null;
  #entityUniformBuffer: GPUBuffer | null = null;
  #compositionSampler: GPUSampler | null = null;
  #compositionBindGroupLayout: GPUBindGroupLayout | null = null;
  #externalCompositionBindGroupLayout: GPUBindGroupLayout | null = null;
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

  // Entity composition cache (uniform buffers, bind groups, texture views)
  // These are invalidated when entity texture changes
  #entityCompositionCache: Map<
    string,
    {
      uniformBuffer: GPUBuffer;
      texture: GPUTexture;
      textureView: GPUTextureView;
      bindGroup: GPUBindGroup;
      lastHovered: boolean;
      lastSelected: boolean;
      lastDebugMode: boolean;
    }
  > = new Map();

  #entityExternalCompositionCache: Map<
    string,
    {
      uniformBuffer: GPUBuffer;
    }
  > = new Map();

  #actionLayerTintColor: [number, number, number] = config.actionLayer.dimColor.dark;

  // Texture pool for eliminating per-frame allocation churn
  #texturePool: TexturePool | null = null;

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

  #selectionRectPass: SelectionRectPass | null = null;

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

  // Full-canvas viewport lens distortion pass. Runs before mobile wlur overlay so
  // the progressive bottom blur itself stays screen-space rather than warped.
  #viewportLensConfig: ViewportLensDistortionConfig = getViewportLensDistortionConfig(
    CanvasLensing.off,
  );
  #viewportLensDarkTheme = false;
  #viewportLensPipeline: GPURenderPipeline | null = null;
  #viewportLensBindGroupLayout: GPUBindGroupLayout | null = null;
  #viewportLensUniformBuffer: GPUBuffer | null = null;
  #viewportLensSampler: GPUSampler | null = null;
  #viewportLensUniformData = new ArrayBuffer(48);
  #viewportLensFloatView = new Float32Array(this.#viewportLensUniformData);
  #viewportLensTexture: {
    width: number;
    height: number;
    texture: GPUTexture;
    view: GPUTextureView;
    bindGroup: GPUBindGroup;
  } | null = null;

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

  #entityTexturePipeline: EntityTexturePipeline | null = null;

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
    return this.#device !== null && this.#gridPass !== null;
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

    this.#gridPass = new GridPass(this.#device, this.#canvasFormat);
    this.#createCompositionPipeline();
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

    this.#selectionRectPass = new SelectionRectPass(this.#device, this.#canvasFormat);
    this.#createActionLayerBlitPipeline();
    this.#createViewportLensPipeline();
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
      (entity, source, output) =>
        this.#entityTexturePipeline!.applyShaderToTexture(entity, source, output),
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

    this.#externalCompositionBindGroupLayout = this.#device.createBindGroupLayout({
      label: "External composition bind group layout",
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
          externalTexture: {},
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

    const externalShaderModule = this.#device.createShaderModule({
      label: "External composition shader",
      code: createExternalCompositionShaderSource(compositionShaderSource),
    });

    const externalPipelineLayout = this.#device.createPipelineLayout({
      label: "External composition pipeline layout",
      bindGroupLayouts: [this.#externalCompositionBindGroupLayout],
    });

    this.#externalCompositionPipeline = this.#device.createRenderPipeline({
      label: "External composition pipeline",
      layout: externalPipelineLayout,
      vertex: {
        module: externalShaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: externalShaderModule,
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

  #destroyViewportLensTexture(): void {
    this.#viewportLensTexture?.texture.destroy();
    this.#viewportLensTexture = null;
  }

  #shouldApplyViewportLensDistortion(): boolean {
    const lens = this.#viewportLensConfig;
    return (
      lens.enabled &&
      (lens.strength > 0.001 || lens.dispersion > 0.001) &&
      this.#viewportLensPipeline !== null &&
      this.#viewportLensBindGroupLayout !== null &&
      this.#viewportLensUniformBuffer !== null &&
      this.#viewportLensSampler !== null
    );
  }

  #getOrCreateViewportLensTexture(
    width: number,
    height: number,
  ): { texture: GPUTexture; view: GPUTextureView } | null {
    const cached = this.#viewportLensTexture;
    if (cached && cached.width === width && cached.height === height) {
      return cached;
    }

    if (
      !this.#device ||
      !this.#viewportLensBindGroupLayout ||
      !this.#viewportLensUniformBuffer ||
      !this.#viewportLensSampler
    ) {
      return null;
    }

    this.#destroyViewportLensTexture();
    const texture = this.#device.createTexture({
      label: `Viewport lens input (${width}x${height})`,
      size: [width, height],
      format: this.#canvasFormat,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
    });
    const view = texture.createView();
    const bindGroup = this.#device.createBindGroup({
      label: "Viewport lens distortion bind group",
      layout: this.#viewportLensBindGroupLayout,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: this.#viewportLensSampler },
        { binding: 2, resource: { buffer: this.#viewportLensUniformBuffer } },
      ],
    });
    this.#viewportLensTexture = { width, height, texture, view, bindGroup };
    return this.#viewportLensTexture;
  }

  #createViewportLensPipeline(): void {
    if (!this.#device) return;

    const shaderModule = this.#device.createShaderModule({
      label: "Viewport lens distortion shader",
      code: viewportLensDistortionShaderSource,
    });

    this.#viewportLensBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Viewport lens distortion bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    this.#viewportLensUniformBuffer = this.#device.createBuffer({
      label: "Viewport lens distortion uniforms",
      size: this.#viewportLensUniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#viewportLensSampler = this.#device.createSampler({
      label: "Viewport lens distortion sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Viewport lens distortion pipeline layout",
      bindGroupLayouts: [this.#viewportLensBindGroupLayout],
    });

    this.#viewportLensPipeline = this.#device.createRenderPipeline({
      label: "Viewport lens distortion pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  #encodeViewportLensDistortion(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    width: number,
    height: number,
  ): boolean {
    if (!this.#shouldApplyViewportLensDistortion()) {
      return false;
    }

    const lens = this.#viewportLensConfig;
    const lensTexture = this.#getOrCreateViewportLensTexture(width, height);
    if (!lensTexture || !this.#viewportLensUniformBuffer || !this.#viewportLensPipeline) {
      return false;
    }

    const v = this.#viewportLensFloatView;
    v[0] = width;
    v[1] = height;
    v[2] = lens.strength;
    v[3] = lens.radius;
    v[4] = lens.falloff;
    v[5] = lens.dispersion;
    v[6] = lens.scale;
    v[7] = lens.reflectionIntensity;
    v[8] = lens.reflectionFocus;
    v[9] = lens.occlusion;
    v[10] = this.#viewportLensDarkTheme ? lens.vignetteDark : lens.vignetteLight;
    v[11] = 0;
    this.#device!.queue.writeBuffer(
      this.#viewportLensUniformBuffer,
      0,
      this.#viewportLensUniformData,
    );

    const pass = encoder.beginRenderPass({
      label: "Viewport lens distortion pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.#viewportLensPipeline);
    pass.setBindGroup(0, this.#viewportLensTexture!.bindGroup);
    pass.draw(3);
    pass.end();
    return true;
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
      pass.setPipeline(
        item.pipeline === "external"
          ? this.#externalCompositionPipeline!
          : this.#compositionPipeline!,
      );
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
      !this.#compositionPipeline ||
      !this.#externalCompositionPipeline
    ) {
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

    // Update viewport uniforms
    this.#updateViewportUniforms(viewport);

    this.#device.queue.writeBuffer(this.#viewportUniformBuffer!, 0, this.#viewportUniformData);

    // Sort entities in-place by z-index (avoid array copying)
    entities.sort((a, b) => a.zIndex - b.zIndex);

    // Entity preprocessing can encode shader passes into this same command buffer.
    // External video textures must be imported, bound, encoded, finished, and submitted
    // inside the current render task.
    const encoder = this.#device.createCommandEncoder({
      label: "Canvas render encoder",
    });

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

    for (const entity of entities) {
      // Viewport culling: skip all GPU work for entities entirely outside the viewport.
      // textureDirty is intentionally NOT cleared here — it stays true so the entity
      // re-renders correctly when it scrolls back into view.
      const entityAABB = getRotatedAABB(entity.position, entity.size, entity.rotation);
      if (!boundsIntersect(entityAABB, viewportBounds)) {
        continue;
      }

      // Check if texture needs regeneration. Animated media is marked dirty by the
      // game loop only when the decoded frame changes.
      const textureWasDirty = !!entity.textureDirty;
      if (textureWasDirty || this.needsContinuousRenderForEntity(entity)) {
        hasAnimatingContent = true;
      }

      const compositionSource = this.renderEntityToTexture(entity, encoder);
      if (!compositionSource) continue;

      // Clear dirty flag
      entity.textureDirty = false;

      // Determine if this entity is hovered or selected
      const isHovered = entity.id === hoveredEntityId;
      const isSelected = selectedEntityIds.has(entity.id);

      let bindGroup: GPUBindGroup;
      let pipeline: "texture" | "external";

      if (compositionSource.kind === "texture") {
        pipeline = "texture";

        // Check cache for existing composition resources
        const cached = this.#entityCompositionCache.get(entity.id);
        const textureChanged = cached?.texture !== compositionSource.texture;
        const needsNewBindGroup =
          !cached ||
          textureChanged ||
          cached.lastHovered !== isHovered ||
          cached.lastSelected !== isSelected ||
          cached.lastDebugMode !== debugMode;

        if (needsNewBindGroup) {
          // Create or reuse uniform buffer
          const uniformBuffer =
            cached?.uniformBuffer ??
            this.#device.createBuffer({
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
            cached && !textureChanged ? cached.textureView : compositionSource.texture.createView();

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
            texture: compositionSource.texture,
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
      } else {
        pipeline = "external";
        const cached = this.#entityExternalCompositionCache.get(entity.id);
        const uniformBuffer =
          cached?.uniformBuffer ??
          this.#device.createBuffer({
            label: `Entity ${entity.id} external composition uniform`,
            size: config.rendering.entityUniformSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
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
        bindGroup = this.#device.createBindGroup({
          label: `Entity ${entity.id} external composition bind group`,
          layout: this.#externalCompositionBindGroupLayout!,
          entries: [
            { binding: 0, resource: { buffer: this.#viewportUniformBuffer! } },
            { binding: 1, resource: { buffer: uniformBuffer } },
            { binding: 2, resource: compositionSource.texture },
            { binding: 3, resource: this.#compositionSampler! },
          ],
        });
        if (!cached) {
          this.#entityExternalCompositionCache.set(entity.id, { uniformBuffer });
        }
      }

      // Action layer entities are drawn AFTER blur (not in main pass) to avoid halo
      const isActionLayerEntity =
        actionLayerControllerActive && actionLayerController.hasEntity(entity.id);
      if (isActionLayerEntity) {
        actionLayerDrawItems.push({
          bindGroup,
          pipeline,
          entity,
          isSelected,
          offsetX: actionLayerOffsetX,
          offsetY: actionLayerOffsetY,
        });
      } else {
        entityDrawItems.push({
          bindGroup,
          pipeline,
          entity,
          isSelected,
          offsetX: 0,
          offsetY: 0,
        });
      }
    }
    markPhaseEnd("entity-prep");

    const texture = this.#context.getCurrentTexture();
    // Skip render if swapchain texture is invalid
    if (texture.width === 0 || texture.height === 0) {
      this.#entityTexturePipeline?.flushTextureReleases();
      return;
    }
    const targetView = texture.createView();
    const viewportLensTarget = this.#shouldApplyViewportLensDistortion()
      ? this.#getOrCreateViewportLensTexture(width, height)
      : null;
    const sceneTargetTexture = viewportLensTarget?.texture ?? texture;
    const sceneTargetView = viewportLensTarget?.view ?? targetView;

    // Pass 1: Render dot grid background
    markPhaseStart("grid-pass");
    this.#gridPass.encode({ encoder, targetView: sceneTargetView, viewport, width, height });
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

    markPhaseEnd("entity-pass");

    // Pass 2a: Action layer blur overlay
    // Blur+dim everything, then re-render selected entities sharp on top
    const blurIntensity = actionLayerController.getBlurIntensity();
    if (
      blurIntensity > 0.01 &&
      this.#canvasFormat === this.#colorConfig.intermediateFormat &&
      this.#entityTexturePipeline &&
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
          // Copy the pre-lens scene → input texture
          encoder.copyTextureToTexture(
            { texture: sceneTargetTexture },
            { texture: blurTextures.input },
            { width, height },
          );

          // Kawase blur: input → output
          this.#entityTexturePipeline.processingPipeline.encodeFullScreenBlur(
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
              view: sceneTargetView,
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
            view: sceneTargetView,
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
    this.#renderDisintegrationOverlays(encoder, sceneTargetView, frameDt);

    // Pass 3: Render all selection rectangles (drag-select and multi-select bounds)
    if ((state.dragSelectBounds || state.multiSelectBounds) && this.#selectionRectPass) {
      markPhaseStart("selection-rects");
      this.#selectionRectPass.encode({
        encoder,
        targetView: sceneTargetView,
        viewport,
        width,
        height,
        dragSelectBounds: state.dragSelectBounds,
        multiSelectBounds: state.multiSelectBounds,
      });
      markPhaseEnd("selection-rects");
    }

    markPhaseStart("viewport-lens-distortion");
    const lensApplied = viewportLensTarget
      ? this.#encodeViewportLensDistortion(encoder, targetView, width, height)
      : false;
    markPhaseEnd("viewport-lens-distortion");

    // Final pass: WLUR progressive blur overlay (renders on top of everything)
    const resolvedWlurOverlay = resolveWlurOverlayRuntimeConfig(
      this.#wlurOverlayConfig,
      height,
      dpr,
    );
    if (
      resolvedWlurOverlay &&
      this.#wlurPass &&
      this.#entityTexturePipeline &&
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
        lensApplied ||
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
          this.#entityTexturePipeline.passthroughCopyPass.encode(
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
    this.#entityTexturePipeline?.flushTextureReleases();
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
    this.#gridPass?.setConfig(config);
    this.#invalidateWlurOverlayCache();
  }

  setActionLayerTint(color: [number, number, number]): void {
    this.#actionLayerTintColor = color;
  }

  setSelectionRectConfig(
    selectionRect: typeof config.selectionRectangle.light,
    multiSelectBox: typeof config.multiSelectBoundingBox.light,
  ): void {
    this.#selectionRectPass?.setConfig(selectionRect, multiSelectBox);
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

  setViewportLensDistortion(config: ViewportLensDistortionConfig): void {
    this.#viewportLensConfig = { ...config };
    this.#invalidateWlurOverlayCache();
  }

  setViewportLensColorScheme(isDark: boolean): void {
    if (this.#viewportLensDarkTheme === isDark) return;
    this.#viewportLensDarkTheme = isDark;
    this.#invalidateWlurOverlayCache();
  }

  get viewPortLensConfig(): ViewportLensDistortionConfig {
    return this.#viewportLensConfig;
  }

  /**
   * Remove cached resources for an entity
   */
  removeEntityTexture(entityId: string): void {
    this.#entityTexturePipeline?.removeEntity(entityId);

    // Remove composition cache (uniform buffer, bind group, texture view)
    const cached = this.#entityCompositionCache.get(entityId);
    if (cached) {
      cached.uniformBuffer.destroy();
      this.#entityCompositionCache.delete(entityId);
    }

    const externalCached = this.#entityExternalCompositionCache.get(entityId);
    if (externalCached) {
      externalCached.uniformBuffer.destroy();
      this.#entityExternalCompositionCache.delete(entityId);
    }

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

  startDisintegration(entity: ShaderCanvasEntity): void {
    if (!this.#device || !this.#compositionBindGroupLayout) return;

    const snapshotTexture = this.#createDisintegrationSnapshot(entity);
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
   * Uses only the exact GPU texture currently used for canvas composition, so
   * static entities, animated media, and time-animated shaders all export the
   * visible frame.
   */
  async renderEntityToBlob(
    entity: ShaderCanvasEntity,
    options?: ImageExportOptions,
  ): Promise<Blob | null> {
    const displayedTexture = this.#entityTexturePipeline?.getDisplayedEntityTexture(entity) ?? null;
    if (!displayedTexture) {
      if (entity.mediaSource.type !== "video" || !entity.shaderParams.showOriginal) return null;

      const capturedTexture = this.#copyCurrentVideoFrameToTexture(
        entity,
        `Entity ${entity.id} original video export texture`,
      );
      if (!capturedTexture) return null;

      try {
        return await this.#exportService!.renderTextureToBlob(
          capturedTexture,
          entity.originalSize.width,
          entity.originalSize.height,
          options,
        );
      } finally {
        capturedTexture.destroy();
      }
    }

    return this.#exportService!.renderTextureToBlob(
      displayedTexture,
      entity.originalSize.width,
      entity.originalSize.height,
      options,
    );
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
    this.#entityTexturePipeline?.destroy();
    this.#entityTexturePipeline = null;

    // Destroy entity composition cache
    for (const cached of this.#entityCompositionCache.values()) {
      cached.uniformBuffer.destroy();
    }
    this.#entityCompositionCache.clear();

    for (const cached of this.#entityExternalCompositionCache.values()) {
      cached.uniformBuffer.destroy();
    }
    this.#entityExternalCompositionCache.clear();

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

    this.#presentCopyPass = null;
    this.#wlurPass?.destroy();
    this.#wlurPass = null;
    this.#wlurOverlayConfig = null;
    this.#wlurLastQualityKey = "";
    this.#destroyWlurOverlayTextures();
    this.#invalidateWlurOverlayCache();

    this.#destroyViewportLensTexture();
    this.#viewportLensUniformBuffer?.destroy();
    this.#viewportLensPipeline = null;
    this.#viewportLensBindGroupLayout = null;
    this.#viewportLensUniformBuffer = null;
    this.#viewportLensSampler = null;

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

    this.#gridPass?.destroy();
    this.#gridPass = null;

    // Destroy buffers
    this.#viewportUniformBuffer?.destroy();
    this.#entityUniformBuffer?.destroy();

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
    this.#compositionPipeline = null;
    this.#externalCompositionPipeline = null;
    this.#externalTextureCopyPass = null;
    this.#compositionBindGroupLayout = null;
    this.#externalCompositionBindGroupLayout = null;
    this.#context = null;
    this.#device = null;
  }
}
