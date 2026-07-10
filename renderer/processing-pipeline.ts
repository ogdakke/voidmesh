import {
  bloomFilterRadiusToRenderer,
  blurParamToKawaseParams,
  config,
  MAX_BLUR_MIP_LEVELS,
} from "#config";
import type { EffectRenderEntity } from "./effect-render-entity.ts";
import adjustmentsShaderSource from "./adjustments.wgsl?raw";
import bloomDownsampleShaderSource from "./bloom-downsample.wgsl?raw";
import bloomUpsampleShaderSource from "./bloom-upsample.wgsl?raw";
import kawaseDownsampleShaderSource from "./kawase-downsample.wgsl?raw";
import kawaseUpsampleShaderSource from "./kawase-upsample.wgsl?raw";
import postProcessShaderSource from "./post-process.wgsl?raw";
import textureMixShaderSource from "./texture-mix.wgsl?raw";
import { ByteBudgetCache, type ByteBudgetCacheStats } from "./byte-budget-cache.ts";
/** Number of mip levels in the bloom chain (determines blur spread) */
const BLOOM_MIP_LEVELS = 5;

export function getBloomMipLevelCount(width: number, height: number): number {
  const maxDimension = Math.max(width, height);
  if (maxDimension <= 128) return 2;
  if (maxDimension <= 256) return 3;
  if (maxDimension <= 512) return 4;
  return BLOOM_MIP_LEVELS;
}

interface ExternalTextureSource {
  texture: GPUExternalTexture;
}

interface BlurUniformSet {
  downsample: GPUBuffer[];
  upsample: GPUBuffer[];
  mix: GPUBuffer;
}

interface BloomUniformSet {
  downsample: GPUBuffer[];
  upsample: GPUBuffer[];
}

interface PostProcessBindGroupCacheEntry {
  uniformBuffer: GPUBuffer;
  inputTexture: GPUTexture;
  bloomTexture: GPUTexture | null;
  bindGroup: GPUBindGroup;
}

interface BloomBindGroupCacheEntry {
  dimensionsKey: string;
  sourceTexture: GPUTexture;
  downsample: GPUBindGroup[];
  upsample: GPUBindGroup[];
}

type BlurInputSource =
  | { kind: "texture"; texture: GPUTexture }
  | { kind: "external"; texture: GPUExternalTexture };

function createExternalTextureShaderSource(
  source: string,
  textureName = "sourceTexture",
  samplerName = "sourceSampler",
): string {
  const textureDeclaration = new RegExp(
    `@group\\(0\\)\\s+@binding\\(1\\)\\s+var\\s+${textureName}\\s*:\\s*texture_2d<f32>;`,
  );
  const textureSample = new RegExp(`textureSample\\(${textureName},\\s*${samplerName},`, "g");

  const rewritten = source
    .replace(textureDeclaration, `@group(0) @binding(1) var ${textureName}: texture_external;`)
    .replace(textureSample, `textureSampleBaseClampToEdge(${textureName}, ${samplerName},`);

  if (rewritten === source || !rewritten.includes("texture_external")) {
    throw new Error(`Failed to rewrite ${textureName} shader source for external texture input.`);
  }
  return rewritten;
}

export class ProcessingPipeline {
  #device: GPUDevice;
  #intermediateFormat: GPUTextureFormat;
  #supportsP3: boolean;

  // Adjustments (pre-processing) pipeline
  #adjustmentsPipeline: GPURenderPipeline | null = null;
  #adjustmentsExternalPipeline: GPURenderPipeline | null = null;
  #adjustmentsBindGroupLayout: GPUBindGroupLayout | null = null;
  #adjustmentsExternalBindGroupLayout: GPUBindGroupLayout | null = null;
  #adjustmentsUniformBuffers = new Map<string, GPUBuffer>();
  #adjustmentsSampler: GPUSampler | null = null;
  #adjustmentsUniformData = new ArrayBuffer(config.rendering.adjustmentsUniformSize);
  #adjustmentsFloatView = new Float32Array(this.#adjustmentsUniformData);

  // Dual Kawase blur (pre-processing) pipeline
  #blurDownsamplePipeline: GPURenderPipeline | null = null;
  #blurExternalDownsamplePipeline: GPURenderPipeline | null = null;
  #blurUpsamplePipeline: GPURenderPipeline | null = null;
  #blurDownsampleBindGroupLayout: GPUBindGroupLayout | null = null;
  #blurExternalDownsampleBindGroupLayout: GPUBindGroupLayout | null = null;
  #blurUpsampleBindGroupLayout: GPUBindGroupLayout | null = null;
  // Per-level uniform buffers (enables single command encoder submission)
  #blurDownsampleUniformBuffers: GPUBuffer[] = [];
  #blurUpsampleUniformBuffers: GPUBuffer[] = [];
  #blurSampler: GPUSampler | null = null;
  // Mip chain textures cached per entity dimensions (keyed by "WxH")
  #blurMipChainCache: Map<
    string,
    {
      textures: GPUTexture[];
      width: number;
      height: number;
      byteSize: number;
    }
  > = new Map();
  // Cross-level blend mix pipeline
  #blurMixPipeline: GPURenderPipeline | null = null;
  #blurMixBindGroupLayout: GPUBindGroupLayout | null = null;
  #blurMixUniformBuffer: GPUBuffer | null = null;
  // Blend textures cached per entity dimensions (keyed by "WxH")
  #blurBlendTextureCache: Map<
    string,
    {
      textureA: GPUTexture;
      textureB: GPUTexture;
      width: number;
      height: number;
      byteSize: number;
    }
  > = new Map();

  // Post-processing pipeline
  #postProcessPipeline: GPURenderPipeline | null = null;
  #postProcessBindGroupLayout: GPUBindGroupLayout | null = null;
  #postProcessUniformBuffers = new Map<string, GPUBuffer>();
  #postProcessSampler: GPUSampler | null = null;
  #postProcessUniformData = new ArrayBuffer(config.rendering.postProcessUniformSize);
  #postProcessFloatView = new Float32Array(this.#postProcessUniformData);
  #postProcessUintView = new Uint32Array(this.#postProcessUniformData);
  #postProcessTime = 0; // Animated time for grain effect
  #postProcessBindGroupCache = new Map<string, PostProcessBindGroupCacheEntry>();
  #dummyBloomTexture: GPUTexture | null = null;
  #dummyBloomTextureView: GPUTextureView | null = null;
  #textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();

  // Bloom pipeline (multi-pass downsample/upsample)
  #bloomDownsamplePipeline: GPURenderPipeline | null = null;
  #bloomUpsamplePipeline: GPURenderPipeline | null = null;
  #bloomDownsampleBindGroupLayout: GPUBindGroupLayout | null = null;
  #bloomUpsampleBindGroupLayout: GPUBindGroupLayout | null = null;
  // Per-mip uniform buffers (enables single submission for entire bloom chain)
  #bloomDownsampleUniformBuffers: GPUBuffer[] = [];
  #bloomUpsampleUniformBuffers: GPUBuffer[] = [];
  #bloomSampler: GPUSampler | null = null;
  #bloomBindGroupCache = new Map<string, BloomBindGroupCacheEntry>();
  // Bloom mip chain textures (cached per entity dimensions)
  #bloomMipChainCache: Map<
    string,
    {
      textures: GPUTexture[];
      views: GPUTextureView[];
      width: number;
      height: number;
      byteSize: number;
    }
  > = new Map();
  #entityBlurUniforms = new Map<string, BlurUniformSet>();
  #entityBloomUniforms = new Map<string, BloomUniformSet>();
  #textureCacheBudget: ByteBudgetCache;

