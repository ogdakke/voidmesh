import { config, type GridConfig } from "#config";
import { logger } from "#lib/client.logger.ts";
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
  isAnimatedEntity,
  ShaderType,
  type Bounds,
  type RGBA,
  type ShaderCanvasEntity,
  type Viewport,
} from "#types/canvas.ts";
import compositionShaderSource from "./composition.wgsl?raw";
import { CopyPass } from "./copy-pass.ts";
import { DisintegrationParticleSystem } from "./disintegration-particles.ts";
import dotGridShaderSource from "./dot-grid.wgsl?raw";
import { ExportService } from "./export-service.ts";
import { detectGpuColorConfig, type GpuColorConfig } from "./gpu-color-space.ts";
import { ProcessingPipeline } from "./processing-pipeline.ts";
import selectionRectShaderSource from "./selection-rect.wgsl?raw";
import { AsciiShader } from "./shaders/ascii-shader.ts";
import { BlobsShader } from "./shaders/blobs-shader.ts";
import { DitheringShader } from "./shaders/dithering-shader.ts";
import { GlassShader } from "./shaders/glass-shader.ts";
import { GlitchShader } from "./shaders/glitch-shader.ts";
import { HalftoneShader } from "./shaders/halftone-shader.ts";
import { MeltShader } from "./shaders/melt-shader.ts";
import type { ShaderContext } from "./shaders/shader-pass.ts";
import { ShaderRegistry } from "./shaders/shader-registry.ts";
import { TexturePool } from "./texture-pool.ts";
import actionLayerBlitShaderSource from "./action-layer-blit.wgsl?raw";
import { UIRenderer } from "./ui/ui-renderer.ts";
import { createElement } from "react";
import { EntityLabel } from "./ui/entity-label.tsx";
import { canvasUI } from "./ui/canvas-ui.ts";
import { perfOverlay } from "../engine/perf-overlay.ts";

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

  // UI renderer (text, boxes, icons via Slug + SDF + texture quads)
  #uiRenderer: UIRenderer | null = null;

  #entityShaderBindGroupLayout: GPUBindGroupLayout | null = null;
  #entityShaderUniformBuffer: GPUBuffer | null = null;
  #entityShaderSampler: GPUSampler | null = null;

  // Unified uniform data for all shaders (includes palette support)
  // All shaders now use the same larger buffer size for palette data
  #shaderUniformData = new ArrayBuffer(config.rendering.ditheringUniformSize);
  #shaderFloatView = new Float32Array(this.#shaderUniformData);
  #shaderUintView = new Uint32Array(this.#shaderUniformData);

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
      sourceRef: ImageBitmap | OffscreenCanvas;
      width: number;
      height: number;
    }
  > = new Map();

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

  // Palette sorting cache - avoid re-sorting every frame
  // Stores { original: RGBA[], sorted: RGBA[] } to detect when palette changes
  #sortedPaletteCache: { original: readonly RGBA[]; reversed: boolean; sorted: RGBA[] } | null =
    null;

  // Reusable canvas for Firefox-compatible video frame upload
  #videoUploadCanvas: OffscreenCanvas | null = null;
  #videoUploadCtx: OffscreenCanvasRenderingContext2D | null = null;

  // Disintegration particle system (GPU compute + instanced rendering)
  #particleSystem: DisintegrationParticleSystem | null = null;

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

  // Processing pipeline (adjustments, post-processing, bloom)
  #processingPipeline: ProcessingPipeline | null = null;

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
  #actionLayerLastBlurIntensity = -1;
  #actionLayerBlitBindGroupCached: GPUBindGroup | null = null;

  // Copy pass for showOriginal (rgba8unorm source → rgba16float output)
  #passthroughCopyPass: CopyPass | null = null;

  // Shader registry and context for delegated shader passes
  #shaderRegistry: ShaderRegistry | null = null;
  #shaderContext: ShaderContext | null = null;

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

  /** True if UI animations need another frame to complete. */
  get hasActiveUIAnimations(): boolean {
    return canvasUI.hasActiveAnimations || (this.#uiRenderer?.hasActiveAnimations ?? false);
  }

  /** Forward pointer events to the UI for hit testing. Returns true if consumed. */
  handleUIPointerEvent(type: "down" | "up" | "move", worldX: number, worldY: number): boolean {
    return canvasUI.handlePointerEvent(type, worldX, worldY);
  }

  /** Forward wheel events to the UI for scroll containers. Returns true if consumed. */
  handleUIWheelEvent(deltaX: number, deltaY: number, worldX: number, worldY: number): boolean {
    return canvasUI.handleWheelEvent(deltaX, deltaY, worldX, worldY);
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

    this.#device = await adapter.requestDevice({
      requiredLimits,
    });

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
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    // Initialize texture pool
    this.#texturePool = new TexturePool(this.#device, this.#colorConfig.intermediateFormat);

    this.#createGridPipeline();
    this.#createCompositionPipeline();
    this.#createEntityShaderResources();

    // Create ShaderContext from existing resources and initialize shader registry
    this.#shaderContext = {
      device: this.#device,
      uniformBuffer: this.#entityShaderUniformBuffer!,
      uniformData: this.#shaderUniformData,
      floatView: this.#shaderFloatView,
      uintView: this.#shaderUintView,
      sampler: this.#entityShaderSampler!,
      sortedPaletteCache: this.#sortedPaletteCache,
      texturePool: this.#texturePool,
      intermediateFormat: this.#colorConfig.intermediateFormat,
      supportsP3: this.#colorConfig.supportsP3,
    };

    this.#shaderRegistry = new ShaderRegistry();
    const asciiShader = new AsciiShader(this.#shaderContext);
    asciiShader.onEntityError = (entityId, error) => {
      if (!this.#entityErrors.has(entityId)) {
        this.#entityErrors.set(entityId, error);
        this.onEntityError?.(entityId, error);
      }
    };
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
        this.#shaderRegistry!.register(type, pass);
      }),
    );

    this.#createSelectionRectPipeline();
    this.#createActionLayerBlitPipeline();
    this.#processingPipeline = new ProcessingPipeline(
      this.#device,
      this.#colorConfig.intermediateFormat,
      this.#colorConfig.supportsP3,
    );
    this.#processingPipeline.initialize();
    this.#passthroughCopyPass = new CopyPass(this.#device, this.#colorConfig.intermediateFormat);

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

    // Initialize UI renderer (non-blocking — labels appear once font is loaded)
    this.#uiRenderer = new UIRenderer(
      this.#device,
      this.#canvasFormat,
      this.#viewportUniformBuffer!,
    );
    this.#uiRenderer.initialize().catch((e) => logger.error("UI renderer init failed:", e));

    // Initialize unified canvas UI overlay (context menu, debug, etc.)
    canvasUI.initialize(this.#uiRenderer);

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

  #createEntityShaderResources(): void {
    if (!this.#device) return;

    this.#entityShaderBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Entity shader bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    // Single unified buffer for all shaders (includes palette data)
    this.#entityShaderUniformBuffer = this.#device.createBuffer({
      label: "Entity shader uniforms",
      size: config.rendering.ditheringUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#entityShaderSampler = this.#device.createSampler({
      label: "Entity shader sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
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
    entity: ShaderCanvasEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    _outputTextureHasStorageBinding: boolean = false,
  ): void {
    if (
      !this.#device ||
      !this.#entityShaderBindGroupLayout ||
      !this.#entityShaderUniformBuffer ||
      !this.#entityShaderSampler
    ) {
      return;
    }

    const width = entity.originalSize.width;
    const height = entity.originalSize.height;

    // Check if blur needs to be applied (pre-processing, before color adjustments)
    const needsBlur = this.#processingPipeline!.needsBlur(entity);

    // Check if color adjustments need to be applied (pre-processing)
    const needsAdjustments = this.#processingPipeline!.needsAdjustments(entity);

    // Check if post-processing is enabled
    const postProcessEnabled = entity.shaderParams.postProcess?.enabled ?? false;

    const preProcessUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC;

    // Single encoder for the entire entity pipeline: blur → adjustments → shader → post-process
    const encoder = this.#device.createCommandEncoder({
      label: `Entity ${entity.id} pipeline`,
    });

    let shaderSourceTexture = sourceTexture;
    let blurOutputTexture: GPUTexture | null = null;
    let adjustmentsOutputTexture: GPUTexture | null = null;

    if (needsBlur) {
      blurOutputTexture = this.#texturePool
        ? this.#texturePool.acquire(width, height, preProcessUsage, `Blur output texture`)
        : this.#device.createTexture({
            label: `Blur output texture`,
            size: [width, height],
            format: this.#colorConfig.intermediateFormat,
            usage: preProcessUsage,
          });

      this.#processingPipeline!.applyBlur(entity, sourceTexture, blurOutputTexture, encoder);
      shaderSourceTexture = blurOutputTexture;
    }

    if (needsAdjustments) {
      adjustmentsOutputTexture = this.#texturePool
        ? this.#texturePool.acquire(width, height, preProcessUsage, `Adjustments output texture`)
        : this.#device.createTexture({
            label: `Adjustments output texture`,
            size: [width, height],
            format: this.#colorConfig.intermediateFormat,
            usage: preProcessUsage,
          });

      this.#processingPipeline!.applyAdjustments(
        entity,
        shaderSourceTexture,
        adjustmentsOutputTexture,
        encoder,
      );
      shaderSourceTexture = adjustmentsOutputTexture;
    }

    let mainShaderOutputTexture = outputTexture;
    let postProcessIntermediateTexture: GPUTexture | null = null;

    if (postProcessEnabled) {
      const intermediateUsage =
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST;

      postProcessIntermediateTexture = this.#texturePool
        ? this.#texturePool.acquire(
            width,
            height,
            intermediateUsage,
            `Post-process intermediate texture`,
          )
        : this.#device.createTexture({
            label: `Post-process intermediate texture`,
            size: [width, height],
            format: this.#colorConfig.intermediateFormat,
            usage: intermediateUsage,
          });

      mainShaderOutputTexture = postProcessIntermediateTexture;
    }

    this.#shaderRegistry!.applyShader(
      entity,
      shaderSourceTexture,
      mainShaderOutputTexture,
      encoder,
    );

    // Release pre-processing output textures back to pool (if used)
    if (blurOutputTexture) {
      if (this.#texturePool) {
        this.#texturePool.release(blurOutputTexture, width, height, preProcessUsage);
      } else {
        blurOutputTexture.destroy();
      }
    }
    if (adjustmentsOutputTexture) {
      if (this.#texturePool) {
        this.#texturePool.release(adjustmentsOutputTexture, width, height, preProcessUsage);
      } else {
        adjustmentsOutputTexture.destroy();
      }
    }

    if (postProcessEnabled && postProcessIntermediateTexture) {
      this.#processingPipeline!.applyPostProcessing(
        entity,
        postProcessIntermediateTexture,
        outputTexture,
        encoder,
      );

      const intermediateUsage =
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST;

      if (this.#texturePool) {
        this.#texturePool.release(postProcessIntermediateTexture, width, height, intermediateUsage);
      } else {
        postProcessIntermediateTexture.destroy();
      }
    }

    this.#device.queue.submit([encoder.finish()]);
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

  /**
   * Render an entity's image through its shader to a texture.
   * Returns the texture, caching it for future frames.
   */
  renderEntityToTexture(entity: ShaderCanvasEntity): GPUTexture | null {
    if (
      !this.#device ||
      !this.#entityShaderBindGroupLayout ||
      !this.#entityShaderUniformBuffer ||
      !this.#entityShaderSampler
    ) {
      return null;
    }

    // For animated media or shaders with continuous rendering (e.g., time-based): always re-render
    const shader = this.#shaderRegistry?.get(entity.shaderType);
    const isAnimating =
      (isAnimatedEntity(entity) && entity.playback?.isPlaying) ||
      (shader?.needsContinuousRender(entity) ?? false);

    // Check if we have a valid cached texture (skip cache for playing videos)
    const cachedTexture = this.#entityTextures.get(entity.id);
    if (!isAnimating && cachedTexture && !entity.textureDirty) {
      return cachedTexture;
    }

    const width = entity.originalSize.width;
    const height = entity.originalSize.height;

    // Source texture usage flags
    const sourceUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT;

    // Get the appropriate source for GPU upload
    const externalSource =
      entity.mediaSource.type === "video"
        ? this.#getVideoFrameSource(entity.mediaSource.videoElement, width, height)
        : entity.mediaSource.type === "image"
          ? entity.mediaSource.imageBitmap
          : entity.imageBitmap;

    // Check source texture cache: reuse if source image is unchanged
    const cachedSource = this.#entitySourceTextures.get(entity.id);
    let sourceTexture: GPUTexture;

    if (
      !isAnimating &&
      !entity.textureDirty &&
      cachedSource &&
      cachedSource.sourceRef === externalSource &&
      cachedSource.width === width &&
      cachedSource.height === height
    ) {
      // Source image is identical — reuse cached GPU texture, skip upload
      sourceTexture = cachedSource.texture;
    } else {
      // Source changed, dimensions changed, or animated media: need to (re-)upload
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

      this.#device.queue.copyExternalImageToTexture(
        { source: externalSource },
        { texture: sourceTexture, colorSpace: this.#colorConfig.textureColorSpace },
        [width, height],
      );

      this.#entitySourceTextures.set(entity.id, {
        texture: sourceTexture,
        sourceRef: externalSource,
        width,
        height,
      });
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

    // If showOriginal is enabled, bypass shader processing and blit source directly.
    // Uses CopyPass render pass instead of copyTextureToTexture because
    // source (rgba8unorm) and output (rgba16float) formats are not copy-compatible.
    if (entity.shaderParams.showOriginal) {
      this.#passthroughCopyPass!.execute(sourceTexture, outputTexture);

      // Cache and return (source texture stays in #entitySourceTextures)
      this.#entityTextures.set(entity.id, outputTexture);
      return outputTexture;
    }

    // Apply shader using unified method (handles both compute and fragment shader paths)
    this.#applyShaderToTexture(entity, sourceTexture, outputTexture);

    // Cache and return (source texture stays in #entitySourceTextures)
    this.#entityTextures.set(entity.id, outputTexture);
    return outputTexture;
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
    const uiScale = dpr / viewport.zoom;
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
    const entityBindGroups: { bindGroup: GPUBindGroup; entity: ShaderCanvasEntity }[] = [];
    const actionLayerBindGroups: { bindGroup: GPUBindGroup; entity: ShaderCanvasEntity }[] = [];
    let hasAnimatingContent = false;

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

      // Check if texture needs regeneration
      // For playing animated media, always consider texture dirty (frame changes every render)
      const isPlayingMedia = isAnimatedEntity(entity) && entity.playback?.isPlaying;
      const textureWasDirty = entity.textureDirty || isPlayingMedia;
      if (isPlayingMedia || this.needsContinuousRenderForEntity(entity)) {
        hasAnimatingContent = true;
      }

      // Render entity to texture if needed (this has its own submission for dirty textures)
      const entityTexture = this.renderEntityToTexture(entity);
      if (!entityTexture) continue;

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
        cached.lastHovered !== isHovered ||
        cached.lastSelected !== isSelected ||
        cached.lastDebugMode !== debugMode;

      let bindGroup: GPUBindGroup;

      if (needsNewBindGroup) {
        // Destroy old uniform buffer if exists (texture view is tied to texture lifecycle)
        if (cached && textureWasDirty) {
          cached.uniformBuffer.destroy();
        }

        // Create or reuse uniform buffer
        const uniformBuffer =
          cached && !textureWasDirty
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
          cached && !textureWasDirty ? cached.textureView : entityTexture.createView();

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
      if (actionLayerControllerActive && actionLayerController.hasEntity(entity.id)) {
        actionLayerBindGroups.push({ bindGroup, entity });
      } else {
        entityBindGroups.push({ bindGroup, entity });
      }
    }

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

    // Pass 2: Render entities + interleaved labels (z-ordered)
    // Labels render immediately after their parent entity so higher-z entities occlude them.
    const uiReady = this.#uiRenderer?.isReady;
    if (uiReady) {
      this.#uiRenderer!.begin();
    }

    for (const { bindGroup, entity } of entityBindGroups) {
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

      entityPass.setPipeline(this.#compositionPipeline);
      entityPass.setBindGroup(0, bindGroup);
      entityPass.draw(6);
      entityPass.end();

      // Render label for this entity immediately after its composition pass
      if (uiReady && selectedEntityIds.has(entity.id)) {
        const isDragging = entityDragVisual.isDragPhase();
        const sceneKey = `label-${entity.id}`;
        this.#uiRenderer!.updateScene(sceneKey, createElement(EntityLabel, { entity, isDragging }));
        const labelWorldX = entity.position.x + entity.size.width / 2;
        const gap = 8 * uiScale;
        const labelWorldY = entity.position.y - gap;
        this.#uiRenderer!.renderScene(
          sceneKey,
          labelWorldX,
          labelWorldY,
          encoder,
          targetView,
          uiScale,
          undefined,
          {
            offsetX: viewport.offset.x,
            offsetY: viewport.offset.y,
            zoom: viewport.zoom,
            width,
            height,
            dpr,
          },
        );
      }
    }

    // Pass 2a: Action layer blur overlay
    // Blur+dim everything, then re-render selected entities sharp on top
    const blurIntensity = actionLayerController.getBlurIntensity();
    if (
      blurIntensity > 0.01 &&
      this.#canvasFormat === this.#colorConfig.intermediateFormat &&
      this.#processingPipeline &&
      this.#actionLayerBlitPipeline &&
      this.#actionLayerBlitBindGroupLayout &&
      this.#actionLayerBlitUniformBuffer &&
      this.#actionLayerBlitSampler
    ) {
      // Get or create intermediate textures for full-screen blur
      const blurTextures = this.#getOrCreateActionLayerBlurTextures(width, height);
      if (blurTextures) {
        // Only re-run the expensive Kawase blur pipeline when content has actually changed
        const blurNeedsUpdate =
          !this.#actionLayerBlurCacheValid ||
          Math.abs(blurIntensity - this.#actionLayerLastBlurIntensity) > 0.001 ||
          state.dirty ||
          hasAnimatingContent;

        if (blurNeedsUpdate) {
          // Copy swapchain → input texture
          encoder.copyTextureToTexture(
            { texture },
            { texture: blurTextures.input },
            { width, height },
          );

          // Kawase blur: input → output
          this.#processingPipeline.encodeFullScreenBlur(
            encoder,
            blurTextures.input,
            blurTextures.output,
            width,
            height,
          );

          this.#actionLayerBlurCacheValid = true;
          this.#actionLayerLastBlurIntensity = blurIntensity;
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
    }

    // Reset blur cache when action layer blur is no longer rendering
    if (blurIntensity <= 0.01) {
      this.#actionLayerBlurCacheValid = false;
      this.#actionLayerLastBlurIntensity = -1;
    }

    // Always render action layer entities on top (sharp, after blur or normally)
    for (const { bindGroup, entity } of actionLayerBindGroups) {
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
      sharpPass.setPipeline(this.#compositionPipeline);
      sharpPass.setBindGroup(0, bindGroup);
      sharpPass.draw(6);
      sharpPass.end();

      // Render label for action layer entity (scene already updated in main pass)
      if (uiReady && selectedEntityIds.has(entity.id)) {
        const labelWorldX = entity.position.x + entity.size.width / 2;
        const gap = 8 * uiScale;
        const labelWorldY = entity.position.y - gap;
        this.#uiRenderer!.renderScene(
          `label-${entity.id}`,
          labelWorldX,
          labelWorldY,
          encoder,
          targetView,
          uiScale,
          undefined,
          {
            offsetX: viewport.offset.x,
            offsetY: viewport.offset.y,
            zoom: viewport.zoom,
            width,
            height,
            dpr,
          },
        );
      }
    }

    // Overlay UI (context menu, perf HUD, etc.) — fixed-position, viewport-anchored
    canvasUI.render(
      encoder,
      targetView,
      viewport,
      width,
      height,
      dpr,
      debugMode,
      perfOverlay.getSnapshot(),
    );

    // All UI scenes rendered — clear per-frame interaction dirty flags
    this.#uiRenderer?.endFrame();

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
    }

    // Single submission for all passes
    this.#device.queue.submit([encoder.finish()]);

    // Record frame stats for performance overlay
    this.#lastRenderTime = performance.now() - renderStart;
    this.#lastEntityCount = entities.length;
    this.#lastRenderedCount = entityBindGroups.length;

    // Advance texture pool frame counter and cleanup stale textures
    this.#texturePool?.nextFrame();
  }

  /**
   * Update grid configuration
   */
  setGridConfig(config: Partial<GridConfig>): void {
    this.#gridConfig = { ...this.#gridConfig, ...config };
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

    // Remove error buffers for this entity (delegated to dithering shader)
    const ditheringShader = this.#shaderRegistry?.get("dithering") as
      | import("./shaders/dithering-shader.ts").DitheringShader
      | undefined;
    ditheringShader?.removeEntity(entityId);

    // Remove time tracking for this entity (glass shader)
    this.#getGlassShader()?.removeEntity(entityId);

    // Clear any errors for this entity
    this.#entityErrors.delete(entityId);
  }

  /**
   * Snapshot an entity's rendered texture and create a disintegration overlay.
   * Called before removeEntityTexture — copies the GPU texture so the entity
   * can be removed immediately while the dust animation plays independently.
   */
  startDisintegration(entity: {
    id: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    rotation: number;
  }): void {
    const sourceTexture = this.#entityTextures.get(entity.id);
    if (!sourceTexture || !this.#device || !this.#compositionBindGroupLayout) return;

    // Copy the entity's rendered texture (so original can be destroyed freely)
    const snapshotTexture = this.#device.createTexture({
      label: `Disintegration snapshot ${entity.id}`,
      size: [sourceTexture.width, sourceTexture.height],
      format: sourceTexture.format,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    const encoder = this.#device.createCommandEncoder();
    encoder.copyTextureToTexture({ texture: sourceTexture }, { texture: snapshotTexture }, [
      sourceTexture.width,
      sourceTexture.height,
    ]);
    this.#device.queue.submit([encoder.finish()]);

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
    return this.#shaderRegistry?.get(entity.shaderType)?.needsContinuousRender(entity) ?? false;
  }

  // ── Per-entity time control ─────────────────────────────────────────

  #getGlassShader(): GlassShader | undefined {
    return this.#shaderRegistry?.get(ShaderType.glass) as GlassShader | undefined;
  }

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
      this.#getGlassShader()?.removeEntity(entity.id);
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

    // Destroy UI renderer
    this.#uiRenderer?.destroy();
    this.#uiRenderer = null;

    // Destroy processing pipeline
    this.#processingPipeline?.destroy();
    this.#processingPipeline = null;
    this.#passthroughCopyPass = null;

    // Destroy shader registry
    this.#shaderRegistry?.destroy();
    this.#shaderRegistry = null;
    this.#shaderContext = null;

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
    this.#entityShaderUniformBuffer?.destroy();
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
    this.#entityShaderBindGroupLayout = null;
    this.#context = null;
    this.#device = null;
  }
}
