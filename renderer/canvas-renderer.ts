import { config, type GridConfig } from "#config";
import type { RenderState } from "../engine/canvas-store.ts";
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
import dotGridShaderSource from "./dot-grid.wgsl?raw";
import { ExportService } from "./export-service.ts";
import { ProcessingPipeline } from "./processing-pipeline.ts";
import selectionRectShaderSource from "./selection-rect.wgsl?raw";
import { AsciiShader } from "./shaders/ascii-shader.ts";
import { BlobsShader } from "./shaders/blobs-shader.ts";
import { DitheringShader } from "./shaders/dithering-shader.ts";
import { GlassShader } from "./shaders/glass-shader.ts";
import { HalftoneShader } from "./shaders/halftone-shader.ts";
import { MeltShader } from "./shaders/melt-shader.ts";
import type { ShaderContext } from "./shaders/shader-pass.ts";
import { ShaderRegistry } from "./shaders/shader-registry.ts";
import { TexturePool } from "./texture-pool.ts";

export class InfiniteCanvasRenderer {
  readonly canvas: HTMLCanvasElement;

  #device: GPUDevice | null = null;
  #context: GPUCanvasContext | null = null;
  #canvasFormat!: GPUTextureFormat;

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

  // Texture pool for eliminating per-frame allocation churn
  #texturePool: TexturePool | null = null;

  // Palette sorting cache - avoid re-sorting every frame
  // Stores { original: RGBA[], sorted: RGBA[] } to detect when palette changes
  #sortedPaletteCache: { original: readonly RGBA[]; sorted: RGBA[] } | null = null;

  // Reusable canvas for Firefox-compatible video frame upload
  #videoUploadCanvas: OffscreenCanvas | null = null;
  #videoUploadCtx: OffscreenCanvasRenderingContext2D | null = null;

  // Cached canvas dimensions (updated by ResizeObserver, avoids getBoundingClientRect in render loop)
  #cachedCanvasWidth = 0;
  #cachedCanvasHeight = 0;
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

    this.#context = this.canvas.getContext("webgpu");
    if (!this.#context) {
      throw new Error("WebGPU context not available");
    }

