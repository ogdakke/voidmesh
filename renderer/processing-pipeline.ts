import {
  bloomFilterRadiusToRenderer,
  blurParamToKawaseParams,
  config,
  MAX_BLUR_MIP_LEVELS,
} from "#config";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import adjustmentsShaderSource from "./adjustments.wgsl?raw";
import bloomDownsampleShaderSource from "./bloom-downsample.wgsl?raw";
import bloomUpsampleShaderSource from "./bloom-upsample.wgsl?raw";
import kawaseDownsampleShaderSource from "./kawase-downsample.wgsl?raw";
import kawaseUpsampleShaderSource from "./kawase-upsample.wgsl?raw";
import postProcessShaderSource from "./post-process.wgsl?raw";
import textureMixShaderSource from "./texture-mix.wgsl?raw";
/** Number of mip levels in the bloom chain (determines blur spread) */
const BLOOM_MIP_LEVELS = 5;

export class ProcessingPipeline {
  #device: GPUDevice;

  // Adjustments (pre-processing) pipeline
  #adjustmentsPipeline: GPURenderPipeline | null = null;
  #adjustmentsBindGroupLayout: GPUBindGroupLayout | null = null;
  #adjustmentsUniformBuffer: GPUBuffer | null = null;
  #adjustmentsSampler: GPUSampler | null = null;
  #adjustmentsUniformData = new ArrayBuffer(config.rendering.adjustmentsUniformSize);
  #adjustmentsFloatView = new Float32Array(this.#adjustmentsUniformData);

