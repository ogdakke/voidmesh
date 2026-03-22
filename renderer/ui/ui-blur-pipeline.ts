import { blurParamToKawaseParams, config, MAX_BLUR_MIP_LEVELS } from "#config";
import kawaseDownsampleShaderSource from "../kawase-downsample.wgsl?raw";
import kawaseUpsampleShaderSource from "../kawase-upsample.wgsl?raw";
import textureMixShaderSource from "../texture-mix.wgsl?raw";

export class UIBlurPipeline {
  #device: GPUDevice;
  #format: GPUTextureFormat;

  #downsamplePipeline: GPURenderPipeline | null = null;
  #upsamplePipeline: GPURenderPipeline | null = null;
  #mixPipeline: GPURenderPipeline | null = null;
  #downsampleBindGroupLayout: GPUBindGroupLayout | null = null;
  #upsampleBindGroupLayout: GPUBindGroupLayout | null = null;
  #mixBindGroupLayout: GPUBindGroupLayout | null = null;
  #callSlots: {
    downsampleUniformBuffers: GPUBuffer[];
    upsampleUniformBuffers: GPUBuffer[];
    mixUniformBuffer: GPUBuffer;
  }[] = [];
  #callCursor = 0;
  #sampler: GPUSampler | null = null;
  #mipChainCache = new Map<string, GPUTexture[]>();
  #blendTextureCache = new Map<string, { textureA: GPUTexture; textureB: GPUTexture }>();

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.#device = device;
    this.#format = format;
  }

  initialize(): void {
    this.#sampler = this.#device.createSampler({
      label: "UI blur sampler",
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

    const downsampleModule = this.#device.createShaderModule({
      label: "UI blur downsample shader",
      code: kawaseDownsampleShaderSource,
    });
    this.#downsampleBindGroupLayout = this.#device.createBindGroupLayout({
      label: "UI blur downsample bind group layout",
      entries: bindGroupLayoutEntries,
    });
    this.#downsamplePipeline = this.#device.createRenderPipeline({
      label: "UI blur downsample pipeline",
      layout: this.#device.createPipelineLayout({
        label: "UI blur downsample pipeline layout",
        bindGroupLayouts: [this.#downsampleBindGroupLayout],
      }),
      vertex: {
        module: downsampleModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: downsampleModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#format }],
      },
      primitive: { topology: "triangle-list" },
    });

    const upsampleModule = this.#device.createShaderModule({
      label: "UI blur upsample shader",
      code: kawaseUpsampleShaderSource,
    });
    this.#upsampleBindGroupLayout = this.#device.createBindGroupLayout({
      label: "UI blur upsample bind group layout",
      entries: bindGroupLayoutEntries,
    });
    this.#upsamplePipeline = this.#device.createRenderPipeline({
      label: "UI blur upsample pipeline",
      layout: this.#device.createPipelineLayout({
        label: "UI blur upsample pipeline layout",
        bindGroupLayouts: [this.#upsampleBindGroupLayout],
      }),
      vertex: {
        module: upsampleModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: upsampleModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#format }],
      },
      primitive: { topology: "triangle-list" },
    });

    const mixModule = this.#device.createShaderModule({
      label: "UI blur mix shader",
      code: textureMixShaderSource,
    });
    this.#mixBindGroupLayout = this.#device.createBindGroupLayout({
      label: "UI blur mix bind group layout",
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
    this.#mixPipeline = this.#device.createRenderPipeline({
      label: "UI blur mix pipeline",
      layout: this.#device.createPipelineLayout({
        label: "UI blur mix pipeline layout",
        bindGroupLayouts: [this.#mixBindGroupLayout],
      }),
      vertex: {
        module: mixModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: mixModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  begin(): void {
    this.#callCursor = 0;
  }

  #getCallSlot(index: number): {
    downsampleUniformBuffers: GPUBuffer[];
    upsampleUniformBuffers: GPUBuffer[];
    mixUniformBuffer: GPUBuffer;
  } {
    const existing = this.#callSlots[index];
    if (existing) return existing;

    const downsampleUniformBuffers: GPUBuffer[] = [];
    const upsampleUniformBuffers: GPUBuffer[] = [];
    for (let i = 0; i < MAX_BLUR_MIP_LEVELS * 2; i++) {
      downsampleUniformBuffers.push(
        this.#device.createBuffer({
          label: `UI blur downsample uniforms ${index}:${i}`,
          size: config.rendering.blurUniformSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      upsampleUniformBuffers.push(
        this.#device.createBuffer({
          label: `UI blur upsample uniforms ${index}:${i}`,
          size: config.rendering.blurUniformSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
    }

    const slot = {
      downsampleUniformBuffers,
      upsampleUniformBuffers,
      mixUniformBuffer: this.#device.createBuffer({
        label: `UI blur mix uniforms ${index}`,
        size: config.rendering.blurUniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    };
    this.#callSlots.push(slot);
    return slot;
  }

  encodeBlur(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    width: number,
    height: number,
    blur: number,
  ): void {
    if (
      !this.#downsamplePipeline ||
      !this.#upsamplePipeline ||
      !this.#mixPipeline ||
      !this.#downsampleBindGroupLayout ||
      !this.#upsampleBindGroupLayout ||
      !this.#mixBindGroupLayout ||
      !this.#sampler
    ) {
      return;
    }
    const callSlot = this.#getCallSlot(this.#callCursor++);

    const { levelsLow, levelsHigh, offsetLow, offsetHigh, blendFactor } =
      blurParamToKawaseParams(blur);
    const needsBlend = blendFactor > 0.001 && blendFactor < 0.999;
    const levels = needsBlend ? levelsLow : blendFactor >= 0.999 ? levelsHigh : levelsLow;
    const offset = needsBlend ? offsetLow : blendFactor >= 0.999 ? offsetHigh : offsetLow;
    if (levels <= 0 && (!needsBlend || levelsHigh <= 0)) return;

    const mipChain = this.#getOrCreateMipChain(width, height);
    if (mipChain.length === 0) return;

    if (!needsBlend) {
      this.#encodeBlurPasses(
        encoder,
        inputTexture,
        outputTexture,
        mipChain,
        levels,
        offset,
        width,
        height,
        callSlot.downsampleUniformBuffers,
        callSlot.upsampleUniformBuffers,
        0,
      );
      return;
    }

    const { textureA, textureB } = this.#getOrCreateBlendTextures(width, height);
    this.#encodeBlurPasses(
      encoder,
      inputTexture,
      textureA,
      mipChain,
      levelsLow,
      offsetLow,
      width,
      height,
      callSlot.downsampleUniformBuffers,
      callSlot.upsampleUniformBuffers,
      0,
    );
    this.#encodeBlurPasses(
      encoder,
      inputTexture,
      textureB,
      mipChain,
      levelsHigh,
      offsetHigh,
      width,
      height,
      callSlot.downsampleUniformBuffers,
      callSlot.upsampleUniformBuffers,
      MAX_BLUR_MIP_LEVELS,
    );
    this.#encodeMixPass(
      encoder,
      textureA,
      textureB,
      outputTexture,
      blendFactor,
      width,
      height,
      callSlot.mixUniformBuffer,
    );
  }

  #getOrCreateMipChain(width: number, height: number): GPUTexture[] {
    const key = `${width}x${height}`;
    const cached = this.#mipChainCache.get(key);
    if (cached) return cached;

    const textures: GPUTexture[] = [];
    let mipWidth = Math.floor(width / 2);
    let mipHeight = Math.floor(height / 2);

    for (let i = 0; i < MAX_BLUR_MIP_LEVELS; i++) {
      mipWidth = Math.max(1, mipWidth);
      mipHeight = Math.max(1, mipHeight);
      textures.push(
        this.#device.createTexture({
          label: `UI blur mip ${i} (${mipWidth}x${mipHeight})`,
          size: [mipWidth, mipHeight],
          format: this.#format,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_SRC,
        }),
      );
      mipWidth = Math.floor(mipWidth / 2);
      mipHeight = Math.floor(mipHeight / 2);
    }

    this.#mipChainCache.set(key, textures);
    return textures;
  }

  #getOrCreateBlendTextures(
    width: number,
    height: number,
  ): { textureA: GPUTexture; textureB: GPUTexture } {
    const key = `${width}x${height}`;
    const cached = this.#blendTextureCache.get(key);
    if (cached) return cached;

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const entry = {
      textureA: this.#device.createTexture({
        label: `UI blur blend A (${width}x${height})`,
        size: [width, height],
        format: this.#format,
        usage,
      }),
      textureB: this.#device.createTexture({
        label: `UI blur blend B (${width}x${height})`,
        size: [width, height],
        format: this.#format,
        usage,
      }),
    };
    this.#blendTextureCache.set(key, entry);
    return entry;
  }

  #encodeBlurPasses(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    finalTarget: GPUTexture,
    mipChain: GPUTexture[],
    levels: number,
    offset: number,
    width: number,
    height: number,
    downsampleUniformBuffers: GPUBuffer[],
    upsampleUniformBuffers: GPUBuffer[],
    bufferOffset: number,
  ): void {
    const activeLevels = Math.min(levels, mipChain.length);
    if (activeLevels <= 0) return;

    let srcWidth = width;
    let srcHeight = height;
    for (let i = 0; i < activeLevels; i++) {
      const uniformData = new Float32Array([srcWidth, srcHeight, offset, 0]);
      this.#device.queue.writeBuffer(downsampleUniformBuffers[bufferOffset + i]!, 0, uniformData);
      srcWidth = Math.max(1, Math.floor(srcWidth / 2));
      srcHeight = Math.max(1, Math.floor(srcHeight / 2));
    }

    let uniformIndex = 0;
    for (let i = activeLevels - 1; i > 0; i--) {
      const dstMip = mipChain[i - 1]!;
      const uniformData = new Float32Array([dstMip.width, dstMip.height, offset, 0]);
      this.#device.queue.writeBuffer(
        upsampleUniformBuffers[bufferOffset + uniformIndex]!,
        0,
        uniformData,
      );
      uniformIndex++;
    }
    this.#device.queue.writeBuffer(
      upsampleUniformBuffers[bufferOffset + uniformIndex]!,
      0,
      new Float32Array([width, height, offset, 0]),
    );

    let srcTexture = inputTexture;
    for (let i = 0; i < activeLevels; i++) {
      const dstTexture = mipChain[i]!;
      const bindGroup = this.#device.createBindGroup({
        label: `UI blur downsample bind group ${i}`,
        layout: this.#downsampleBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: downsampleUniformBuffers[bufferOffset + i]! } },
          { binding: 1, resource: srcTexture.createView() },
          { binding: 2, resource: this.#sampler! },
        ],
      });
      const pass = encoder.beginRenderPass({
        label: `UI blur downsample pass ${i}`,
        colorAttachments: [
          {
            view: dstTexture.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      pass.setPipeline(this.#downsamplePipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.setViewport(0, 0, dstTexture.width, dstTexture.height, 0, 1);
      pass.draw(3);
      pass.end();
      srcTexture = dstTexture;
    }

    uniformIndex = 0;
    for (let i = activeLevels - 1; i > 0; i--) {
      const srcMip = mipChain[i]!;
      const dstMip = mipChain[i - 1]!;
      const bindGroup = this.#device.createBindGroup({
        label: `UI blur upsample bind group ${i}`,
        layout: this.#upsampleBindGroupLayout!,
        entries: [
          {
            binding: 0,
            resource: { buffer: upsampleUniformBuffers[bufferOffset + uniformIndex]! },
          },
          { binding: 1, resource: srcMip.createView() },
          { binding: 2, resource: this.#sampler! },
        ],
      });
      const pass = encoder.beginRenderPass({
        label: `UI blur upsample pass ${i}`,
        colorAttachments: [
          {
            view: dstMip.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      pass.setPipeline(this.#upsamplePipeline!);
      pass.setBindGroup(0, bindGroup);
      pass.setViewport(0, 0, dstMip.width, dstMip.height, 0, 1);
      pass.draw(3);
      pass.end();
      uniformIndex++;
    }

    const finalBindGroup = this.#device.createBindGroup({
      label: "UI blur final upsample bind group",
      layout: this.#upsampleBindGroupLayout!,
      entries: [
        {
          binding: 0,
          resource: { buffer: upsampleUniformBuffers[bufferOffset + uniformIndex]! },
        },
        { binding: 1, resource: mipChain[0]!.createView() },
        { binding: 2, resource: this.#sampler! },
      ],
    });
    const finalPass = encoder.beginRenderPass({
      label: "UI blur final upsample pass",
      colorAttachments: [
        {
          view: finalTarget.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    finalPass.setPipeline(this.#upsamplePipeline!);
    finalPass.setBindGroup(0, finalBindGroup);
    finalPass.setViewport(0, 0, finalTarget.width, finalTarget.height, 0, 1);
    finalPass.draw(3);
    finalPass.end();
  }

  #encodeMixPass(
    encoder: GPUCommandEncoder,
    textureA: GPUTexture,
    textureB: GPUTexture,
    outputTexture: GPUTexture,
    mixFactor: number,
    width: number,
    height: number,
    mixUniformBuffer: GPUBuffer,
  ): void {
    this.#device.queue.writeBuffer(
      mixUniformBuffer,
      0,
      new Float32Array([width, height, mixFactor, 0]),
    );
    const bindGroup = this.#device.createBindGroup({
      label: "UI blur mix bind group",
      layout: this.#mixBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: mixUniformBuffer } },
        { binding: 1, resource: textureA.createView() },
        { binding: 2, resource: textureB.createView() },
        { binding: 3, resource: this.#sampler! },
      ],
    });
    const pass = encoder.beginRenderPass({
      label: "UI blur mix pass",
      colorAttachments: [
        {
          view: outputTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.#mixPipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.setViewport(0, 0, width, height, 0, 1);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    for (const slot of this.#callSlots) {
      for (const buffer of slot.downsampleUniformBuffers) buffer.destroy();
      for (const buffer of slot.upsampleUniformBuffers) buffer.destroy();
      slot.mixUniformBuffer.destroy();
    }
    this.#callSlots.length = 0;
    for (const textures of this.#mipChainCache.values()) {
      for (const texture of textures) texture.destroy();
    }
    this.#mipChainCache.clear();
    for (const entry of this.#blendTextureCache.values()) {
      entry.textureA.destroy();
      entry.textureB.destroy();
    }
    this.#blendTextureCache.clear();
    this.#downsamplePipeline = null;
    this.#upsamplePipeline = null;
    this.#mixPipeline = null;
    this.#downsampleBindGroupLayout = null;
    this.#upsampleBindGroupLayout = null;
    this.#mixBindGroupLayout = null;
    this.#sampler = null;
  }
}
