import {
  clampWlurParams,
  clampWlurQuality,
  getWlurFineBand,
  getWlurFineKernelSize,
  getWlurFineSigmaCap,
  getWlurKawaseLevelCount,
  type WlurPixelRegion,
  getWlurBlurRegions,
  getWlurScratchKey,
  getWlurWorkingDimensions,
  wlurDirectionToIndex,
} from "./math.ts";
import { createPackedWlurCurveRows, getWlurCurveKey, resolveWlurCurve } from "./curve.ts";
import {
  createWlurBlurShaderSource,
  createWlurCompositeShaderSource,
  createWlurCopyShaderSource,
  createWlurFineBlurShaderSource,
  createWlurKawaseDownShaderSource,
  createWlurKawaseUpShaderSource,
} from "./shaders.ts";
import {
  DEFAULT_WLUR_PARAMS,
  WLUR_CURVE_LUT_SIZE,
  type WlurCurveInput,
  type WlurParams,
  type WlurPassConfig,
  type WlurQuality,
  type WlurTintColor,
} from "./types.ts";

interface WlurPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  quality?: Partial<WlurQuality>;
  label?: string;
}

interface FineTextures {
  key: string;
  intermediate: GPUTexture;
  output: GPUTexture;
}

interface KawaseTextures {
  key: string;
  /** Pyramid levels 1..N (index 0 = half resolution). */
  down: GPUTexture[];
  /** Blended upsamples for levels 1..N-1 (index 0 = half resolution). */
  up: GPUTexture[];
}

interface ScratchTextures {
  blurIntermediate: GPUTexture;
  blurOutput: GPUTexture;
}

export interface WlurEncodeOptions {
  /** Reuse a caller-owned output view, such as the current swapchain view. */
  outputView?: GPUTextureView;
  /** Reuse the persistent blur texture while still compositing the current input. */
  refreshBlur?: boolean;
  /**
   * Full-resolution source region changed since the previous blur. Only valid
   * when the caller has a complete persistent blur cache.
   */
  refreshRegion?: PixelRegion;
}

export interface WlurPassStats {
  blurPixels: number;
  fullBlurPixels: number;
}

interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class WlurPass {
  #device: GPUDevice;
  #format: GPUTextureFormat;
  #label: string;
  #quality: WlurQuality;

  #sampler: GPUSampler | null = null;
  #curveTexture: GPUTexture | null = null;
  #curveTextureView: GPUTextureView | null = null;
  #curveTextureKey = "";

  #copyBindGroupLayout: GPUBindGroupLayout | null = null;
  #copyPipeline: GPURenderPipeline | null = null;

  #blurBindGroupLayout: GPUBindGroupLayout | null = null;
  #blurXPipeline: GPURenderPipeline | null = null;
  #blurYPipeline: GPURenderPipeline | null = null;
  #blurXUniformBuffer: GPUBuffer | null = null;
  #blurYUniformBuffer: GPUBuffer | null = null;

  #compositeBindGroupLayout: GPUBindGroupLayout | null = null;
  #compositePipeline: GPURenderPipeline | null = null;
  #compositeUniformBuffer: GPUBuffer | null = null;

  #scratchTextures: Map<string, ScratchTextures> = new Map();
  #textureViews = new WeakMap<GPUTexture, GPUTextureView>();
  #copyBindings = new WeakMap<GPUTexture, GPUBindGroup>();
  #blurXBinding: { source: GPUTexture; bindGroup: GPUBindGroup } | null = null;
  #blurYBinding: { source: GPUTexture; bindGroup: GPUBindGroup } | null = null;
  #compositeBindings = new WeakMap<
    GPUTexture,
    {
      blurred: GPUTexture;
      fine: GPUTexture;
      bindGroup: GPUBindGroup;
    }
  >();

  #kawaseDownBindGroupLayout: GPUBindGroupLayout | null = null;
  #kawaseDownPipeline: GPURenderPipeline | null = null;
  #kawaseUpBindGroupLayout: GPUBindGroupLayout | null = null;
  #kawaseUpPipeline: GPURenderPipeline | null = null;
  #kawaseTextures: KawaseTextures | null = null;
  /** Result of the last pyramid run; reused while the caller keeps the blur cache. */
  #kawaseOutput: GPUTexture | null = null;
  /** Each pass in one encoder needs its own uniforms, so buffers are per level. */
  #kawaseDownBuffers: GPUBuffer[] = [];
  #kawaseUpBuffers: GPUBuffer[] = [];
  #kawaseBindings = new Map<
    GPUBuffer,
    { source: GPUTexture; detail: GPUTexture | null; bindGroup: GPUBindGroup }
  >();
  readonly #kawaseUniformData = new Float32Array(12);

  /** Hybrid fine layer: full-resolution Gaussian over the shallow band of the ramp. */
  #finePipelines = new Map<number, { x: GPURenderPipeline; y: GPURenderPipeline }>();
  #fineXUniformBuffer: GPUBuffer | null = null;
  #fineYUniformBuffer: GPUBuffer | null = null;
  #fineTextures: FineTextures | null = null;
  #fineBandKey = "";
  #fineBand: WlurPixelRegion | null = null;
  readonly #kawaseUniformCaches = new Map<GPUBuffer, Float32Array>();
  readonly #blurUniformData = new Float32Array(12);
  readonly #compositeUniformData = new Float32Array(20);
  readonly #blurXUniformCache = new Float32Array(12).fill(Number.NaN);
  readonly #blurYUniformCache = new Float32Array(12).fill(Number.NaN);
  readonly #compositeUniformCache = new Float32Array(20).fill(Number.NaN);
  #blurPixels = 0;
  #fullBlurPixels = 0;

  constructor(options: WlurPassOptions) {
    this.#device = options.device;
    this.#format = options.format;
    this.#label = options.label ?? "Wlur";
    this.#quality = clampWlurQuality(options.quality);
  }

  initialize(): void {
    if (this.#sampler) return;

    this.#sampler = this.#device.createSampler({
      label: `${this.#label} sampler`,
      magFilter: "linear",
      minFilter: "linear",
      // Mirror, not clamp: with clamp-to-edge every out-of-bounds blur tap re-reads the edge
      // row, so a 1px sliver at the viewport edge (background, a selection border) floods the
      // blur and snaps as content moves across it. Other passes only sample inside [0, 1].
      addressModeU: "mirror-repeat",
      addressModeV: "mirror-repeat",
    });
    this.#curveTexture = this.#device.createTexture({
      label: `${this.#label} curve LUT`,
      size: [WLUR_CURVE_LUT_SIZE, 3],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#curveTextureView = this.#curveTexture.createView();
    this.#curveTextureKey = "";

    this.#createCopyPipeline();
    this.#createBlurPipelines();
    this.#createCompositePipeline();
    this.#createKawasePipelines();
  }

  updateConfig(config: WlurPassConfig = {}): void {
    const nextQuality = clampWlurQuality({
      ...this.#quality,
      ...config.quality,
    });
    const kernelChanged = nextQuality.kernelSize !== this.#quality.kernelSize;
    const scaleChanged = nextQuality.resolutionScale !== this.#quality.resolutionScale;
    const algorithmChanged = nextQuality.algorithm !== this.#quality.algorithm;

    this.#quality = nextQuality;

    if (scaleChanged || algorithmChanged) {
      this.#destroyScratchTextures();
    }
    if (algorithmChanged) {
      this.#destroyKawaseTextures();
      this.#destroyFineTextures();
    }

    if (kernelChanged && this.#sampler) {
      this.#createBlurPipelines();
    }
  }

  getStats(): WlurPassStats {
    return { blurPixels: this.#blurPixels, fullBlurPixels: this.#fullBlurPixels };
  }

  encode(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    width: number,
    height: number,
    params: WlurParams,
    options: WlurEncodeOptions = {},
  ): void {
    this.initialize();

    if (
      !this.#sampler ||
      !this.#curveTextureView ||
      !this.#copyPipeline ||
      !this.#copyBindGroupLayout ||
      !this.#blurBindGroupLayout ||
      !this.#blurXPipeline ||
      !this.#blurYPipeline ||
      !this.#blurXUniformBuffer ||
      !this.#blurYUniformBuffer ||
      !this.#compositePipeline ||
      !this.#compositeBindGroupLayout ||
      !this.#compositeUniformBuffer
    ) {
      return;
    }

    const resolvedParams = clampWlurParams(params);
    const baseCurve = resolveWlurCurve(resolvedParams.curve);
    const tintCurve = resolveWlurCurve(resolvedParams.tint?.curve ?? resolvedParams.curve);
    const mixCurve = resolveWlurCurve(resolvedParams.mixCurve ?? resolvedParams.curve);
    this.#updateCurveTexture(baseCurve, tintCurve, mixCurve);

    if (this.#quality.algorithm === "kawase") {
      this.#encodeKawase(
        encoder,
        inputTexture,
        outputTexture,
        width,
        height,
        resolvedParams,
        options,
      );
      return;
    }

    if (resolvedParams.radius <= 0.001 && resolvedParams.noise <= 0.001) {
      this.#encodeCopyPass(encoder, inputTexture, outputTexture, options.outputView);
      return;
    }

    const working = getWlurWorkingDimensions(width, height, this.#quality.resolutionScale);
    const scratch = this.#getOrCreateScratchTextures(width, height);
    const usesReducedResolution = working.width !== width || working.height !== height;

    const directionIndex = wlurDirectionToIndex(resolvedParams.direction);
    const radiusScale = usesReducedResolution ? working.scale : 1;
    const blurRegions = getWlurBlurRegions(
      width,
      height,
      resolvedParams,
      this.#quality,
      options.refreshRegion,
    );
    const blurXRegion = blurRegions.blurX;
    const blurYRegion = blurRegions.blurY;
    const restoreThreshold = usesReducedResolution ? 0.05 : 0.001;
    if (options.refreshBlur !== false) {
      this.#blurPixels +=
        blurXRegion.width * blurXRegion.height + blurYRegion.width * blurYRegion.height;
      this.#fullBlurPixels += working.width * working.height * 2;

      // Blur X writes directly at the working resolution. Sampling the full-size
      // source with working-resolution texel steps fuses the old downsample pass
      // without shrinking the blur footprint.
      this.#writeBlurUniforms(
        this.#blurXUniformBuffer,
        working.width,
        working.height,
        working.width,
        working.height,
        resolvedParams.radius,
        resolvedParams.offset,
        resolvedParams.interpolation,
        directionIndex,
        radiusScale,
      );
      this.#encodeBlurPass(
        encoder,
        this.#blurXPipeline,
        this.#blurBindGroupLayout,
        this.#blurXUniformBuffer,
        inputTexture,
        scratch.blurIntermediate,
        `${this.#label} blur X pass`,
        blurXRegion,
        blurRegions.partial,
      );

      this.#writeBlurUniforms(
        this.#blurYUniformBuffer,
        working.width,
        working.height,
        working.width,
        working.height,
        resolvedParams.radius,
        resolvedParams.offset,
        resolvedParams.interpolation,
        directionIndex,
        radiusScale,
      );
      this.#encodeBlurPass(
        encoder,
        this.#blurYPipeline,
        this.#blurBindGroupLayout,
        this.#blurYUniformBuffer,
        scratch.blurIntermediate,
        scratch.blurOutput,
        `${this.#label} blur Y pass`,
        blurYRegion,
        blurRegions.partial,
      );
    }

    this.#writeCompositeUniforms(
      width,
      height,
      resolvedParams.offset,
      resolvedParams.interpolation,
      directionIndex,
      restoreThreshold,
      resolvedParams.tint?.color,
      resolvedParams.tint?.amount ?? 0,
      resolvedParams.noise,
      0,
    );
    this.#encodeCompositePass(
      encoder,
      inputTexture,
      scratch.blurOutput,
      // Unused outside Kawase hybrid mode; any texture satisfies the binding.
      scratch.blurOutput,
      outputTexture,
      options.outputView,
    );
  }

  destroy(): void {
    this.#destroyScratchTextures();
    this.#destroyKawaseTextures();
    this.#destroyFineTextures();
    this.#fineXUniformBuffer?.destroy();
    this.#fineYUniformBuffer?.destroy();
    this.#fineXUniformBuffer = null;
    this.#fineYUniformBuffer = null;
    this.#finePipelines.clear();
    this.#fineBandKey = "";
    this.#fineBand = null;
    for (const buffer of [...this.#kawaseDownBuffers, ...this.#kawaseUpBuffers]) buffer.destroy();
    this.#kawaseDownBuffers = [];
    this.#kawaseUpBuffers = [];
    this.#kawaseBindings.clear();
    this.#kawaseUniformCaches.clear();
    this.#kawaseDownBindGroupLayout = null;
    this.#kawaseDownPipeline = null;
    this.#kawaseUpBindGroupLayout = null;
    this.#kawaseUpPipeline = null;
    this.#blurXUniformBuffer?.destroy();
    this.#blurYUniformBuffer?.destroy();
    this.#compositeUniformBuffer?.destroy();
    this.#curveTexture?.destroy();
    this.#sampler = null;
    this.#curveTexture = null;
    this.#curveTextureView = null;
    this.#curveTextureKey = "";
    this.#copyBindGroupLayout = null;
    this.#copyPipeline = null;
    this.#blurBindGroupLayout = null;
    this.#blurXPipeline = null;
    this.#blurYPipeline = null;
    this.#blurXUniformBuffer = null;
    this.#blurYUniformBuffer = null;
    this.#compositeBindGroupLayout = null;
    this.#compositePipeline = null;
    this.#compositeUniformBuffer = null;
    this.#textureViews = new WeakMap();
    this.#copyBindings = new WeakMap();
    this.#blurXBinding = null;
    this.#blurYBinding = null;
    this.#compositeBindings = new WeakMap();
  }

  #createCopyPipeline(): void {
    const shaderModule = this.#device.createShaderModule({
      label: `${this.#label} copy shader`,
      code: createWlurCopyShaderSource(),
    });

    this.#copyBindGroupLayout = this.#device.createBindGroupLayout({
      label: `${this.#label} copy bind group layout`,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.#copyPipeline = this.#device.createRenderPipeline({
      label: `${this.#label} copy pipeline`,
      layout: this.#device.createPipelineLayout({
        label: `${this.#label} copy pipeline layout`,
        bindGroupLayouts: [this.#copyBindGroupLayout],
      }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  #createBlurPipelines(): void {
    this.#blurXBinding = null;
    this.#blurYBinding = null;
    this.#blurBindGroupLayout = this.#device.createBindGroupLayout({
      label: `${this.#label} blur bind group layout`,
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
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
      ],
    });

    this.#blurXUniformBuffer?.destroy();
    this.#blurYUniformBuffer?.destroy();
    this.#blurXUniformBuffer = this.#device.createBuffer({
      label: `${this.#label} blur X uniforms`,
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#blurYUniformBuffer = this.#device.createBuffer({
      label: `${this.#label} blur Y uniforms`,
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#blurXUniformCache.fill(Number.NaN);
    this.#blurYUniformCache.fill(Number.NaN);

    const blurPipelineLayout = this.#device.createPipelineLayout({
      label: `${this.#label} blur pipeline layout`,
      bindGroupLayouts: [this.#blurBindGroupLayout],
    });

    const blurXModule = this.#device.createShaderModule({
      label: `${this.#label} blur X shader`,
      code: createWlurBlurShaderSource("x", this.#quality.kernelSize),
    });
    const blurYModule = this.#device.createShaderModule({
      label: `${this.#label} blur Y shader`,
      code: createWlurBlurShaderSource("y", this.#quality.kernelSize),
    });

    this.#blurXPipeline = this.#device.createRenderPipeline({
      label: `${this.#label} blur X pipeline`,
      layout: blurPipelineLayout,
      vertex: { module: blurXModule, entryPoint: "vs_main" },
      fragment: {
        module: blurXModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.#blurYPipeline = this.#device.createRenderPipeline({
      label: `${this.#label} blur Y pipeline`,
      layout: blurPipelineLayout,
      vertex: { module: blurYModule, entryPoint: "vs_main" },
      fragment: {
        module: blurYModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  #createCompositePipeline(): void {
    const shaderModule = this.#device.createShaderModule({
      label: `${this.#label} composite shader`,
      code: createWlurCompositeShaderSource(),
    });

    this.#compositeBindGroupLayout = this.#device.createBindGroupLayout({
      label: `${this.#label} composite bind group layout`,
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
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
      ],
    });

    this.#compositeUniformBuffer = this.#device.createBuffer({
      label: `${this.#label} composite uniforms`,
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#compositeUniformCache.fill(Number.NaN);

    this.#compositePipeline = this.#device.createRenderPipeline({
      label: `${this.#label} composite pipeline`,
      layout: this.#device.createPipelineLayout({
        label: `${this.#label} composite pipeline layout`,
        bindGroupLayouts: [this.#compositeBindGroupLayout],
      }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  #getOrCreateScratchTextures(width: number, height: number): ScratchTextures {
    const key = getWlurScratchKey(width, height, this.#quality.resolutionScale);
    const cached = this.#scratchTextures.get(key);
    if (cached) return cached;

    // Keep scratch caching bounded to the active working size so fullscreen resizes
    // do not accumulate stale GPU textures over a long session.
    this.#destroyScratchTextures();

    const working = getWlurWorkingDimensions(width, height, this.#quality.resolutionScale);
    const workingUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;

    const entry: ScratchTextures = {
      blurIntermediate: this.#device.createTexture({
        label: `${this.#label} blur intermediate ${working.width}x${working.height}`,
        size: [working.width, working.height],
        format: this.#format,
        usage: workingUsage,
      }),
      blurOutput: this.#device.createTexture({
        label: `${this.#label} blur output ${working.width}x${working.height}`,
        size: [working.width, working.height],
        format: this.#format,
        usage: workingUsage,
      }),
    };

    this.#scratchTextures.set(key, entry);
    return entry;
  }

  #createKawasePipelines(): void {
    const fragmentTexture = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "float" },
    });
    const uniformEntry: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" },
    };

    this.#kawaseDownBindGroupLayout = this.#device.createBindGroupLayout({
      label: `${this.#label} Kawase down bind group layout`,
      entries: [
        uniformEntry,
        fragmentTexture(1),
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.#kawaseUpBindGroupLayout = this.#device.createBindGroupLayout({
      label: `${this.#label} Kawase up bind group layout`,
      entries: [
        uniformEntry,
        fragmentTexture(1),
        fragmentTexture(2),
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        fragmentTexture(4),
      ],
    });

    const createPipeline = (name: string, code: string, layout: GPUBindGroupLayout) => {
      const module = this.#device.createShaderModule({ label: `${this.#label} ${name}`, code });
      return this.#device.createRenderPipeline({
        label: `${this.#label} ${name} pipeline`,
        layout: this.#device.createPipelineLayout({
          label: `${this.#label} ${name} pipeline layout`,
          bindGroupLayouts: [layout],
        }),
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_main", targets: [{ format: this.#format }] },
        primitive: { topology: "triangle-list" },
      });
    };
    this.#kawaseDownPipeline = createPipeline(
      "Kawase down",
      createWlurKawaseDownShaderSource(),
      this.#kawaseDownBindGroupLayout,
    );
    this.#kawaseUpPipeline = createPipeline(
      "Kawase up",
      createWlurKawaseUpShaderSource(),
      this.#kawaseUpBindGroupLayout,
    );
  }

  #getOrCreateKawaseTextures(width: number, height: number, levelCount: number): KawaseTextures {
    const key = `${width}x${height}-${levelCount}`;
    if (this.#kawaseTextures?.key === key) return this.#kawaseTextures;
    this.#destroyKawaseTextures();

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const create = (label: string, w: number, h: number) =>
      this.#device.createTexture({
        label: `${this.#label} ${label} ${w}x${h}`,
        size: [w, h],
        format: this.#format,
        usage,
      });
    const down: GPUTexture[] = [];
    const up: GPUTexture[] = [];
    let w = width;
    let h = height;
    for (let level = 1; level <= levelCount; level++) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      down.push(create(`Kawase down ${level}`, w, h));
      if (level < levelCount) up.push(create(`Kawase up ${level}`, w, h));
    }

    this.#kawaseTextures = {
      key,
      down,
      up,
    };
    return this.#kawaseTextures;
  }

  #destroyKawaseTextures(): void {
    if (!this.#kawaseTextures) return;
    for (const texture of this.#kawaseTextures.down) texture.destroy();
    for (const texture of this.#kawaseTextures.up) texture.destroy();
    this.#kawaseTextures = null;
    this.#kawaseOutput = null;
    this.#kawaseBindings.clear();
  }

  #getKawaseBuffer(buffers: GPUBuffer[], index: number, name: string): GPUBuffer {
    let buffer = buffers[index];
    if (!buffer) {
      buffer = this.#device.createBuffer({
        label: `${this.#label} Kawase ${name} ${index + 1} uniforms`,
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      buffers[index] = buffer;
    }
    return buffer;
  }

  /** Fill `#kawaseUniformData` first; this uploads it if it changed for `buffer`. */
  #flushKawaseUniforms(buffer: GPUBuffer): void {
    const data = this.#kawaseUniformData;
    let cache = this.#kawaseUniformCaches.get(buffer);
    if (!cache) {
      cache = new Float32Array(12).fill(Number.NaN);
      this.#kawaseUniformCaches.set(buffer, cache);
    }
    this.#writeUniformBufferIfChanged(buffer, data, cache);
  }

  #encodeKawasePass(
    encoder: GPUCommandEncoder,
    label: string,
    pipeline: GPURenderPipeline,
    layout: GPUBindGroupLayout,
    uniformBuffer: GPUBuffer,
    source: GPUTexture,
    detail: GPUTexture | null,
    destination: GPUTexture,
  ): void {
    let binding = this.#kawaseBindings.get(uniformBuffer);
    if (binding?.source !== source || binding.detail !== detail) {
      const entries: GPUBindGroupEntry[] = detail
        ? [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: this.#getTextureView(source) },
            { binding: 2, resource: this.#getTextureView(detail) },
            { binding: 3, resource: this.#sampler! },
            { binding: 4, resource: this.#curveTextureView! },
          ]
        : [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: this.#getTextureView(source) },
            { binding: 2, resource: this.#sampler! },
          ];
      binding = {
        source,
        detail,
        bindGroup: this.#device.createBindGroup({ label, layout, entries }),
      };
      this.#kawaseBindings.set(uniformBuffer, binding);
    }

    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [
        {
          view: this.#getTextureView(destination),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding.bindGroup);
    pass.draw(3);
    pass.end();
  }

  /**
   * Dual Kawase variable blur. Downsamples to the deepest level the ramp needs, then upsamples
   * back to half resolution, blending each level toward its sharper downsample by the ramp's
   * target depth. The composite fades from the original below level 1, so the top of the ramp
   * keeps full-resolution detail instead of a uniformly scaled working texture.
   */
  #encodeKawase(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    width: number,
    height: number,
    params: WlurParams,
    options: WlurEncodeOptions,
  ): void {
    const levels = params.levels ?? 0;
    if (levels <= 0.001 && params.noise <= 0.001) {
      this.#encodeCopyPass(encoder, inputTexture, outputTexture, options.outputView);
      return;
    }

    const levelCount = getWlurKawaseLevelCount(levels);
    const textures = this.#getOrCreateKawaseTextures(width, height, levelCount);
    const directionIndex = wlurDirectionToIndex(params.direction);
    const spread = params.spread ?? 0;

    // Partial refresh is not supported: the pyramid is cheap, so a refresh rebuilds it whole.
    if (options.refreshBlur !== false || !this.#kawaseOutput) {
      let source = inputTexture;
      let sourceWidth = width;
      let sourceHeight = height;
      for (let level = 1; level <= levelCount; level++) {
        const destination = textures.down[level - 1]!;
        const buffer = this.#getKawaseBuffer(this.#kawaseDownBuffers, level - 1, "down");
        const data = this.#kawaseUniformData.fill(0);
        data[2] = sourceWidth;
        data[3] = sourceHeight;
        this.#flushKawaseUniforms(buffer);
        this.#encodeKawasePass(
          encoder,
          `${this.#label} Kawase down ${level}`,
          this.#kawaseDownPipeline!,
          this.#kawaseDownBindGroupLayout!,
          buffer,
          source,
          null,
          destination,
        );
        this.#blurPixels += destination.width * destination.height;
        this.#fullBlurPixels += destination.width * destination.height;
        source = destination;
        sourceWidth = destination.width;
        sourceHeight = destination.height;
      }

      for (let level = levelCount - 1; level >= 1; level--) {
        const coarser = level === levelCount - 1 ? textures.down[level]! : textures.up[level]!;
        const destination = textures.up[level - 1]!;
        const buffer = this.#getKawaseBuffer(this.#kawaseUpBuffers, level - 1, "up");
        const data = this.#kawaseUniformData.fill(0);
        data[2] = coarser.width;
        data[3] = coarser.height;
        data[4] = params.offset;
        data[5] = params.interpolation;
        data[6] = directionIndex;
        data[7] = level;
        data[8] = levels;
        data[9] = spread;
        this.#flushKawaseUniforms(buffer);
        this.#encodeKawasePass(
          encoder,
          `${this.#label} Kawase up ${level}`,
          this.#kawaseUpPipeline!,
          this.#kawaseUpBindGroupLayout!,
          buffer,
          coarser,
          textures.down[level - 1]!,
          destination,
        );
        this.#blurPixels += destination.width * destination.height;
        this.#fullBlurPixels += destination.width * destination.height;
      }

      this.#kawaseOutput = levelCount > 1 ? textures.up[0]! : textures.down[0]!;
    }

    const fineDepth = params.fineDepth ?? 0;
    const fine = this.#encodeFine(
      encoder,
      inputTexture,
      width,
      height,
      params,
      directionIndex,
      options.refreshBlur !== false,
    );

    this.#writeCompositeUniforms(
      width,
      height,
      params.offset,
      params.interpolation,
      directionIndex,
      // Crossfade original → blur over this much of the mix curve (Gaussian scale < 1 gets
      // 0.05 for free); near zero switches abruptly and fine patterns show a hard top edge.
      params.fade ?? DEFAULT_WLUR_PARAMS.fade,
      params.tint?.color,
      params.tint?.amount ?? 0,
      params.noise,
      Math.max(levels, 0.001),
      fine ? fineDepth : 0,
      fine ? fine.bandUv : undefined,
    );
    this.#encodeCompositePass(
      encoder,
      inputTexture,
      this.#kawaseOutput,
      fine?.textures.output ?? this.#kawaseOutput,
      outputTexture,
      options.outputView,
    );
  }

  #getFinePipelines(kernelSize: number): { x: GPURenderPipeline; y: GPURenderPipeline } {
    const cached = this.#finePipelines.get(kernelSize);
    if (cached) return cached;
    const layout = this.#device.createPipelineLayout({
      label: `${this.#label} fine blur pipeline layout`,
      bindGroupLayouts: [this.#blurBindGroupLayout!],
    });
    const create = (axis: "x" | "y") => {
      const module = this.#device.createShaderModule({
        label: `${this.#label} fine blur ${axis} shader`,
        code: createWlurFineBlurShaderSource(axis, kernelSize),
      });
      return this.#device.createRenderPipeline({
        label: `${this.#label} fine blur ${axis} pipeline`,
        layout,
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_main", targets: [{ format: this.#format }] },
        primitive: { topology: "triangle-list" },
      });
    };
    const pipelines = { x: create("x"), y: create("y") };
    this.#finePipelines.set(kernelSize, pipelines);
    return pipelines;
  }

  #getFineBand(width: number, height: number, params: WlurParams): WlurPixelRegion | null {
    const key = [
      width,
      height,
      params.direction,
      params.offset,
      params.interpolation,
      params.levels,
      params.fineDepth,
      getWlurCurveKey(params.curve),
    ].join("|");
    if (key !== this.#fineBandKey) {
      this.#fineBandKey = key;
      this.#fineBand = getWlurFineBand(width, height, params);
    }
    return this.#fineBand;
  }

  #destroyFineTextures(): void {
    this.#fineTextures?.intermediate.destroy();
    this.#fineTextures?.output.destroy();
    this.#fineTextures = null;
  }

  /**
   * Hybrid fine layer: separable full-resolution Gaussian over the shallow band of the ramp.
   * Returns the band (in screen uv) and its textures for the composite, or `null` when off.
   */
  #encodeFine(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    width: number,
    height: number,
    params: WlurParams,
    directionIndex: number,
    refresh: boolean,
  ): { textures: FineTextures; bandUv: [number, number, number, number] } | null {
    const fineDepth = params.fineDepth ?? 0;
    const band = this.#getFineBand(width, height, params);
    if (!band || fineDepth <= 0) return null;

    const key = `${band.width}x${band.height}`;
    let textures = this.#fineTextures;
    const created = textures?.key !== key;
    if (!textures || created) {
      this.#destroyFineTextures();
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
      const create = (name: string) =>
        this.#device.createTexture({
          label: `${this.#label} fine ${name} ${band.width}x${band.height}`,
          size: [band.width, band.height],
          format: this.#format,
          usage,
        });
      textures = { key, intermediate: create("intermediate"), output: create("output") };
      this.#fineTextures = textures;
    }

    const bandUv: [number, number, number, number] = [
      band.x / width,
      band.y / height,
      band.width / width,
      band.height / height,
    ];
    // The band can move without changing size (offset tuning), so refresh whenever asked or
    // whenever the textures are new.
    if (refresh || created) {
      const kernelSize = getWlurFineKernelSize(fineDepth);
      const pipelines = this.#getFinePipelines(kernelSize);
      const sigmaCap = getWlurFineSigmaCap(fineDepth);
      const sigmaAtFullRamp = 2 ** (params.levels ?? 0) - 1;
      this.#fineXUniformBuffer ??= this.#getKawaseBuffer([], 0, "fine X");
      this.#fineYUniformBuffer ??= this.#getKawaseBuffer([], 0, "fine Y");

      for (const [axis, buffer, pipeline, source, destination, texel] of [
        [
          "X",
          this.#fineXUniformBuffer,
          pipelines.x,
          inputTexture,
          textures.intermediate,
          [1 / width, 1 / height],
        ],
        [
          "Y",
          this.#fineYUniformBuffer,
          pipelines.y,
          textures.intermediate,
          textures.output,
          [1 / band.width, 1 / band.height],
        ],
      ] as const) {
        const data = this.#kawaseUniformData.fill(0);
        data.set(bandUv, 0);
        data[4] = texel[0];
        data[5] = texel[1];
        data[6] = sigmaCap;
        data[7] = sigmaAtFullRamp;
        data[8] = params.offset;
        data[9] = params.interpolation;
        data[10] = directionIndex;
        this.#flushKawaseUniforms(buffer);
        this.#encodeFineBlurPass(
          encoder,
          `${this.#label} fine ${axis} pass`,
          pipeline,
          buffer,
          source,
          destination,
        );
        this.#blurPixels += band.width * band.height;
        this.#fullBlurPixels += band.width * band.height;
      }
    }

    return { textures, bandUv };
  }

  #encodeFineBlurPass(
    encoder: GPUCommandEncoder,
    label: string,
    pipeline: GPURenderPipeline,
    uniformBuffer: GPUBuffer,
    source: GPUTexture,
    destination: GPUTexture,
  ): void {
    let binding = this.#kawaseBindings.get(uniformBuffer);
    if (binding?.source !== source) {
      binding = {
        source,
        detail: null,
        bindGroup: this.#device.createBindGroup({
          label: `${this.#label} fine blur bind group`,
          layout: this.#blurBindGroupLayout!,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: this.#getTextureView(source) },
            { binding: 2, resource: this.#sampler! },
            { binding: 3, resource: this.#curveTextureView! },
          ],
        }),
      };
      this.#kawaseBindings.set(uniformBuffer, binding);
    }
    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [
        {
          view: this.#getTextureView(destination),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding.bindGroup);
    pass.draw(3);
    pass.end();
  }

  #destroyScratchTextures(): void {
    for (const entry of this.#scratchTextures.values()) {
      entry.blurIntermediate.destroy();
      entry.blurOutput.destroy();
    }
    this.#scratchTextures.clear();
  }

  #updateCurveTexture(
    baseCurve: WlurCurveInput | undefined,
    tintCurve: WlurCurveInput | undefined,
    mixCurve: WlurCurveInput | undefined,
  ): void {
    if (!this.#curveTexture) return;

    const key = [
      getWlurCurveKey(baseCurve),
      getWlurCurveKey(tintCurve),
      getWlurCurveKey(mixCurve),
    ].join("|");
    if (key === this.#curveTextureKey) {
      return;
    }

    const data = createPackedWlurCurveRows([baseCurve, tintCurve, mixCurve] as const);
    this.#device.queue.writeTexture(
      { texture: this.#curveTexture },
      data,
      {
        bytesPerRow: WLUR_CURVE_LUT_SIZE * 4,
        rowsPerImage: 3,
      },
      {
        width: WLUR_CURVE_LUT_SIZE,
        height: 3,
        depthOrArrayLayers: 1,
      },
    );
    this.#curveTextureKey = key;
  }

  #writeBlurUniforms(
    buffer: GPUBuffer,
    outputWidth: number,
    outputHeight: number,
    sourceWidth: number,
    sourceHeight: number,
    radius: number,
    offset: number,
    interpolation: number,
    directionIndex: number,
    radiusScale: number,
  ): void {
    const data = this.#blurUniformData;
    data[0] = outputWidth;
    data[1] = outputHeight;
    data[2] = sourceWidth;
    data[3] = sourceHeight;
    data[4] = radius;
    data[5] = offset;
    data[6] = interpolation;
    data[7] = directionIndex;
    data[8] = radiusScale;
    data[9] = 0;
    data[10] = 0;
    data[11] = 0;
    this.#writeUniformBufferIfChanged(
      buffer,
      data,
      buffer === this.#blurXUniformBuffer ? this.#blurXUniformCache : this.#blurYUniformCache,
    );
  }

  #writeCompositeUniforms(
    width: number,
    height: number,
    offset: number,
    interpolation: number,
    directionIndex: number,
    restoreThreshold: number,
    tintColor: WlurTintColor | undefined,
    tintAmount: number,
    noise: number,
    kawaseLevels: number,
    fineDepth = 0,
    fineBand: readonly [number, number, number, number] = [0, 0, 1, 1],
  ): void {
    const data = this.#compositeUniformData;
    data[0] = width;
    data[1] = height;
    data[2] = restoreThreshold;
    data[3] = noise > 0.001 ? noise : 0;
    data[4] = offset;
    data[5] = interpolation;
    data[6] = directionIndex;
    data[7] = 0;
    data[8] = tintColor?.[0] ?? 0;
    data[9] = tintColor?.[1] ?? 0;
    data[10] = tintColor?.[2] ?? 0;
    data[11] = tintAmount;
    data[12] = kawaseLevels;
    data[13] = fineDepth;
    data[14] = 0;
    data[15] = 0;
    data[16] = fineBand[0];
    data[17] = fineBand[1];
    data[18] = fineBand[2];
    data[19] = fineBand[3];
    this.#writeUniformBufferIfChanged(
      this.#compositeUniformBuffer!,
      data,
      this.#compositeUniformCache,
    );
  }

  #writeUniformBufferIfChanged(buffer: GPUBuffer, data: Float32Array, cached: Float32Array): void {
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== cached[i]) {
        this.#device.queue.writeBuffer(buffer, 0, data);
        cached.set(data);
        return;
      }
    }
  }

  #getTextureView(texture: GPUTexture): GPUTextureView {
    const cached = this.#textureViews.get(texture);
    if (cached) return cached;
    const view = texture.createView();
    this.#textureViews.set(texture, view);
    return view;
  }

  #encodeCopyPass(
    encoder: GPUCommandEncoder,
    sourceTexture: GPUTexture,
    destinationTexture: GPUTexture,
    destinationView?: GPUTextureView,
  ): void {
    let bindGroup = this.#copyBindings.get(sourceTexture);
    if (!bindGroup) {
      bindGroup = this.#device.createBindGroup({
        label: `${this.#label} copy bind group`,
        layout: this.#copyBindGroupLayout!,
        entries: [
          { binding: 0, resource: this.#getTextureView(sourceTexture) },
          { binding: 1, resource: this.#sampler! },
        ],
      });
      this.#copyBindings.set(sourceTexture, bindGroup);
    }

    const pass = encoder.beginRenderPass({
      label: `${this.#label} copy pass`,
      colorAttachments: [
        {
          view: destinationView ?? this.#getTextureView(destinationTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.#copyPipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  #encodeBlurPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    bindGroupLayout: GPUBindGroupLayout,
    uniformBuffer: GPUBuffer,
    sourceTexture: GPUTexture,
    destinationTexture: GPUTexture,
    label: string,
    region: PixelRegion,
    preserve: boolean,
  ): void {
    const isBlurX = uniformBuffer === this.#blurXUniformBuffer;
    let binding = isBlurX ? this.#blurXBinding : this.#blurYBinding;
    if (binding?.source !== sourceTexture) {
      binding = {
        source: sourceTexture,
        bindGroup: this.#device.createBindGroup({
          label,
          layout: bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: this.#getTextureView(sourceTexture) },
            { binding: 2, resource: this.#sampler! },
            { binding: 3, resource: this.#curveTextureView! },
          ],
        }),
      };
      if (isBlurX) this.#blurXBinding = binding;
      else this.#blurYBinding = binding;
    }

    if (region.width <= 0 || region.height <= 0) return;

    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [
        {
          view: this.#getTextureView(destinationTexture),
          loadOp: preserve ? "load" : "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding.bindGroup);
    pass.setScissorRect(region.x, region.y, region.width, region.height);
    pass.draw(3);
    pass.end();
  }

  #encodeCompositePass(
    encoder: GPUCommandEncoder,
    originalTexture: GPUTexture,
    blurredTexture: GPUTexture,
    fineTexture: GPUTexture,
    destinationTexture: GPUTexture,
    destinationView?: GPUTextureView,
  ): void {
    let binding = this.#compositeBindings.get(originalTexture);
    if (binding?.blurred !== blurredTexture || binding.fine !== fineTexture) {
      binding = {
        blurred: blurredTexture,
        fine: fineTexture,
        bindGroup: this.#device.createBindGroup({
          label: `${this.#label} composite bind group`,
          layout: this.#compositeBindGroupLayout!,
          entries: [
            { binding: 0, resource: { buffer: this.#compositeUniformBuffer! } },
            { binding: 1, resource: this.#getTextureView(originalTexture) },
            { binding: 2, resource: this.#getTextureView(blurredTexture) },
            { binding: 3, resource: this.#sampler! },
            { binding: 4, resource: this.#curveTextureView! },
            { binding: 5, resource: this.#getTextureView(fineTexture) },
          ],
        }),
      };
      this.#compositeBindings.set(originalTexture, binding);
    }

    const pass = encoder.beginRenderPass({
      label: `${this.#label} composite pass`,
      colorAttachments: [
        {
          view: destinationView ?? this.#getTextureView(destinationTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.#compositePipeline!);
    pass.setBindGroup(0, binding.bindGroup);
    pass.draw(3);
    pass.end();
  }
}
