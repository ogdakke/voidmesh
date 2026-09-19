import {
  clampWlurParams,
  clampWlurQuality,
  getWlurEffectRegion,
  getWlurScratchKey,
  getWlurWorkingDimensions,
  wlurDirectionToIndex,
} from "./math.ts";
import { createPackedWlurCurveRows, getWlurCurveKey, resolveWlurCurve } from "./curve.ts";
import {
  createWlurBlurShaderSource,
  createWlurCompositeShaderSource,
  createWlurCopyShaderSource,
  createWlurNoiseShaderSource,
} from "./shaders.ts";
import {
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

interface ScratchTextures {
  blurIntermediate: GPUTexture;
  blurOutput: GPUTexture;
  composite: GPUTexture;
}

export interface WlurEncodeOptions {
  /** Reuse a caller-owned output view, such as the current swapchain view. */
  outputView?: GPUTextureView;
  /** Reuse the persistent blur texture while still compositing the current input. */
  refreshBlur?: boolean;
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

  #noiseBindGroupLayout: GPUBindGroupLayout | null = null;
  #noisePipeline: GPURenderPipeline | null = null;
  #noiseUniformBuffer: GPUBuffer | null = null;

  #scratchTextures: Map<string, ScratchTextures> = new Map();
  #textureViews = new WeakMap<GPUTexture, GPUTextureView>();
  #copyBindings = new WeakMap<GPUTexture, GPUBindGroup>();
  #blurXBinding: { source: GPUTexture; bindGroup: GPUBindGroup } | null = null;
  #blurYBinding: { source: GPUTexture; bindGroup: GPUBindGroup } | null = null;
  #compositeBindings = new WeakMap<
    GPUTexture,
    {
      blurred: GPUTexture;
      bindGroup: GPUBindGroup;
    }
  >();
  #noiseBinding: { source: GPUTexture; bindGroup: GPUBindGroup } | null = null;
  readonly #blurUniformData = new Float32Array(12);
  readonly #compositeUniformData = new Float32Array(12);
  readonly #noiseUniformData = new Float32Array(8);
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
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
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
    this.#createNoisePipeline();
  }

  updateConfig(config: WlurPassConfig = {}): void {
    const nextQuality = clampWlurQuality({
      ...this.#quality,
      ...config.quality,
    });
    const kernelChanged = nextQuality.kernelSize !== this.#quality.kernelSize;
    const scaleChanged = nextQuality.resolutionScale !== this.#quality.resolutionScale;

    this.#quality = nextQuality;

    if (scaleChanged) {
      this.#destroyScratchTextures();
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
      !this.#compositeUniformBuffer ||
      !this.#noisePipeline ||
      !this.#noiseBindGroupLayout ||
      !this.#noiseUniformBuffer
    ) {
      return;
    }

    const resolvedParams = clampWlurParams(params);
    const baseCurve = resolveWlurCurve(resolvedParams.curve);
    const tintCurve = resolveWlurCurve(resolvedParams.tint?.curve ?? resolvedParams.curve);
    const mixCurve = resolveWlurCurve(resolvedParams.mixCurve ?? resolvedParams.curve);
    this.#updateCurveTexture(baseCurve, tintCurve, mixCurve);

    if (resolvedParams.radius <= 0.001 && resolvedParams.noise <= 0.001) {
      this.#encodeCopyPass(encoder, inputTexture, outputTexture, options.outputView);
      return;
    }

    const working = getWlurWorkingDimensions(width, height, this.#quality.resolutionScale);
    const scratch = this.#getOrCreateScratchTextures(width, height);
    const usesReducedResolution = working.width !== width || working.height !== height;

    const directionIndex = wlurDirectionToIndex(resolvedParams.direction);
    const radiusScale = usesReducedResolution ? working.scale : 1;
    const blurYRegion = getWlurEffectRegion(working.width, working.height, resolvedParams);
    const halfKernel = (this.#quality.kernelSize - 1) / 2;
    const blurXRegion = {
      x: blurYRegion.x,
      y: Math.max(0, blurYRegion.y - halfKernel),
      width: blurYRegion.width,
      height:
        Math.min(working.height, blurYRegion.y + blurYRegion.height + halfKernel) -
        Math.max(0, blurYRegion.y - halfKernel),
    };
    const compositeTarget = resolvedParams.noise > 0.001 ? scratch.composite : outputTexture;
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
    );
    this.#encodeCompositePass(
      encoder,
      inputTexture,
      scratch.blurOutput,
      compositeTarget,
      resolvedParams.noise <= 0.001 ? options.outputView : undefined,
    );

    if (resolvedParams.noise <= 0.001) {
      return;
    }

    this.#writeNoiseUniforms(
      width,
      height,
      resolvedParams.offset,
      resolvedParams.interpolation,
      directionIndex,
      resolvedParams.noise,
    );
    this.#encodeNoisePass(encoder, scratch.composite, outputTexture, options.outputView);
  }

  destroy(): void {
    this.#destroyScratchTextures();
    this.#blurXUniformBuffer?.destroy();
    this.#blurYUniformBuffer?.destroy();
    this.#compositeUniformBuffer?.destroy();
    this.#noiseUniformBuffer?.destroy();
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
    this.#noiseBindGroupLayout = null;
    this.#noisePipeline = null;
    this.#noiseUniformBuffer = null;
    this.#textureViews = new WeakMap();
    this.#copyBindings = new WeakMap();
    this.#blurXBinding = null;
    this.#blurYBinding = null;
    this.#compositeBindings = new WeakMap();
    this.#noiseBinding = null;
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
      ],
    });

    this.#compositeUniformBuffer = this.#device.createBuffer({
      label: `${this.#label} composite uniforms`,
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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

  #createNoisePipeline(): void {
    const shaderModule = this.#device.createShaderModule({
      label: `${this.#label} noise shader`,
      code: createWlurNoiseShaderSource(),
    });

    this.#noiseBindGroupLayout = this.#device.createBindGroupLayout({
      label: `${this.#label} noise bind group layout`,
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

    this.#noiseUniformBuffer = this.#device.createBuffer({
      label: `${this.#label} noise uniforms`,
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#noisePipeline = this.#device.createRenderPipeline({
      label: `${this.#label} noise pipeline`,
      layout: this.#device.createPipelineLayout({
        label: `${this.#label} noise pipeline layout`,
        bindGroupLayouts: [this.#noiseBindGroupLayout],
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
    const compositeUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;

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
      composite: this.#device.createTexture({
        label: `${this.#label} composite ${width}x${height}`,
        size: [width, height],
        format: this.#format,
        usage: compositeUsage,
      }),
    };

    this.#scratchTextures.set(key, entry);
    return entry;
  }

  #destroyScratchTextures(): void {
    for (const entry of this.#scratchTextures.values()) {
      entry.blurIntermediate.destroy();
      entry.blurOutput.destroy();
      entry.composite.destroy();
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
    this.#device.queue.writeBuffer(buffer, 0, data);
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
  ): void {
    const data = this.#compositeUniformData;
    data[0] = width;
    data[1] = height;
    data[2] = restoreThreshold;
    data[3] = 0;
    data[4] = offset;
    data[5] = interpolation;
    data[6] = directionIndex;
    data[7] = 0;
    data[8] = tintColor?.[0] ?? 0;
    data[9] = tintColor?.[1] ?? 0;
    data[10] = tintColor?.[2] ?? 0;
    data[11] = tintAmount;
    this.#device.queue.writeBuffer(this.#compositeUniformBuffer!, 0, data);
  }

  #writeNoiseUniforms(
    width: number,
    height: number,
    offset: number,
    interpolation: number,
    directionIndex: number,
    strength: number,
  ): void {
    const data = this.#noiseUniformData;
    data[0] = width;
    data[1] = height;
    data[2] = strength;
    data[3] = 0;
    data[4] = offset;
    data[5] = interpolation;
    data[6] = directionIndex;
    data[7] = 0;
    this.#device.queue.writeBuffer(this.#noiseUniformBuffer!, 0, data);
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

    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [
        {
          view: this.#getTextureView(destinationTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, binding.bindGroup);
    if (region.width > 0 && region.height > 0) {
      pass.setScissorRect(region.x, region.y, region.width, region.height);
      pass.draw(3);
    }
    pass.end();
  }

  #encodeCompositePass(
    encoder: GPUCommandEncoder,
    originalTexture: GPUTexture,
    blurredTexture: GPUTexture,
    destinationTexture: GPUTexture,
    destinationView?: GPUTextureView,
  ): void {
    let binding = this.#compositeBindings.get(originalTexture);
    if (binding?.blurred !== blurredTexture) {
      binding = {
        blurred: blurredTexture,
        bindGroup: this.#device.createBindGroup({
          label: `${this.#label} composite bind group`,
          layout: this.#compositeBindGroupLayout!,
          entries: [
            { binding: 0, resource: { buffer: this.#compositeUniformBuffer! } },
            { binding: 1, resource: this.#getTextureView(originalTexture) },
            { binding: 2, resource: this.#getTextureView(blurredTexture) },
            { binding: 3, resource: this.#sampler! },
            { binding: 4, resource: this.#curveTextureView! },
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

  #encodeNoisePass(
    encoder: GPUCommandEncoder,
    sourceTexture: GPUTexture,
    destinationTexture: GPUTexture,
    destinationView?: GPUTextureView,
  ): void {
    let binding = this.#noiseBinding;
    if (binding?.source !== sourceTexture) {
      binding = {
        source: sourceTexture,
        bindGroup: this.#device.createBindGroup({
          label: `${this.#label} noise bind group`,
          layout: this.#noiseBindGroupLayout!,
          entries: [
            { binding: 0, resource: { buffer: this.#noiseUniformBuffer! } },
            { binding: 1, resource: this.#getTextureView(sourceTexture) },
            { binding: 2, resource: this.#sampler! },
            { binding: 3, resource: this.#curveTextureView! },
          ],
        }),
      };
      this.#noiseBinding = binding;
    }

    const pass = encoder.beginRenderPass({
      label: `${this.#label} noise pass`,
      colorAttachments: [
        {
          view: destinationView ?? this.#getTextureView(destinationTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.#noisePipeline!);
    pass.setBindGroup(0, binding.bindGroup);
    pass.draw(3);
    pass.end();
  }
}