  // Dual Kawase blur (pre-processing) pipeline
  #blurDownsamplePipeline: GPURenderPipeline | null = null;
  #blurUpsamplePipeline: GPURenderPipeline | null = null;
  #blurDownsampleBindGroupLayout: GPUBindGroupLayout | null = null;
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
    }
  > = new Map();

  // Post-processing pipeline
  #postProcessPipeline: GPURenderPipeline | null = null;
  #postProcessBindGroupLayout: GPUBindGroupLayout | null = null;
  #postProcessUniformBuffer: GPUBuffer | null = null;
  #postProcessSampler: GPUSampler | null = null;
  #postProcessUniformData = new ArrayBuffer(config.rendering.postProcessUniformSize);
  #postProcessFloatView = new Float32Array(this.#postProcessUniformData);
  #postProcessUintView = new Uint32Array(this.#postProcessUniformData);
  #postProcessTime = 0; // Animated time for grain effect

  // Bloom pipeline (multi-pass downsample/upsample)
  #bloomDownsamplePipeline: GPURenderPipeline | null = null;
  #bloomUpsamplePipeline: GPURenderPipeline | null = null;
  #bloomDownsampleBindGroupLayout: GPUBindGroupLayout | null = null;
  #bloomUpsampleBindGroupLayout: GPUBindGroupLayout | null = null;
  // Per-mip uniform buffers (enables single submission for entire bloom chain)
  #bloomDownsampleUniformBuffers: GPUBuffer[] = [];
  #bloomUpsampleUniformBuffers: GPUBuffer[] = [];
  #bloomSampler: GPUSampler | null = null;
  // Bloom mip chain textures (cached per entity dimensions)
  #bloomMipChainCache: Map<
    string,
    {
      textures: GPUTexture[];
      width: number;
      height: number;
    }
  > = new Map();

  constructor(device: GPUDevice) {
    this.#device = device;
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

    this.#adjustmentsUniformBuffer = this.#device.createBuffer({
      label: "Adjustments uniforms",
      size: config.rendering.adjustmentsUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
        targets: [{ format: "rgba8unorm" }],
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
        targets: [{ format: "rgba8unorm" }],
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
        targets: [{ format: "rgba8unorm" }],
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
        targets: [{ format: "rgba8unorm" }],
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

    this.#postProcessUniformBuffer = this.#device.createBuffer({
      label: "Post-process uniforms",
      size: config.rendering.postProcessUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
        targets: [{ format: "rgba8unorm" }],
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
        targets: [{ format: "rgba8unorm" }],
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
            format: "rgba8unorm",
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
    if (cached) return cached.textures;

    const textures: GPUTexture[] = [];
    let mipWidth = Math.floor(width / 2);
    let mipHeight = Math.floor(height / 2);

    for (let i = 0; i < BLOOM_MIP_LEVELS; i++) {
      // Ensure minimum size of 1x1
      mipWidth = Math.max(1, mipWidth);
      mipHeight = Math.max(1, mipHeight);

      const texture = this.#device.createTexture({
        label: `Bloom mip ${i} (${mipWidth}x${mipHeight})`,
        size: [mipWidth, mipHeight],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC,
      });

      textures.push(texture);

      // Halve for next mip
      mipWidth = Math.floor(mipWidth / 2);
      mipHeight = Math.floor(mipHeight / 2);
    }

    this.#bloomMipChainCache.set(key, { textures, width, height });
    return textures;
  }

  /**
   * Render bloom effect using multi-pass downsample/upsample.
   * Returns the final bloom texture (first mip level) to be composited.
   */
  #renderBloom(
    sourceTexture: GPUTexture,
    width: number,
    height: number,
    filterRadius: number,
    threshold: number,
    softness: number,
  ): GPUTexture | null {
    if (
      !this.#bloomDownsamplePipeline ||
      !this.#bloomUpsamplePipeline ||
      !this.#bloomDownsampleBindGroupLayout ||
      !this.#bloomUpsampleBindGroupLayout ||
      this.#bloomDownsampleUniformBuffers.length < BLOOM_MIP_LEVELS ||
      this.#bloomUpsampleUniformBuffers.length < BLOOM_MIP_LEVELS - 1 ||
      !this.#bloomSampler
    ) {
      return null;
    }

    const mipChain = this.#getOrCreateBloomMipChain(width, height);
    if (mipChain.length === 0) return null;

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
      floatView[6] = 0;
      floatView[7] = 0;

      this.#device.queue.writeBuffer(this.#bloomDownsampleUniformBuffers[i]!, 0, uniformData);

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
      this.#device.queue.writeBuffer(
        this.#bloomUpsampleUniformBuffers[bufIdx]!,
        0,
        upsampleUniformData,
      );
    }

    // Single command encoder for all downsample + upsample passes
    const encoder = this.#device.createCommandEncoder({
      label: "Bloom encoder",
    });

    // === Downsample passes ===
    let srcTexture = sourceTexture;
    for (let i = 0; i < mipChain.length; i++) {
      const dstTexture = mipChain[i]!;
      const dstWidth = dstTexture.width;
      const dstHeight = dstTexture.height;

      const bindGroup = this.#device.createBindGroup({
        label: `Bloom downsample bind group mip ${i}`,
        layout: this.#bloomDownsampleBindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: this.#bloomDownsampleUniformBuffers[i]! },
          },
          { binding: 1, resource: srcTexture.createView() },
          { binding: 2, resource: this.#bloomSampler },
        ],
      });

      const pass = encoder.beginRenderPass({
        label: `Bloom downsample pass mip ${i}`,
        colorAttachments: [
          {
            view: dstTexture.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });

      pass.setPipeline(this.#bloomDownsamplePipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setViewport(0, 0, dstWidth, dstHeight, 0, 1);
      pass.draw(3);
      pass.end();

      srcTexture = dstTexture;
    }

    // === Upsample passes ===
    for (let i = mipChain.length - 1; i > 0; i--) {
      const srcMip = mipChain[i]!;
      const dstMip = mipChain[i - 1]!;
      const dstWidth = dstMip.width;
      const dstHeight = dstMip.height;
      const bufIdx = mipChain.length - 1 - i;

      const bindGroup = this.#device.createBindGroup({
        label: `Bloom upsample bind group mip ${i}`,
        layout: this.#bloomUpsampleBindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: this.#bloomUpsampleUniformBuffers[bufIdx]! },
          },
          { binding: 1, resource: srcMip.createView() },
          { binding: 2, resource: this.#bloomSampler },
        ],
      });

      const pass = encoder.beginRenderPass({
        label: `Bloom upsample pass mip ${i}`,
        colorAttachments: [
          {
            view: dstMip.createView(),
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });

      pass.setPipeline(this.#bloomUpsamplePipeline);
      pass.setBindGroup(0, bindGroup);
      pass.setViewport(0, 0, dstWidth, dstHeight, 0, 1);
      pass.draw(3);
      pass.end();
    }

    // Single submission for all bloom passes
    this.#device.queue.submit([encoder.finish()]);

    return mipChain[0] ?? null;
  }

  /**
   * Update adjustments uniforms from entity params
   */
  #updateAdjustmentsUniforms(entity: ShaderCanvasEntity): void {
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
  needsAdjustments(entity: ShaderCanvasEntity): boolean {
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
  needsBlur(entity: ShaderCanvasEntity): boolean {
    const blur = entity.shaderParams.adjustments?.blur;
    return blur != null && blur > 0.001;
  }

  /**
   * Get or create blur mip chain textures for given dimensions.
   * Creates MAX_BLUR_MIP_LEVELS textures at progressively halved resolutions.
   * Textures are cached per entity dimensions to avoid per-frame allocation.
   */
  #getOrCreateBlurMipChain(width: number, height: number): GPUTexture[] {
    const key = `${width}x${height}`;
    const cached = this.#blurMipChainCache.get(key);
    if (cached) return cached.textures;

    const textures: GPUTexture[] = [];
    let mipWidth = Math.floor(width / 2);
    let mipHeight = Math.floor(height / 2);

    for (let i = 0; i < MAX_BLUR_MIP_LEVELS; i++) {
      mipWidth = Math.max(1, mipWidth);
      mipHeight = Math.max(1, mipHeight);

      const texture = this.#device.createTexture({
        label: `Blur mip ${i} (${mipWidth}x${mipHeight})`,
        size: [mipWidth, mipHeight],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.COPY_SRC,
      });

      textures.push(texture);

      mipWidth = Math.floor(mipWidth / 2);
      mipHeight = Math.floor(mipHeight / 2);
    }

    this.#blurMipChainCache.set(key, { textures, width, height });
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
    if (cached) return cached;

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const textureA = this.#device.createTexture({
      label: `Blur blend A (${width}x${height})`,
      size: [width, height],
      format: "rgba8unorm",
      usage,
    });
    const textureB = this.#device.createTexture({
      label: `Blur blend B (${width}x${height})`,
      size: [width, height],
      format: "rgba8unorm",
      usage,
    });

    const entry = { textureA, textureB, width, height };
    this.#blurBlendTextureCache.set(key, entry);
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
    inputTexture: GPUTexture,
    finalTarget: GPUTexture,
    mipChain: GPUTexture[],
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

      this.#device.queue.writeBuffer(
        this.#blurDownsampleUniformBuffers[bufferOffset + i]!,
        0,
        uniformData,
      );

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

      this.#device.queue.writeBuffer(
        this.#blurUpsampleUniformBuffers[bufferOffset + bufIdx]!,
        0,
        uniformData,
      );
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

      this.#device.queue.writeBuffer(
        this.#blurUpsampleUniformBuffers[bufferOffset + bufIdx]!,
        0,
        uniformData,
      );
    }

    // === Downsample passes ===
    let srcTexture = inputTexture;
    for (let i = 0; i < activeLevels; i++) {
      const dstTexture = mipChain[i]!;

      const bindGroup = this.#device.createBindGroup({
        label: `Blur downsample bind group level ${i}`,
        layout: this.#blurDownsampleBindGroupLayout!,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: this.#blurDownsampleUniformBuffers[bufferOffset + i]!,
            },
          },
          { binding: 1, resource: srcTexture.createView() },
          { binding: 2, resource: this.#blurSampler! },
        ],
      });

      const pass = encoder.beginRenderPass({
        label: `Blur downsample pass level ${i}`,
        colorAttachments: [
          {
            view: dstTexture.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });

      pass.setPipeline(this.#blurDownsamplePipeline!);
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
              buffer: this.#blurUpsampleUniformBuffers[bufferOffset + bufIdx]!,
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
              buffer: this.#blurUpsampleUniformBuffers[bufferOffset + bufIdx]!,
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

    this.#device.queue.writeBuffer(this.#blurMixUniformBuffer!, 0, uniformData);

    const bindGroup = this.#device.createBindGroup({
      label: "Blur mix bind group",
      layout: this.#blurMixBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.#blurMixUniformBuffer! } },
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
  applyBlur(entity: ShaderCanvasEntity, inputTexture: GPUTexture, outputTexture: GPUTexture): void {
    if (
      !this.#blurDownsamplePipeline ||
      !this.#blurUpsamplePipeline ||
      !this.#blurDownsampleBindGroupLayout ||
      !this.#blurUpsampleBindGroupLayout ||
      !this.#blurSampler
    ) {
      return;
    }

    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const blur = entity.shaderParams.adjustments?.blur ?? 0;
    const { levelsLow, levelsHigh, offsetLow, offsetHigh, blendFactor } =
      blurParamToKawaseParams(blur);

    const needsBlend = blendFactor > 0.001 && blendFactor < 0.999;
    const levels = needsBlend ? levelsLow : blendFactor >= 0.999 ? levelsHigh : levelsLow;
    const offset = needsBlend ? offsetLow : blendFactor >= 0.999 ? offsetHigh : offsetLow;

    if (levels <= 0 && (!needsBlend || levelsHigh <= 0)) return;

    const mipChain = this.#getOrCreateBlurMipChain(width, height);
    if (mipChain.length === 0) return;

    if (!needsBlend) {
      // Fast path: single pipeline run
      const encoder = this.#device.createCommandEncoder({
        label: "Blur Kawase encoder",
      });
      this.#encodeBlurPasses(
        encoder,
        inputTexture,
        outputTexture,
        mipChain,
        levels,
        offset,
        width,
        height,
        0,
      );
      this.#device.queue.submit([encoder.finish()]);
      return;
    }

    // Cross-level blending path
    const { textureA, textureB } = this.#getOrCreateBlurBlendTextures(width, height);
    const encoder = this.#device.createCommandEncoder({
      label: "Blur Kawase cross-blend encoder",
    });

    // Run 1: Low-level blur -> textureA (uniform buffers 0..MAX-1)
    this.#encodeBlurPasses(
      encoder,
      inputTexture,
      textureA,
      mipChain,
      levelsLow,
      offsetLow,
      width,
      height,
      0,
    );

    // Run 2: High-level blur -> textureB (uniform buffers MAX..MAX*2-1)
    this.#encodeBlurPasses(
      encoder,
      inputTexture,
      textureB,
      mipChain,
      levelsHigh,
      offsetHigh,
      width,
      height,
      MAX_BLUR_MIP_LEVELS,
    );

    // Run 3: Blend textureA + textureB -> outputTexture
    this.#encodeMixPass(encoder, textureA, textureB, outputTexture, blendFactor, width, height);

    this.#device.queue.submit([encoder.finish()]);
  }

  /**
   * Apply adjustments (brightness, contrast, saturation) to a texture.
   * This is a pre-processing step before the main shader.
   */
  applyAdjustments(
    entity: ShaderCanvasEntity,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
  ): void {
    if (
      !this.#adjustmentsPipeline ||
      !this.#adjustmentsBindGroupLayout ||
      !this.#adjustmentsUniformBuffer ||
      !this.#adjustmentsSampler
    ) {
      return;
    }

    // Update uniforms
    this.#updateAdjustmentsUniforms(entity);
    this.#device.queue.writeBuffer(this.#adjustmentsUniformBuffer, 0, this.#adjustmentsUniformData);

    // Create bind group
    const bindGroup = this.#device.createBindGroup({
      label: "Adjustments bind group",
      layout: this.#adjustmentsBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#adjustmentsUniformBuffer } },
        { binding: 1, resource: inputTexture.createView() },
        { binding: 2, resource: this.#adjustmentsSampler },
      ],
    });

    // Render adjusted result to output texture
    const encoder = this.#device.createCommandEncoder({
      label: "Adjustments encoder",
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

    this.#device.queue.submit([encoder.finish()]);
  }

  /**
   * Update post-process uniforms from entity params
   */
  #updatePostProcessUniforms(entity: ShaderCanvasEntity): void {
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
    f[2] = grain.size; // grain_size
    f[3] = grain.intensity; // grain_intensity
    f[4] = bloom.threshold; // bloom_threshold (used in downsample for soft threshold)
    f[5] = bloom.intensity; // bloom_intensity (mix strength)
    f[6] = bloomFilterRadiusToRenderer(bloom.filterRadius); // bloom_filter_radius (UV-space radius for upsample)
    f[7] = chromaticAberration.offset; // chromatic_offset
    u[8] = flags; // enabled_flags
    f[9] = this.#postProcessTime; // time (for animated grain)
    // Padding fills the rest to 64 bytes
  }

  /**
   * Apply post-processing effects to a texture.
   * Runs bloom pipeline first (if enabled), then composites with other effects.
   */
  applyPostProcessing(
    entity: ShaderCanvasEntity,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
  ): void {
    if (
      !this.#postProcessPipeline ||
      !this.#postProcessBindGroupLayout ||
      !this.#postProcessUniformBuffer ||
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
        inputTexture,
        width,
        height,
        bloomFilterRadiusToRenderer(bloom.filterRadius),
        bloom.threshold,
        softness,
      );
    }

    // If no bloom texture was generated, create a 1x1 black texture as placeholder
    // (the shader expects a texture at binding 3)
    let bloomTextureView: GPUTextureView;
    if (bloomTexture) {
      bloomTextureView = bloomTexture.createView();
    } else {
      // Use a dummy 1x1 texture (create once and reuse would be better, but this works)
      const dummyTexture = this.#device.createTexture({
        label: "Dummy bloom texture",
        size: [1, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
      bloomTextureView = dummyTexture.createView();
    }

    // Update uniforms
    this.#updatePostProcessUniforms(entity);
    this.#device.queue.writeBuffer(this.#postProcessUniformBuffer, 0, this.#postProcessUniformData);

    // Create bind group with bloom texture
    const bindGroup = this.#device.createBindGroup({
      label: "Post-process bind group",
      layout: this.#postProcessBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#postProcessUniformBuffer } },
        { binding: 1, resource: inputTexture.createView() },
        { binding: 2, resource: this.#postProcessSampler },
        { binding: 3, resource: bloomTextureView },
      ],
    });

    // Render post-processed result to output texture
    const encoder = this.#device.createCommandEncoder({
      label: "Post-process encoder",
    });

    const pass = encoder.beginRenderPass({
      label: "Post-process render pass",
      colorAttachments: [
        {
          view: outputTexture.createView(),
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

    this.#device.queue.submit([encoder.finish()]);

    // Increment time for animated grain
    this.#postProcessTime += 0.016; // ~60fps increment
  }

  destroy(): void {
    // Destroy uniform buffers
    this.#adjustmentsUniformBuffer?.destroy();
    this.#postProcessUniformBuffer?.destroy();
    for (const buf of this.#blurDownsampleUniformBuffers) buf.destroy();
    for (const buf of this.#blurUpsampleUniformBuffers) buf.destroy();
    this.#blurMixUniformBuffer?.destroy();
    for (const buf of this.#bloomDownsampleUniformBuffers) buf.destroy();
    for (const buf of this.#bloomUpsampleUniformBuffers) buf.destroy();

    // Destroy blur mip chain textures
    for (const cached of this.#blurMipChainCache.values()) {
      for (const texture of cached.textures) {
        texture.destroy();
      }
    }
    this.#blurMipChainCache.clear();

    // Destroy blur blend textures
    for (const cached of this.#blurBlendTextureCache.values()) {
      cached.textureA.destroy();
      cached.textureB.destroy();
    }
    this.#blurBlendTextureCache.clear();

    // Destroy bloom mip chain textures
    for (const cached of this.#bloomMipChainCache.values()) {
      for (const texture of cached.textures) {
        texture.destroy();
      }
    }
    this.#bloomMipChainCache.clear();

    // Clear pipeline references
    this.#adjustmentsPipeline = null;
    this.#adjustmentsBindGroupLayout = null;
    this.#adjustmentsUniformBuffer = null;
    this.#adjustmentsSampler = null;
    this.#blurDownsamplePipeline = null;
    this.#blurUpsamplePipeline = null;
    this.#blurDownsampleBindGroupLayout = null;
    this.#blurUpsampleBindGroupLayout = null;
    this.#blurDownsampleUniformBuffers = [];
    this.#blurUpsampleUniformBuffers = [];
    this.#blurSampler = null;
    this.#blurMixPipeline = null;
    this.#blurMixBindGroupLayout = null;
    this.#blurMixUniformBuffer = null;
    this.#postProcessPipeline = null;
    this.#postProcessBindGroupLayout = null;
    this.#postProcessUniformBuffer = null;
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