  constructor(
    device: GPUDevice,
    intermediateFormat: GPUTextureFormat,
    supportsP3: boolean,
    textureBudgetBytes = config.rendering.processingTextureBudgetBytes,
  ) {
    this.#device = device;
    this.#intermediateFormat = intermediateFormat;
    this.#supportsP3 = supportsP3;
    this.#textureCacheBudget = new ByteBudgetCache(textureBudgetBytes);
  }

  getTextureCacheStats(): ByteBudgetCacheStats {
    return this.#textureCacheBudget.getStats();
  }

  endFrame(): void {
    this.#textureCacheBudget.endFrame();
  }

  #getOrCreateUniformBuffer(
    cache: Map<string, GPUBuffer>,
    entityId: string,
    label: string,
    size: number,
  ): GPUBuffer {
    const cached = cache.get(entityId);
    if (cached) return cached;

    const buffer = this.#device.createBuffer({
      label: `${label} ${entityId}`,
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    cache.set(entityId, buffer);
    return buffer;
  }

  #getTextureView(texture: GPUTexture): GPUTextureView {
    const cached = this.#textureViewCache.get(texture);
    if (cached) return cached;

    const view = texture.createView();
    this.#textureViewCache.set(texture, view);
    return view;
  }

  #getOrCreateBlurUniformSet(entityId: string): BlurUniformSet {
    const cached = this.#entityBlurUniforms.get(entityId);
    if (cached) return cached;

    const downsample: GPUBuffer[] = [];
    for (let i = 0; i < MAX_BLUR_MIP_LEVELS * 2; i++) {
      downsample.push(
        this.#device.createBuffer({
          label: `Blur downsample uniforms ${entityId} level ${i}`,
          size: config.rendering.blurUniformSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    const upsample: GPUBuffer[] = [];
    for (let i = 0; i < MAX_BLUR_MIP_LEVELS * 2; i++) {
      upsample.push(
        this.#device.createBuffer({
          label: `Blur upsample uniforms ${entityId} level ${i}`,
          size: config.rendering.blurUniformSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    const mix = this.#device.createBuffer({
      label: `Blur mix uniforms ${entityId}`,
      size: config.rendering.blurUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const uniformSet = { downsample, upsample, mix };
    this.#entityBlurUniforms.set(entityId, uniformSet);
    return uniformSet;
  }

  #getOrCreateBloomUniformSet(entityId: string): BloomUniformSet {
    const cached = this.#entityBloomUniforms.get(entityId);
    if (cached) return cached;

    const downsample: GPUBuffer[] = [];
    for (let i = 0; i < BLOOM_MIP_LEVELS; i++) {
      downsample.push(
        this.#device.createBuffer({
          label: `Bloom downsample uniforms ${entityId} mip ${i}`,
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    const upsample: GPUBuffer[] = [];
    for (let i = 0; i < BLOOM_MIP_LEVELS - 1; i++) {
      upsample.push(
        this.#device.createBuffer({
          label: `Bloom upsample uniforms ${entityId} mip ${i}`,
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    const uniformSet = { downsample, upsample };
    this.#entityBloomUniforms.set(entityId, uniformSet);
    return uniformSet;
  }

  initialize(): void {
    this.#createAdjustmentsPipeline();
    this.#createBlurPipelines();
    this.#createBlurMixPipeline();
    this.#createPostProcessPipeline();
    this.#createBloomPipelines();
  }

  #createAdjustmentsPipeline(): void {
    const shaderModule = this.#device.createShaderModule({
      label: "Adjustments shader",
      code: adjustmentsShaderSource,
    });

    this.#adjustmentsBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Adjustments bind group layout",
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

    this.#adjustmentsExternalBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Adjustments external bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.#adjustmentsSampler = this.#device.createSampler({
      label: "Adjustments sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Adjustments pipeline layout",
      bindGroupLayouts: [this.#adjustmentsBindGroupLayout],
    });

    this.#adjustmentsPipeline = this.#device.createRenderPipeline({
      label: "Adjustments pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#intermediateFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    const externalShaderModule = this.#device.createShaderModule({
      label: "Adjustments external shader",
      code: createExternalTextureShaderSource(adjustmentsShaderSource),
    });

    const externalPipelineLayout = this.#device.createPipelineLayout({
      label: "Adjustments external pipeline layout",
      bindGroupLayouts: [this.#adjustmentsExternalBindGroupLayout],
    });

    this.#adjustmentsExternalPipeline = this.#device.createRenderPipeline({
      label: "Adjustments external pipeline",
      layout: externalPipelineLayout,
      vertex: {
        module: externalShaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: externalShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#intermediateFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  /**
   * Create Dual Kawase blur downsample and upsample pipelines.
   * Multi-pass downsample/upsample for logarithmic blur scaling.
   */
  #createBlurPipelines(): void {
    // Shared sampler (linear filtering, clamp to edge)
    this.#blurSampler = this.#device.createSampler({
      label: "Blur Kawase sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const bindGroupLayoutEntries: GPUBindGroupLayoutEntry[] = [
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
    ];

    // === Downsample pipeline ===
    const downsampleModule = this.#device.createShaderModule({
      label: "Kawase downsample shader",
      code: kawaseDownsampleShaderSource,
    });

    this.#blurDownsampleBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Blur downsample bind group layout",
      entries: bindGroupLayoutEntries,
    });

    // Per-level downsample uniform buffers (doubled for cross-level blending)
    this.#blurDownsampleUniformBuffers = [];
    for (let i = 0; i < MAX_BLUR_MIP_LEVELS * 2; i++) {
      this.#blurDownsampleUniformBuffers.push(
        this.#device.createBuffer({
          label: `Blur downsample uniforms level ${i}`,
          size: config.rendering.blurUniformSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    const downsamplePipelineLayout = this.#device.createPipelineLayout({
      label: "Blur downsample pipeline layout",
      bindGroupLayouts: [this.#blurDownsampleBindGroupLayout],
    });

    this.#blurDownsamplePipeline = this.#device.createRenderPipeline({
      label: "Blur downsample pipeline",
      layout: downsamplePipelineLayout,
      vertex: {
        module: downsampleModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: downsampleModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#intermediateFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    this.#blurExternalDownsampleBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Blur external downsample bind group layout",
      entries: [
        bindGroupLayoutEntries[0]!,
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
        bindGroupLayoutEntries[2]!,
      ],
    });

    const externalDownsampleModule = this.#device.createShaderModule({
      label: "Kawase external downsample shader",
      code: createExternalTextureShaderSource(
        kawaseDownsampleShaderSource,
        "src_texture",
        "src_sampler",
      ),
    });
    const externalDownsamplePipelineLayout = this.#device.createPipelineLayout({
      label: "Blur external downsample pipeline layout",
      bindGroupLayouts: [this.#blurExternalDownsampleBindGroupLayout],
    });
    this.#blurExternalDownsamplePipeline = this.#device.createRenderPipeline({
      label: "Blur external downsample pipeline",
      layout: externalDownsamplePipelineLayout,
      vertex: {
        module: externalDownsampleModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: externalDownsampleModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#intermediateFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    // === Upsample pipeline ===
    const upsampleModule = this.#device.createShaderModule({
      label: "Kawase upsample shader",
      code: kawaseUpsampleShaderSource,
    });

    this.#blurUpsampleBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Blur upsample bind group layout",
      entries: bindGroupLayoutEntries,
    });

    // Upsample uniform buffers (doubled for cross-level blending)
    this.#blurUpsampleUniformBuffers = [];
    for (let i = 0; i < MAX_BLUR_MIP_LEVELS * 2; i++) {
      this.#blurUpsampleUniformBuffers.push(
        this.#device.createBuffer({
          label: `Blur upsample uniforms level ${i}`,
          size: config.rendering.blurUniformSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    const upsamplePipelineLayout = this.#device.createPipelineLayout({
      label: "Blur upsample pipeline layout",
      bindGroupLayouts: [this.#blurUpsampleBindGroupLayout],
    });

    // No additive blending -- pure replacement write (unlike bloom)
    this.#blurUpsamplePipeline = this.#device.createRenderPipeline({
      label: "Blur upsample pipeline",
      layout: upsamplePipelineLayout,
      vertex: {
        module: upsampleModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: upsampleModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#intermediateFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  /** Create the texture mix pipeline for cross-level blur blending. */
  #createBlurMixPipeline(): void {
    const mixModule = this.#device.createShaderModule({
      label: "Texture mix shader",
      code: textureMixShaderSource,
    });

    this.#blurMixBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Blur mix bind group layout",
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
      ],
    });

    this.#blurMixUniformBuffer = this.#device.createBuffer({
      label: "Blur mix uniforms",
      size: config.rendering.blurUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const mixPipelineLayout = this.#device.createPipelineLayout({
      label: "Blur mix pipeline layout",
      bindGroupLayouts: [this.#blurMixBindGroupLayout],
    });

    this.#blurMixPipeline = this.#device.createRenderPipeline({
      label: "Blur mix pipeline",
      layout: mixPipelineLayout,
      vertex: {
        module: mixModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: mixModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#intermediateFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  #createPostProcessPipeline(): void {
    const shaderModule = this.#device.createShaderModule({
      label: "Post-process shader",
      code: postProcessShaderSource,
    });

    this.#postProcessBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Post-process bind group layout",
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
          // Bloom texture (pre-computed from multi-pass pipeline)
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
      ],
    });

    this.#postProcessSampler = this.#device.createSampler({
      label: "Post-process sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Post-process pipeline layout",
      bindGroupLayouts: [this.#postProcessBindGroupLayout],
    });

    this.#postProcessPipeline = this.#device.createRenderPipeline({
      label: "Post-process pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#intermediateFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  /**
   * Create bloom downsample and upsample pipelines.
   * Based on Call of Duty: Advanced Warfare technique (Siggraph 2014).
   */
  #createBloomPipelines(): void {
    // Shared sampler for bloom (linear filtering, clamp to edge)
    this.#bloomSampler = this.#device.createSampler({
      label: "Bloom sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // === Downsample pipeline ===
    const downsampleModule = this.#device.createShaderModule({
      label: "Bloom downsample shader",
      code: bloomDownsampleShaderSource,
    });

    this.#bloomDownsampleBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Bloom downsample bind group layout",
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

    // Per-mip downsample uniform buffers (one per mip level, enables single submission)
    // Each: src_resolution(8) + mip_level(4) + use_threshold(4) + threshold(4) + soft_knee(4) + pad(8) = 32 bytes
    this.#bloomDownsampleUniformBuffers = [];
    for (let i = 0; i < BLOOM_MIP_LEVELS; i++) {
      this.#bloomDownsampleUniformBuffers.push(
        this.#device.createBuffer({
          label: `Bloom downsample uniforms mip ${i}`,
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    const downsamplePipelineLayout = this.#device.createPipelineLayout({
      label: "Bloom downsample pipeline layout",
      bindGroupLayouts: [this.#bloomDownsampleBindGroupLayout],
    });

    this.#bloomDownsamplePipeline = this.#device.createRenderPipeline({
      label: "Bloom downsample pipeline",
      layout: downsamplePipelineLayout,
      vertex: {
        module: downsampleModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: downsampleModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#intermediateFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    // === Upsample pipeline ===
    const upsampleModule = this.#device.createShaderModule({
      label: "Bloom upsample shader",
      code: bloomUpsampleShaderSource,
    });

    this.#bloomUpsampleBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Bloom upsample bind group layout",
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

    // Per-mip upsample uniform buffers (one per pass, enables single submission)
    // Each: filter_radius(4) + pad(4) + dst_resolution(8) = 16 bytes
    this.#bloomUpsampleUniformBuffers = [];
    for (let i = 0; i < BLOOM_MIP_LEVELS - 1; i++) {
      this.#bloomUpsampleUniformBuffers.push(
        this.#device.createBuffer({
          label: `Bloom upsample uniforms mip ${i}`,
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    const upsamplePipelineLayout = this.#device.createPipelineLayout({
      label: "Bloom upsample pipeline layout",
      bindGroupLayouts: [this.#bloomUpsampleBindGroupLayout],
    });

    // Upsample pipeline with additive blending
    this.#bloomUpsamplePipeline = this.#device.createRenderPipeline({
      label: "Bloom upsample pipeline",
      layout: upsamplePipelineLayout,
      vertex: {
        module: upsampleModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: upsampleModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.#intermediateFormat,
            blend: {
              // Additive blending: output = src + dst
              color: {
                srcFactor: "one",
                dstFactor: "one",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one",
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

  /**
   * Get or create bloom mip chain textures for given dimensions.
   * Creates BLOOM_MIP_LEVELS textures at progressively halved resolutions.
   */
  #getOrCreateBloomMipChain(width: number, height: number): GPUTexture[] {
    const key = `${width}x${height}`;
    const cached = this.#bloomMipChainCache.get(key);
    const budgetKey = `bloom:${key}`;
    if (cached) {
      this.#textureCacheBudget.markUsed(budgetKey);
      return cached.textures;
    }

    const textures: GPUTexture[] = [];
    const views: GPUTextureView[] = [];
    let byteSize = 0;
    let mipWidth = Math.floor(width / 2);
    let mipHeight = Math.floor(height / 2);

    const mipLevelCount = getBloomMipLevelCount(width, height);
    for (let i = 0; i < mipLevelCount; i++) {
      // Ensure minimum size of 1x1
      mipWidth = Math.max(1, mipWidth);
      mipHeight = Math.max(1, mipHeight);

      const texture = this.#device.createTexture({
        label: `Bloom mip ${i} (${mipWidth}x${mipHeight})`,
        size: [mipWidth, mipHeight],
        format: this.#intermediateFormat,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC,
      });

      textures.push(texture);
      views.push(this.#getTextureView(texture));
      byteSize += getTextureByteSize(mipWidth, mipHeight, this.#intermediateFormat);

      // Halve for next mip
      mipWidth = Math.floor(mipWidth / 2);
      mipHeight = Math.floor(mipHeight / 2);
    }

    this.#bloomMipChainCache.set(key, { textures, views, width, height, byteSize });
    this.#textureCacheBudget.register(budgetKey, byteSize, () => {
      this.#bloomMipChainCache.delete(key);
      for (const texture of textures) texture.destroy();
      const textureSet = new Set(textures);
      for (const [entityId, entry] of this.#bloomBindGroupCache) {
        if (entry.dimensionsKey === key) this.#bloomBindGroupCache.delete(entityId);
      }
      for (const [entityId, entry] of this.#postProcessBindGroupCache) {
        if (entry.bloomTexture && textureSet.has(entry.bloomTexture)) {
          this.#postProcessBindGroupCache.delete(entityId);
        }
      }
    });
    return textures;
  }

  /**
   * Render bloom effect using multi-pass downsample/upsample.
   * Returns the final bloom texture (first mip level) to be composited.
   */
  #renderBloom(
    entityId: string,
    sourceTexture: GPUTexture,
    width: number,
    height: number,
    filterRadius: number,
    threshold: number,
    softness: number,
    encoder: GPUCommandEncoder,
  ): GPUTexture | null {
    if (
      !this.#bloomDownsamplePipeline ||
      !this.#bloomUpsamplePipeline ||
      !this.#bloomDownsampleBindGroupLayout ||
      !this.#bloomUpsampleBindGroupLayout ||
      !this.#bloomSampler
    ) {
      return null;
    }

    const uniformSet = this.#getOrCreateBloomUniformSet(entityId);
    const dimensionsKey = `${width}x${height}`;
    const mipChain = this.#getOrCreateBloomMipChain(width, height);
    if (mipChain.length === 0) return null;
    const mipViews = this.#bloomMipChainCache.get(dimensionsKey)!.views;

    // Write all uniform data upfront (each mip has its own buffer)
    let srcWidth = width;
    let srcHeight = height;
    const softKnee = softness;

    for (let i = 0; i < mipChain.length; i++) {
      const uniformData = new ArrayBuffer(32);
      const floatView = new Float32Array(uniformData);
      const uintView = new Uint32Array(uniformData);
      floatView[0] = srcWidth;
      floatView[1] = srcHeight;
      uintView[2] = i;
      uintView[3] = i === 0 && threshold > 0 ? 1 : 0;
      floatView[4] = threshold;
      floatView[5] = softKnee;
      uintView[6] = this.#supportsP3 ? 1 : 0;
      floatView[7] = 0;

      this.#device.queue.writeBuffer(uniformSet.downsample[i]!, 0, uniformData);

      srcWidth = Math.max(1, Math.floor(srcWidth / 2));
      srcHeight = Math.max(1, Math.floor(srcHeight / 2));
    }

    for (let i = mipChain.length - 1; i > 0; i--) {
      const dstMip = mipChain[i - 1]!;
      const upsampleUniformData = new ArrayBuffer(16);
      const upsampleFloatView = new Float32Array(upsampleUniformData);
      upsampleFloatView[0] = filterRadius;
      upsampleFloatView[1] = 0;
      upsampleFloatView[2] = dstMip.width;
      upsampleFloatView[3] = dstMip.height;

      // Map pass index: i goes from mipChain.length-1 down to 1, buffer index = mipChain.length-1-i
      const bufIdx = mipChain.length - 1 - i;
      this.#device.queue.writeBuffer(uniformSet.upsample[bufIdx]!, 0, upsampleUniformData);
    }

    const bindGroups = this.#getOrCreateBloomBindGroups(
      entityId,
      dimensionsKey,
      sourceTexture,
      uniformSet,
      mipViews,
    );

    // === Downsample passes ===
    for (let i = 0; i < mipChain.length; i++) {
      const dstTexture = mipChain[i]!;
      const dstView = mipViews[i]!;
      const dstWidth = dstTexture.width;
      const dstHeight = dstTexture.height;

      const pass = encoder.beginRenderPass({
        label: `Bloom downsample pass mip ${i}`,
        colorAttachments: [
          {
            view: dstView,
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });

      pass.setPipeline(this.#bloomDownsamplePipeline);
      pass.setBindGroup(0, bindGroups.downsample[i]!);
      pass.setViewport(0, 0, dstWidth, dstHeight, 0, 1);
      pass.draw(3);
      pass.end();
    }

    // === Upsample passes ===
    for (let i = mipChain.length - 1; i > 0; i--) {
      const dstMip = mipChain[i - 1]!;
      const dstView = mipViews[i - 1]!;
      const dstWidth = dstMip.width;
      const dstHeight = dstMip.height;
      const bufIdx = mipChain.length - 1 - i;

      const pass = encoder.beginRenderPass({
        label: `Bloom upsample pass mip ${i}`,
        colorAttachments: [
          {
            view: dstView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });

      pass.setPipeline(this.#bloomUpsamplePipeline);
      pass.setBindGroup(0, bindGroups.upsample[bufIdx]!);
      pass.setViewport(0, 0, dstWidth, dstHeight, 0, 1);
      pass.draw(3);
      pass.end();
    }

    return mipChain[0] ?? null;
  }

  #getOrCreateBloomBindGroups(
    entityId: string,
    dimensionsKey: string,
    sourceTexture: GPUTexture,
    uniformSet: BloomUniformSet,
    mipViews: GPUTextureView[],
  ): BloomBindGroupCacheEntry {
    const cached = this.#bloomBindGroupCache.get(entityId);
    if (
      cached &&
      cached.dimensionsKey === dimensionsKey &&
      cached.sourceTexture === sourceTexture
    ) {
      return cached;
    }

    const downsample: GPUBindGroup[] = [];
    for (let i = 0; i < mipViews.length; i++) {
      downsample.push(
        this.#device.createBindGroup({
          label: `Bloom downsample bind group mip ${i}`,
          layout: this.#bloomDownsampleBindGroupLayout!,
          entries: [
            {
              binding: 0,
              resource: { buffer: uniformSet.downsample[i]! },
            },
            {
              binding: 1,
              resource: i === 0 ? this.#getTextureView(sourceTexture) : mipViews[i - 1]!,
            },
            { binding: 2, resource: this.#bloomSampler! },
          ],
        }),
      );
    }

    const upsample: GPUBindGroup[] = [];
    for (let i = mipViews.length - 1; i > 0; i--) {
      const bufIdx = mipViews.length - 1 - i;
      upsample.push(
        this.#device.createBindGroup({
          label: `Bloom upsample bind group mip ${i}`,
          layout: this.#bloomUpsampleBindGroupLayout!,
          entries: [
            {
              binding: 0,
              resource: { buffer: uniformSet.upsample[bufIdx]! },
            },
            { binding: 1, resource: mipViews[i]! },
            { binding: 2, resource: this.#bloomSampler! },
          ],
        }),
      );
    }

    const entry = { dimensionsKey, sourceTexture, downsample, upsample };
    this.#bloomBindGroupCache.set(entityId, entry);
    return entry;
  }

  /**
   * Update adjustments uniforms from entity params
   */
  #updateAdjustmentsUniforms(entity: EffectRenderEntity): void {
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const adjustments = entity.shaderParams.adjustments;

    // Default values from config
    const defaults = config.defaults.shaderParams.adjustments!;

    const f = this.#adjustmentsFloatView;

    // Layout: resolution(8) + brightness(4) + contrast(4) + saturation(4) + padding(12) = 32 bytes
    f[0] = width; // resolution.x
    f[1] = height; // resolution.y
    f[2] = adjustments?.brightness ?? defaults.brightness; // brightness
    f[3] = adjustments?.contrast ?? defaults.contrast; // contrast
    f[4] = adjustments?.saturation ?? defaults.saturation; // saturation
    f[5] = 0; // padding
    f[6] = 0; // padding
    f[7] = 0; // padding
  }

  /**
   * Check if adjustments need to be applied (any value is not default 0.5)
   */
  needsAdjustments(entity: EffectRenderEntity): boolean {
    const adjustments = entity.shaderParams.adjustments;
    if (!adjustments) return false;

    const defaults = config.defaults.shaderParams.adjustments!;
    const epsilon = 0.001;

    return (
      Math.abs(adjustments.brightness - defaults.brightness) > epsilon ||
      Math.abs(adjustments.contrast - defaults.contrast) > epsilon ||
      Math.abs(adjustments.saturation - defaults.saturation) > epsilon
    );
  }

  /**
   * Check if blur needs to be applied
   */
  needsBlur(entity: EffectRenderEntity): boolean {
    const blur = entity.shaderParams.adjustments?.blur;
    return blur != null && blur * entity.pixelScale > 0.001;
  }

  /**
   * Get or create blur mip chain textures for given dimensions.
   * Creates MAX_BLUR_MIP_LEVELS textures at progressively halved resolutions.
   * Textures are cached per entity dimensions to avoid per-frame allocation.
   */
  #getOrCreateBlurMipChain(width: number, height: number): GPUTexture[] {
    const key = `${width}x${height}`;
    const cached = this.#blurMipChainCache.get(key);
    const budgetKey = `blur:${key}`;
    if (cached) {
      this.#textureCacheBudget.markUsed(budgetKey);
      return cached.textures;
    }

    const textures: GPUTexture[] = [];
    let byteSize = 0;
    let mipWidth = Math.floor(width / 2);
    let mipHeight = Math.floor(height / 2);

    for (let i = 0; i < MAX_BLUR_MIP_LEVELS; i++) {
      mipWidth = Math.max(1, mipWidth);
      mipHeight = Math.max(1, mipHeight);

      const texture = this.#device.createTexture({
        label: `Blur mip ${i} (${mipWidth}x${mipHeight})`,
        size: [mipWidth, mipHeight],
        format: this.#intermediateFormat,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC,
      });

      textures.push(texture);
      byteSize += getTextureByteSize(mipWidth, mipHeight, this.#intermediateFormat);

      mipWidth = Math.floor(mipWidth / 2);
      mipHeight = Math.floor(mipHeight / 2);
    }

    this.#blurMipChainCache.set(key, { textures, width, height, byteSize });
    this.#textureCacheBudget.register(budgetKey, byteSize, () => {
      this.#blurMipChainCache.delete(key);
      for (const texture of textures) texture.destroy();
    });
    return textures;
  }

  /**
   * Get or create temporary textures for cross-level blur blending.
   * These are full-resolution textures used to hold intermediate results
   * when blending between two blur level counts.
   */
  #getOrCreateBlurBlendTextures(
    width: number,
    height: number,
  ): { textureA: GPUTexture; textureB: GPUTexture } {
    const key = `${width}x${height}`;
    const cached = this.#blurBlendTextureCache.get(key);
    const budgetKey = `blur-blend:${key}`;
    if (cached) {
      this.#textureCacheBudget.markUsed(budgetKey);
      return cached;
    }

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const textureA = this.#device.createTexture({
      label: `Blur blend A (${width}x${height})`,
      size: [width, height],
      format: this.#intermediateFormat,
      usage,
    });
    const textureB = this.#device.createTexture({
      label: `Blur blend B (${width}x${height})`,
      size: [width, height],
      format: this.#intermediateFormat,
      usage,
    });

    const byteSize = getTextureByteSize(width, height, this.#intermediateFormat) * 2;
    const entry = { textureA, textureB, width, height, byteSize };
    this.#blurBlendTextureCache.set(key, entry);
    this.#textureCacheBudget.register(budgetKey, byteSize, () => {
      this.#blurBlendTextureCache.delete(key);
      textureA.destroy();
      textureB.destroy();
    });
    return entry;
  }

  /**
   * Encode a complete Dual Kawase blur (downsample + upsample) into an encoder.
   * The final upsample writes to `finalTarget` at full resolution.
   *
   * @param bufferOffset Starting index into uniform buffer arrays (0 or MAX_BLUR_MIP_LEVELS)
   */
  #encodeBlurPasses(
    encoder: GPUCommandEncoder,
    inputSource: BlurInputSource,
    finalTarget: GPUTexture,
    mipChain: GPUTexture[],
    uniformSet: BlurUniformSet,
    levels: number,
    offset: number,
    width: number,
    height: number,
    bufferOffset: number,
  ): void {
    const activeLevels = Math.min(levels, mipChain.length);
    if (activeLevels <= 0) return;

    // Write all downsample uniforms upfront
    let srcWidth = width;
    let srcHeight = height;
    for (let i = 0; i < activeLevels; i++) {
      const uniformData = new ArrayBuffer(config.rendering.blurUniformSize);
      const floatView = new Float32Array(uniformData);
      floatView[0] = srcWidth; // src_resolution.x
      floatView[1] = srcHeight; // src_resolution.y
      floatView[2] = offset; // per-pass offset
      floatView[3] = 0; // padding

      this.#device.queue.writeBuffer(uniformSet.downsample[bufferOffset + i]!, 0, uniformData);

      srcWidth = Math.max(1, Math.floor(srcWidth / 2));
      srcHeight = Math.max(1, Math.floor(srcHeight / 2));
    }

    // Write all upsample uniforms upfront
    let bufIdx = 0;
    for (let i = activeLevels - 1; i > 0; i--) {
      const dstMip = mipChain[i - 1]!;
      const uniformData = new ArrayBuffer(config.rendering.blurUniformSize);
      const floatView = new Float32Array(uniformData);
      floatView[0] = dstMip.width; // dst_resolution.x
      floatView[1] = dstMip.height; // dst_resolution.y
      floatView[2] = offset; // per-pass offset
      floatView[3] = 0; // padding

      this.#device.queue.writeBuffer(uniformSet.upsample[bufferOffset + bufIdx]!, 0, uniformData);
      bufIdx++;
    }

    // Final upsample uniform: mip[0] -> full resolution
    {
      const uniformData = new ArrayBuffer(config.rendering.blurUniformSize);
      const floatView = new Float32Array(uniformData);
      floatView[0] = width; // dst_resolution.x (full res)
      floatView[1] = height; // dst_resolution.y (full res)
      floatView[2] = offset; // per-pass offset
      floatView[3] = 0; // padding

      this.#device.queue.writeBuffer(uniformSet.upsample[bufferOffset + bufIdx]!, 0, uniformData);
    }

    // === Downsample passes ===
    let srcTexture: GPUTexture | null = inputSource.kind === "texture" ? inputSource.texture : null;
    for (let i = 0; i < activeLevels; i++) {
      const dstTexture = mipChain[i]!;

      const readsExternalSource = i === 0 && inputSource.kind === "external";
      if (
        readsExternalSource &&
        (!this.#blurExternalDownsampleBindGroupLayout || !this.#blurExternalDownsamplePipeline)
      ) {
        return;
      }
      if (!readsExternalSource && !srcTexture) return;

      const bindGroup = this.#device.createBindGroup(
        readsExternalSource
          ? {
              label: `Blur external downsample bind group level ${i}`,
              layout: this.#blurExternalDownsampleBindGroupLayout!,
              entries: [
                {
                  binding: 0,
                  resource: {
                    buffer: uniformSet.downsample[bufferOffset + i]!,
                  },
                },
                { binding: 1, resource: inputSource.texture },
                { binding: 2, resource: this.#blurSampler! },
              ],
            }
          : {
              label: `Blur downsample bind group level ${i}`,
              layout: this.#blurDownsampleBindGroupLayout!,
              entries: [
                {
                  binding: 0,
                  resource: {
                    buffer: uniformSet.downsample[bufferOffset + i]!,
                  },
                },
                { binding: 1, resource: srcTexture!.createView() },
                { binding: 2, resource: this.#blurSampler! },
              ],
            },
      );

      const pass = encoder.beginRenderPass({
        label: readsExternalSource
          ? `Blur external downsample pass level ${i}`
          : `Blur downsample pass level ${i}`,
        colorAttachments: [
          {
            view: dstTexture.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });

      pass.setPipeline(
        readsExternalSource ? this.#blurExternalDownsamplePipeline! : this.#blurDownsamplePipeline!,
      );
      pass.setBindGroup(0, bindGroup);
      pass.setViewport(0, 0, dstTexture.width, dstTexture.height, 0, 1);
      pass.draw(3);
      pass.end();

      srcTexture = dstTexture;
    }

    // === Upsample passes ===
    bufIdx = 0;
    for (let i = activeLevels - 1; i > 0; i--) {
      const srcMip = mipChain[i]!;
      const dstMip = mipChain[i - 1]!;

      const bindGroup = this.#device.createBindGroup({
        label: `Blur upsample bind group level ${i}`,
        layout: this.#blurUpsampleBindGroupLayout!,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: uniformSet.upsample[bufferOffset + bufIdx]!,
            },
          },
          { binding: 1, resource: srcMip.createView() },
          { binding: 2, resource: this.#blurSampler! },
        ],
      });

      const pass = encoder.beginRenderPass({
        label: `Blur upsample pass level ${i}`,
        colorAttachments: [
          {
            view: dstMip.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });

      pass.setPipeline(this.#blurUpsamplePipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.setViewport(0, 0, dstMip.width, dstMip.height, 0, 1);
      pass.draw(3);
      pass.end();

      bufIdx++;
    }

    // === Final upsample: mip[0] -> finalTarget (full resolution) ===
    {
      const srcMip = mipChain[0]!;

      const bindGroup = this.#device.createBindGroup({
        label: "Blur final upsample bind group",
        layout: this.#blurUpsampleBindGroupLayout!,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: uniformSet.upsample[bufferOffset + bufIdx]!,
            },
          },
          { binding: 1, resource: srcMip.createView() },
          { binding: 2, resource: this.#blurSampler! },
        ],
      });

      const pass = encoder.beginRenderPass({
        label: "Blur final upsample pass",
        colorAttachments: [
          {
            view: finalTarget.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });

      pass.setPipeline(this.#blurUpsamplePipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.setViewport(0, 0, finalTarget.width, finalTarget.height, 0, 1);
      pass.draw(3);
      pass.end();
    }
  }

  /**
   * Encode a mix pass that blends two textures into the output.
   */
  #encodeMixPass(
    encoder: GPUCommandEncoder,
    textureA: GPUTexture,
    textureB: GPUTexture,
    outputTexture: GPUTexture,
    uniformBuffer: GPUBuffer,
    mixFactor: number,
    width: number,
    height: number,
  ): void {
    const uniformData = new ArrayBuffer(config.rendering.blurUniformSize);
    const floatView = new Float32Array(uniformData);
    floatView[0] = width;
    floatView[1] = height;
    floatView[2] = mixFactor;
    floatView[3] = 0; // padding

    this.#device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const bindGroup = this.#device.createBindGroup({
      label: "Blur mix bind group",
      layout: this.#blurMixBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: textureA.createView() },
        { binding: 2, resource: textureB.createView() },
        { binding: 3, resource: this.#blurSampler! },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "Blur mix pass",
      colorAttachments: [
        {
          view: outputTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });

    pass.setPipeline(this.#blurMixPipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.setViewport(0, 0, width, height, 0, 1);
    pass.draw(3);
    pass.end();
  }

  /**
   * Apply Dual Kawase blur to a texture using multi-pass downsample/upsample.
   * Supports cross-level blending for smooth transitions at breakpoints.
   * All passes are batched into a single command encoder submission.
   */
  applyBlur(
    entity: EffectRenderEntity,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (
      !this.#blurDownsamplePipeline ||
      !this.#blurUpsamplePipeline ||
      !this.#blurDownsampleBindGroupLayout ||
      !this.#blurUpsampleBindGroupLayout ||
      !this.#blurMixPipeline ||
      !this.#blurMixBindGroupLayout ||
      !this.#blurMixUniformBuffer ||
      !this.#blurSampler
    ) {
      return;
    }

    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const blur = entity.shaderParams.adjustments?.blur ?? 0;
    const { levelsLow, levelsHigh, offsetLow, offsetHigh, blendFactor } = blurParamToKawaseParams(
      blur * entity.pixelScale,
    );

    const needsBlend = blendFactor > 0.001 && blendFactor < 0.999;
    const levels = needsBlend ? levelsLow : blendFactor >= 0.999 ? levelsHigh : levelsLow;
    const offset = needsBlend ? offsetLow : blendFactor >= 0.999 ? offsetHigh : offsetLow;

    if (levels <= 0 && (!needsBlend || levelsHigh <= 0)) return;

    const mipChain = this.#getOrCreateBlurMipChain(width, height);
    if (mipChain.length === 0) return;
    const uniformSet = this.#getOrCreateBlurUniformSet(entity.id);

    if (!needsBlend) {
      this.#encodeBlurPasses(
        encoder,
        { kind: "texture", texture: inputTexture },
        outputTexture,
        mipChain,
        uniformSet,
        levels,
        offset,
        width,
        height,
        0,
      );
      return;
    }

    // Cross-level blending path
    const { textureA, textureB } = this.#getOrCreateBlurBlendTextures(width, height);

    this.#encodeBlurPasses(
      encoder,
      { kind: "texture", texture: inputTexture },
      textureA,
      mipChain,
      uniformSet,
      levelsLow,
      offsetLow,
      width,
      height,
      0,
    );
    this.#encodeBlurPasses(
      encoder,
      { kind: "texture", texture: inputTexture },
      textureB,
      mipChain,
      uniformSet,
      levelsHigh,
      offsetHigh,
      width,
      height,
      MAX_BLUR_MIP_LEVELS,
    );
    this.#encodeMixPass(
      encoder,
      textureA,
      textureB,
      outputTexture,
      uniformSet.mix,
      blendFactor,
      width,
      height,
    );
  }

  applyBlurExternal(
    entity: EffectRenderEntity,
    inputSource: ExternalTextureSource,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (
      !this.#blurDownsamplePipeline ||
      !this.#blurExternalDownsamplePipeline ||
      !this.#blurUpsamplePipeline ||
      !this.#blurDownsampleBindGroupLayout ||
      !this.#blurExternalDownsampleBindGroupLayout ||
      !this.#blurUpsampleBindGroupLayout ||
      !this.#blurMixPipeline ||
      !this.#blurMixBindGroupLayout ||
      !this.#blurMixUniformBuffer ||
      !this.#blurSampler
    ) {
      return;
    }

    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const blur = entity.shaderParams.adjustments?.blur ?? 0;
    const { levelsLow, levelsHigh, offsetLow, offsetHigh, blendFactor } = blurParamToKawaseParams(
      blur * entity.pixelScale,
    );

    const needsBlend = blendFactor > 0.001 && blendFactor < 0.999;
    const levels = needsBlend ? levelsLow : blendFactor >= 0.999 ? levelsHigh : levelsLow;
    const offset = needsBlend ? offsetLow : blendFactor >= 0.999 ? offsetHigh : offsetLow;

    if (levels <= 0 && (!needsBlend || levelsHigh <= 0)) return;

    const mipChain = this.#getOrCreateBlurMipChain(width, height);
    if (mipChain.length === 0) return;
    const uniformSet = this.#getOrCreateBlurUniformSet(entity.id);
    const blurSource: BlurInputSource = { kind: "external", texture: inputSource.texture };

    if (!needsBlend) {
      this.#encodeBlurPasses(
        encoder,
        blurSource,
        outputTexture,
        mipChain,
        uniformSet,
        levels,
        offset,
        width,
        height,
        0,
      );
      return;
    }

    const { textureA, textureB } = this.#getOrCreateBlurBlendTextures(width, height);

    this.#encodeBlurPasses(
      encoder,
      blurSource,
      textureA,
      mipChain,
      uniformSet,
      levelsLow,
      offsetLow,
      width,
      height,
      0,
    );
    this.#encodeBlurPasses(
      encoder,
      blurSource,
      textureB,
      mipChain,
      uniformSet,
      levelsHigh,
      offsetHigh,
      width,
      height,
      MAX_BLUR_MIP_LEVELS,
    );
    this.#encodeMixPass(
      encoder,
      textureA,
      textureB,
      outputTexture,
      uniformSet.mix,
      blendFactor,
      width,
      height,
    );
  }

  /**
   * Encode Kawase blur passes into an existing command encoder.
   * Used for full-screen action layer blur (separate from per-entity blur).
   * Input and output must be in intermediateFormat.
   */
  encodeFullScreenBlur(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    width: number,
    height: number,
  ): void {
    if (
      !this.#blurDownsamplePipeline ||
      !this.#blurUpsamplePipeline ||
      !this.#blurDownsampleBindGroupLayout ||
      !this.#blurUpsampleBindGroupLayout ||
      !this.#blurMixUniformBuffer ||
      !this.#blurSampler
    ) {
      return;
    }

    // Fixed blur params for action layer
    const levels = config.actionLayer.blurLevels;
    const offset = config.actionLayer.blurOffset;

    const mipChain = this.#getOrCreateBlurMipChain(width, height);
    if (mipChain.length === 0) return;
    const uniformSet = {
      downsample: this.#blurDownsampleUniformBuffers,
      upsample: this.#blurUpsampleUniformBuffers,
      mix: this.#blurMixUniformBuffer,
    };

    this.#encodeBlurPasses(
      encoder,
      { kind: "texture", texture: inputTexture },
      outputTexture,
      mipChain,
      uniformSet,
      levels,
      offset,
      width,
      height,
      0,
    );
  }

  /**
   * Apply adjustments (brightness, contrast, saturation) to a texture.
   * This is a pre-processing step before the main shader.
   * When encoder is provided, encodes into it without submitting.
   */
  applyAdjustments(
    entity: EffectRenderEntity,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (
      !this.#adjustmentsPipeline ||
      !this.#adjustmentsBindGroupLayout ||
      !this.#adjustmentsSampler
    ) {
      return;
    }

    this.#updateAdjustmentsUniforms(entity);
    const uniformBuffer = this.#getOrCreateUniformBuffer(
      this.#adjustmentsUniformBuffers,
      entity.id,
      "Adjustments uniforms",
      config.rendering.adjustmentsUniformSize,
    );
    this.#device.queue.writeBuffer(uniformBuffer, 0, this.#adjustmentsUniformData);

    const bindGroup = this.#device.createBindGroup({
      label: "Adjustments bind group",
      layout: this.#adjustmentsBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: inputTexture.createView() },
        { binding: 2, resource: this.#adjustmentsSampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "Adjustments render pass",
      colorAttachments: [
        {
          view: outputTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.#adjustmentsPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  applyAdjustmentsExternal(
    entity: EffectRenderEntity,
    source: ExternalTextureSource,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (
      !this.#adjustmentsExternalPipeline ||
      !this.#adjustmentsExternalBindGroupLayout ||
      !this.#adjustmentsSampler
    ) {
      return;
    }

    this.#updateAdjustmentsUniforms(entity);
    const uniformBuffer = this.#getOrCreateUniformBuffer(
      this.#adjustmentsUniformBuffers,
      entity.id,
      "Adjustments uniforms",
      config.rendering.adjustmentsUniformSize,
    );
    this.#device.queue.writeBuffer(uniformBuffer, 0, this.#adjustmentsUniformData);

    const bindGroup = this.#device.createBindGroup({
      label: "Adjustments external bind group",
      layout: this.#adjustmentsExternalBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: source.texture },
        { binding: 2, resource: this.#adjustmentsSampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "Adjustments external render pass",
      colorAttachments: [
        {
          view: outputTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.#adjustmentsExternalPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  /**
   * Update post-process uniforms from entity params
   */
  #updatePostProcessUniforms(entity: EffectRenderEntity): void {
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const postProcess = entity.shaderParams.postProcess;

    // Default values from config
    const defaults = config.defaults.shaderParams.postProcess!;
    const grain = postProcess?.grain ?? defaults.grain!;
    const bloom = postProcess?.bloom ?? defaults.bloom!;
    const chromaticAberration = postProcess?.chromaticAberration ?? defaults.chromaticAberration!;

    // Build enabled flags (check both existence and enabled property)
    let flags = 0;
    if (postProcess?.grain?.enabled) flags |= 1; // FLAG_GRAIN
    if (postProcess?.bloom?.enabled) flags |= 2; // FLAG_BLOOM
    if (postProcess?.chromaticAberration?.enabled) flags |= 4; // FLAG_CHROMATIC

    const f = this.#postProcessFloatView;
    const u = this.#postProcessUintView;

    // Layout: resolution(8) + grain_size(4) + grain_intensity(4) + bloom_threshold(4) +
    //         bloom_intensity(4) + bloom_filter_radius(4) + chromatic_offset(4) +
    //         enabled_flags(4) + time(4) + padding(24) = 64 bytes
    f[0] = width; // resolution.x
    f[1] = height; // resolution.y
    f[2] = grain.size * entity.pixelScale; // grain_size
    f[3] = grain.intensity; // grain_intensity
    f[4] = bloom.threshold; // bloom_threshold (used in downsample for soft threshold)
    f[5] = bloom.intensity; // bloom_intensity (mix strength)
    f[6] = bloomFilterRadiusToRenderer(bloom.filterRadius); // bloom_filter_radius (UV-space radius for upsample)
    f[7] = chromaticAberration.offset * entity.pixelScale; // chromatic_offset
    u[8] = flags; // enabled_flags
    f[9] = this.#postProcessTime; // time (for animated grain)
    // Padding fills the rest to 64 bytes
  }

  /**
   * Apply post-processing effects to a texture.
   * Runs bloom pipeline first (if enabled), then composites with other effects.
   */
  applyPostProcessing(
    entity: EffectRenderEntity,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (
      !this.#postProcessPipeline ||
      !this.#postProcessBindGroupLayout ||
      !this.#postProcessSampler
    ) {
      return;
    }

    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const postProcess = entity.shaderParams.postProcess;
    const defaults = config.defaults.shaderParams.postProcess!;
    const bloom = postProcess?.bloom ?? defaults.bloom!;

    // Run bloom pipeline if bloom is enabled
    let bloomTexture: GPUTexture | null = null;
    if (postProcess?.bloom?.enabled && bloom.intensity > 0) {
      const softness = bloom.softness ?? 0.1;
      bloomTexture = this.#renderBloom(
        entity.id,
        inputTexture,
        width,
        height,
        bloomFilterRadiusToRenderer(bloom.filterRadius),
        bloom.threshold,
        softness,
        encoder,
      );
    }

    this.#updatePostProcessUniforms(entity);
    const uniformBuffer = this.#getOrCreateUniformBuffer(
      this.#postProcessUniformBuffers,
      entity.id,
      "Post-process uniforms",
      config.rendering.postProcessUniformSize,
    );
    this.#device.queue.writeBuffer(uniformBuffer, 0, this.#postProcessUniformData);

    const cached = this.#postProcessBindGroupCache.get(entity.id);
    const bindGroup =
      cached &&
      cached.uniformBuffer === uniformBuffer &&
      cached.inputTexture === inputTexture &&
      cached.bloomTexture === bloomTexture
        ? cached.bindGroup
        : this.#createPostProcessBindGroup(entity.id, uniformBuffer, inputTexture, bloomTexture);

    const pass = encoder.beginRenderPass({
      label: "Post-process render pass",
      colorAttachments: [
        {
          view: this.#getTextureView(outputTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.#postProcessPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    // Increment time for animated grain
    this.#postProcessTime += 0.016; // ~60fps increment
  }

  #createPostProcessBindGroup(
    entityId: string,
    uniformBuffer: GPUBuffer,
    inputTexture: GPUTexture,
    bloomTexture: GPUTexture | null,
  ): GPUBindGroup {
    const bloomTextureView = bloomTexture
      ? this.#getTextureView(bloomTexture)
      : this.#getDummyBloomTextureView();
    const bindGroup = this.#device.createBindGroup({
      label: "Post-process bind group",
      layout: this.#postProcessBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: this.#getTextureView(inputTexture) },
        { binding: 2, resource: this.#postProcessSampler! },
        { binding: 3, resource: bloomTextureView },
      ],
    });
    this.#postProcessBindGroupCache.set(entityId, {
      uniformBuffer,
      inputTexture,
      bloomTexture,
      bindGroup,
    });
    return bindGroup;
  }

  #getDummyBloomTextureView(): GPUTextureView {
    if (this.#dummyBloomTextureView) return this.#dummyBloomTextureView;

    this.#dummyBloomTexture = this.#device.createTexture({
      label: "Dummy bloom texture",
      size: [1, 1],
      format: this.#intermediateFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#dummyBloomTextureView = this.#dummyBloomTexture.createView();
    return this.#dummyBloomTextureView;
  }

  removeEntity(entityId: string): void {
    this.#adjustmentsUniformBuffers.get(entityId)?.destroy();
    this.#adjustmentsUniformBuffers.delete(entityId);

    this.#postProcessUniformBuffers.get(entityId)?.destroy();
    this.#postProcessUniformBuffers.delete(entityId);
    this.#postProcessBindGroupCache.delete(entityId);

    const blurUniforms = this.#entityBlurUniforms.get(entityId);
    if (blurUniforms) {
      for (const buffer of blurUniforms.downsample) buffer.destroy();
      for (const buffer of blurUniforms.upsample) buffer.destroy();
      blurUniforms.mix.destroy();
      this.#entityBlurUniforms.delete(entityId);
    }

    const bloomUniforms = this.#entityBloomUniforms.get(entityId);
    if (bloomUniforms) {
      for (const buffer of bloomUniforms.downsample) buffer.destroy();
      for (const buffer of bloomUniforms.upsample) buffer.destroy();
      this.#entityBloomUniforms.delete(entityId);
    }
    this.#bloomBindGroupCache.delete(entityId);
  }

  destroy(): void {
    // Destroy uniform buffers
    for (const buffer of this.#adjustmentsUniformBuffers.values()) buffer.destroy();
    this.#adjustmentsUniformBuffers.clear();
    for (const buffer of this.#postProcessUniformBuffers.values()) buffer.destroy();
    this.#postProcessUniformBuffers.clear();
    for (const uniforms of this.#entityBlurUniforms.values()) {
      for (const buffer of uniforms.downsample) buffer.destroy();
      for (const buffer of uniforms.upsample) buffer.destroy();
      uniforms.mix.destroy();
    }
    this.#entityBlurUniforms.clear();
    for (const uniforms of this.#entityBloomUniforms.values()) {
      for (const buffer of uniforms.downsample) buffer.destroy();
      for (const buffer of uniforms.upsample) buffer.destroy();
    }
    this.#entityBloomUniforms.clear();
    this.#postProcessBindGroupCache.clear();
    this.#bloomBindGroupCache.clear();
    for (const buf of this.#blurDownsampleUniformBuffers) buf.destroy();
    for (const buf of this.#blurUpsampleUniformBuffers) buf.destroy();
    this.#blurMixUniformBuffer?.destroy();
    for (const buf of this.#bloomDownsampleUniformBuffers) buf.destroy();
    for (const buf of this.#bloomUpsampleUniformBuffers) buf.destroy();
    this.#dummyBloomTexture?.destroy();
    this.#dummyBloomTexture = null;
    this.#dummyBloomTextureView = null;

    this.#textureCacheBudget.destroy();

    // Clear pipeline references
    this.#adjustmentsPipeline = null;
    this.#adjustmentsExternalPipeline = null;
    this.#adjustmentsBindGroupLayout = null;
    this.#adjustmentsExternalBindGroupLayout = null;
    this.#adjustmentsSampler = null;
    this.#blurDownsamplePipeline = null;
    this.#blurExternalDownsamplePipeline = null;
    this.#blurUpsamplePipeline = null;
    this.#blurDownsampleBindGroupLayout = null;
    this.#blurExternalDownsampleBindGroupLayout = null;
    this.#blurUpsampleBindGroupLayout = null;
    this.#blurDownsampleUniformBuffers = [];
    this.#blurUpsampleUniformBuffers = [];
    this.#blurSampler = null;
    this.#blurMixPipeline = null;
    this.#blurMixBindGroupLayout = null;
    this.#blurMixUniformBuffer = null;
    this.#postProcessPipeline = null;
    this.#postProcessBindGroupLayout = null;
    this.#postProcessSampler = null;
    this.#bloomDownsamplePipeline = null;
    this.#bloomUpsamplePipeline = null;
    this.#bloomDownsampleBindGroupLayout = null;
    this.#bloomUpsampleBindGroupLayout = null;
    this.#bloomDownsampleUniformBuffers = [];
    this.#bloomUpsampleUniformBuffers = [];
    this.#bloomSampler = null;
  }
}

function getTextureByteSize(width: number, height: number, format: GPUTextureFormat): number {
  switch (format) {
    case "rgba8unorm":
    case "bgra8unorm":
    case "rgba8unorm-srgb":
    case "bgra8unorm-srgb":
      return width * height * 4;
    case "rgba16float":
      return width * height * 8;
    default:
      throw new Error(`Processing texture format ${format} needs an explicit byte-size mapping`);
  }
}