    this.#canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.#context.configure({
      device: this.#device,
      format: this.#canvasFormat,
      alphaMode: "premultiplied",
    });

    // Initialize texture pool
    this.#texturePool = new TexturePool(this.#device);

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
    this.#processingPipeline = new ProcessingPipeline(this.#device);
    this.#processingPipeline.initialize();

    // Initialize export service with callbacks into renderer
    this.#exportService = new ExportService(
      this.#device,
      this.#texturePool,
      (entity, source, output) => this.#applyShaderToTexture(entity, source, output),
      (video, w, h) => this.#getVideoFrameSource(video, w, h),
    );

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
      // fillColor: vec4f (premultiplied alpha)
      v[base + 4] = fillColor[0] * fillColor[3];
      v[base + 5] = fillColor[1] * fillColor[3];
      v[base + 6] = fillColor[2] * fillColor[3];
      v[base + 7] = fillColor[3];
      // borderColor: vec4f (premultiplied alpha)
      v[base + 8] = borderColor[0] * borderColor[3];
      v[base + 9] = borderColor[1] * borderColor[3];
      v[base + 10] = borderColor[2] * borderColor[3];
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

    // Pipeline: source -> [blur] -> [adjustments] -> shader -> [post-process]
    let shaderSourceTexture = sourceTexture;
    let blurOutputTexture: GPUTexture | null = null;
    let adjustmentsOutputTexture: GPUTexture | null = null;

    if (needsBlur) {
      blurOutputTexture = this.#texturePool
        ? this.#texturePool.acquire(width, height, preProcessUsage, `Blur output texture`)
        : this.#device.createTexture({
            label: `Blur output texture`,
            size: [width, height],
            format: "rgba8unorm",
            usage: preProcessUsage,
          });

      this.#processingPipeline!.applyBlur(entity, sourceTexture, blurOutputTexture);
      shaderSourceTexture = blurOutputTexture;
    }

    if (needsAdjustments) {
      adjustmentsOutputTexture = this.#texturePool
        ? this.#texturePool.acquire(width, height, preProcessUsage, `Adjustments output texture`)
        : this.#device.createTexture({
            label: `Adjustments output texture`,
            size: [width, height],
            format: "rgba8unorm",
            usage: preProcessUsage,
          });

      // Apply adjustments: current source (possibly blurred) -> adjustmentsOutputTexture
      this.#processingPipeline!.applyAdjustments(
        entity,
        shaderSourceTexture,
        adjustmentsOutputTexture,
      );
      shaderSourceTexture = adjustmentsOutputTexture;
    }

    // Determine the target texture for the main shader
    // If post-processing is enabled, we render to an intermediate texture first
    let mainShaderOutputTexture = outputTexture;
    let postProcessIntermediateTexture: GPUTexture | null = null;

    if (postProcessEnabled) {
      // Create intermediate texture for main shader output
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
            format: "rgba8unorm",
            usage: intermediateUsage,
          });

      mainShaderOutputTexture = postProcessIntermediateTexture;
    }

    // Apply shader via registry (all 6 shader types are registered)
    this.#shaderRegistry!.applyShader(entity, shaderSourceTexture, mainShaderOutputTexture);

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

    // Apply post-processing if enabled
    if (postProcessEnabled && postProcessIntermediateTexture) {
      this.#processingPipeline!.applyPostProcessing(
        entity,
        postProcessIntermediateTexture,
        outputTexture,
      );

      // Release intermediate texture back to pool
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
  ): void {
    this.#entityFloatView[0] = entity.position.x;
    this.#entityFloatView[1] = entity.position.y;
    this.#entityFloatView[2] = entity.size.width;
    this.#entityFloatView[3] = entity.size.height;
    this.#entityFloatView[4] = (entity.rotation * Math.PI) / 180; // Convert to radians
    this.#entityUintView[5] = isHovered ? 1 : 0; // isHovered flag
    this.#entityUintView[6] = isSelected ? 1 : 0; // isSelected flag
    this.#entityUintView[7] = debugMode ? 1 : 0; // debugMode flag
    this.#entityFloatView[8] = entityDragVisual.getScale(entity.id); // visual drag scale
    this.#entityFloatView[9] = 0;
    this.#entityFloatView[10] = 0;
    this.#entityFloatView[11] = 0;
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
      this.#videoUploadCtx = this.#videoUploadCanvas.getContext("2d");
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
        { texture: sourceTexture },
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
      GPUTextureUsage.COPY_DST;

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
        format: "rgba8unorm",
        usage: outputUsage,
      });
    }

    // If showOriginal is enabled, bypass shader processing and copy source directly
    if (entity.shaderParams.showOriginal) {
      const encoder = this.#device.createCommandEncoder({
        label: `Entity ${entity.id} passthrough encoder`,
      });

      encoder.copyTextureToTexture({ texture: sourceTexture }, { texture: outputTexture }, [
        width,
        height,
      ]);

      this.#device.queue.submit([encoder.finish()]);

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

    // Update grid and viewport uniforms
    this.#updateGridUniforms(viewport);
    this.#updateViewportUniforms(viewport);

    this.#device.queue.writeBuffer(this.#gridUniformBuffer!, 0, this.#gridUniformData);
    this.#device.queue.writeBuffer(this.#viewportUniformBuffer!, 0, this.#viewportUniformData);

    // Sort entities in-place by z-index (avoid array copying)
    entities.sort((a, b) => a.zIndex - b.zIndex);

    // Pre-process entities: render to textures and prepare bind groups
    // Uses caching to avoid per-frame allocations
    const entityBindGroups: GPUBindGroup[] = [];

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

        // Update and write entity uniforms
        this.#updateEntityUniforms(entity, isHovered, isSelected, debugMode);
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
        this.#updateEntityUniforms(entity, isHovered, isSelected, debugMode);
        this.#device.queue.writeBuffer(cached.uniformBuffer, 0, this.#entityUniformData);
        bindGroup = cached.bindGroup;
      }

      entityBindGroups.push(bindGroup);
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

    // Pass 2: Render all entities (batched into same encoder)
    for (const bindGroup of entityBindGroups) {
      const entityPass = encoder.beginRenderPass({
        label: "Entity composition pass",
        colorAttachments: [
          {
            view: targetView,
            loadOp: "load", // Preserve previous content
            storeOp: "store",
          },
        ],
      });

      entityPass.setPipeline(this.#compositionPipeline);
      entityPass.setBindGroup(0, bindGroup);
      entityPass.draw(6); // 2 triangles = 6 vertices
      entityPass.end();
    }

    // Pass 3: Render all selection rectangles (drag-select and multi-select bounds)
    // Collect all active rectangles
    const selectionRects: Array<{
      bounds: Bounds;
      config: { borderColor: RGBA; backgroundColor: RGBA; borderWidth: number };
    }> = [];

    if (state.dragSelectBounds) {
      selectionRects.push({
        bounds: state.dragSelectBounds,
        config: config.selectionRectangle,
      });
    }

    if (state.multiSelectBounds) {
      selectionRects.push({
        bounds: state.multiSelectBounds,
        config: config.multiSelectBoundingBox,
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

    // Clear any errors for this entity
    this.#entityErrors.delete(entityId);
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
   * Render a video entity at a specific timestamp to an ImageBitmap.
   * Delegates to ExportService.
   */
  async renderVideoFrameAtTime(
    entity: ShaderCanvasEntity,
    timestampSeconds: number,
    videoOverride?: HTMLVideoElement,
  ): Promise<ImageBitmap | null> {
    return this.#exportService!.renderVideoFrameAtTime(entity, timestampSeconds, videoOverride);
  }

  /**
   * Render the current video frame through shaders WITHOUT seeking.
   * Delegates to ExportService.
   */
  async renderCurrentVideoFrame(
    entity: ShaderCanvasEntity,
    video: HTMLVideoElement,
  ): Promise<ImageBitmap | null> {
    return this.#exportService!.renderCurrentVideoFrame(entity, video);
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

    // Destroy processing pipeline
    this.#processingPipeline?.destroy();
    this.#processingPipeline = null;

    // Destroy shader registry
    this.#shaderRegistry?.destroy();
    this.#shaderRegistry = null;
    this.#shaderContext = null;

    // Destroy export service
    this.#exportService = null;

    // Destroy texture pool
    this.#texturePool?.destroy();
    this.#texturePool = null;

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
