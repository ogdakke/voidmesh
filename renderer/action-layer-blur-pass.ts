import { config } from "#config";
import { getTextureByteSize } from "#lib/textures.ts";
import actionLayerBlitShaderSource from "./action-layer-blit.wgsl?raw";
import type { ProcessingPipeline, ProcessingTextureRegion } from "./processing-pipeline.ts";

interface ActionLayerBlurPassOptions {
  device: GPUDevice;
  canvasFormat: GPUTextureFormat;
  intermediateFormat: GPUTextureFormat;
  tintColor: [number, number, number];
}

interface EncodeActionLayerBlurOptions {
  encoder: GPUCommandEncoder;
  processingPipeline: ProcessingPipeline;
  sourceTexture: GPUTexture;
  targetView: GPUTextureView;
  width: number;
  height: number;
  blurIntensity: number;
  contentDirty: boolean;
  refreshRegion?: ProcessingTextureRegion;
}

export interface ActionLayerBlurPassStats {
  composites: number;
  pyramidRefreshes: number;
  partialPyramidRefreshes: number;
  pyramidReuses: number;
  blurPixels: number;
  fullBlurPixels: number;
  residentBytes: number;
}

export class ActionLayerBlurPass {
  readonly #device: GPUDevice;
  readonly #intermediateFormat: GPUTextureFormat;
  readonly #upsampleCompositePipeline: GPURenderPipeline;
  readonly #bindGroupLayout: GPUBindGroupLayout;
  readonly #uniformBuffer: GPUBuffer;
  readonly #uniformData = new Float32Array(12);
  readonly #uniformCache = new Float32Array(12).fill(Number.NaN);
  readonly #sampler: GPUSampler;

  #tintColor: [number, number, number];
  #textures: {
    width: number;
    height: number;
    downsampleMipChain: GPUTexture[];
    upsampleMipChain: GPUTexture[];
    byteSize: number;
  } | null = null;
  #cacheValid = false;
  #upsampleBinding: { source: GPUTexture; bindGroup: GPUBindGroup } | null = null;
  #composites = 0;
  #pyramidRefreshes = 0;
  #partialPyramidRefreshes = 0;
  #pyramidReuses = 0;
  #blurPixels = 0;
  #fullBlurPixels = 0;

  constructor(options: ActionLayerBlurPassOptions) {
    this.#device = options.device;
    this.#intermediateFormat = options.intermediateFormat;
    this.#tintColor = options.tintColor;

    const shaderModule = this.#device.createShaderModule({
      label: "Action layer blit shader",
      code: actionLayerBlitShaderSource,
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
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

    this.#uniformBuffer = this.#device.createBuffer({
      label: "Action layer blit uniforms",
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#sampler = this.#device.createSampler({
      label: "Action layer blit sampler",
      magFilter: "linear",
      minFilter: "linear",
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Action layer blit pipeline layout",
      bindGroupLayouts: [this.#bindGroupLayout],
    });

    const blend: GPUBlendState = {
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
    };
    this.#upsampleCompositePipeline = this.#device.createRenderPipeline({
      label: "Action layer upsample composite pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_upsample",
        targets: [{ format: options.canvasFormat, blend }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  setTint(color: [number, number, number]): void {
    this.#tintColor = color;
  }

  invalidateCache(): void {
    this.#cacheValid = false;
  }

  getStats(): ActionLayerBlurPassStats {
    return {
      composites: this.#composites,
      pyramidRefreshes: this.#pyramidRefreshes,
      partialPyramidRefreshes: this.#partialPyramidRefreshes,
      pyramidReuses: this.#pyramidReuses,
      blurPixels: this.#blurPixels,
      fullBlurPixels: this.#fullBlurPixels,
      residentBytes: this.#textures?.byteSize ?? 0,
    };
  }

  /** Maximum full-resolution source distance that can reach one output pixel. */
  get sourceDependencyPaddingPx(): number {
    const levels = config.actionLayer.blurLevels;
    const offset = config.actionLayer.blurOffset;
    let radius = 0;
    let sourcePixelScale = 1;

    for (let level = 0; level < levels; level++) {
      radius += (2 + offset) * sourcePixelScale;
      sourcePixelScale *= 2;
    }
    for (let level = levels - 1; level > 0; level--) {
      radius += (3 + 2 * offset) * sourcePixelScale;
      sourcePixelScale /= 2;
    }

    // The final half-resolution composite uses a smaller four-tap kernel. Use
    // the larger legacy upsample footprint so this remains conservative.
    radius += (3 + 2 * offset) * sourcePixelScale;
    return Math.ceil(radius + 1);
  }

  encode(options: EncodeActionLayerBlurOptions): void {
    const { encoder, processingPipeline, sourceTexture, targetView, width, height, blurIntensity } =
      options;
    const blurTextures = this.#getOrCreateTextures(width, height);

    // Always update uniforms (intensity may change during fade animation).
    const tintAmount = config.actionLayer.dimOpacity * blurIntensity;
    const [tr, tg, tb] = this.#tintColor;
    const uniformData = this.#uniformData;
    uniformData[0] = tintAmount;
    uniformData[1] = blurIntensity;
    uniformData[2] = config.actionLayer.blurOffset;
    uniformData[3] = 0;
    uniformData[4] = tr;
    uniformData[5] = tg;
    uniformData[6] = tb;
    uniformData[7] = 0;
    uniformData[8] = width;
    uniformData[9] = height;
    uniformData[10] = 0;
    uniformData[11] = 0;
    let uniformsChanged = false;
    for (let i = 0; i < uniformData.length; i++) {
      if (uniformData[i] !== this.#uniformCache[i]) {
        uniformsChanged = true;
        break;
      }
    }
    if (uniformsChanged) {
      this.#device.queue.writeBuffer(this.#uniformBuffer, 0, uniformData);
      this.#uniformCache.set(uniformData);
    }

    const needsRefresh = options.contentDirty || !this.#cacheValid;
    const cachedBlurMip = blurTextures.upsampleMipChain[0] ?? blurTextures.downsampleMipChain[0];
    if (!cachedBlurMip) throw new Error("Action layer blur requires at least one mip level");
    let blurMip = cachedBlurMip;
    if (needsRefresh) {
      const refreshed = processingPipeline.encodeFullScreenBlurPyramid(
        encoder,
        sourceTexture,
        width,
        height,
        blurTextures.downsampleMipChain,
        blurTextures.upsampleMipChain,
        this.#cacheValid ? options.refreshRegion : undefined,
      );
      if (!refreshed) {
        throw new Error("Action layer blur pyramid could not be encoded");
      }
      blurMip = refreshed.texture;
      this.#cacheValid = true;
      this.#pyramidRefreshes++;
      if (refreshed.partial) this.#partialPyramidRefreshes++;
      this.#blurPixels += refreshed.updatedPixels;
      this.#fullBlurPixels += refreshed.fullPixels;
    } else {
      this.#pyramidReuses++;
    }

    if (this.#upsampleBinding?.source !== blurMip) {
      this.#upsampleBinding = {
        source: blurMip,
        bindGroup: this.#createBindGroup("Action layer upsample composite bind group", blurMip),
      };
    }
    this.#encodeBlit(
      encoder,
      targetView,
      this.#upsampleCompositePipeline,
      this.#upsampleBinding.bindGroup,
      "Action layer upsample composite pass",
    );
    this.#composites++;
  }

  #encodeBlit(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
    label: string,
  ): void {
    const blitPass = encoder.beginRenderPass({
      label,
      colorAttachments: [
        {
          view: targetView,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    blitPass.setPipeline(pipeline);
    blitPass.setBindGroup(0, bindGroup);
    blitPass.draw(3);
    blitPass.end();
  }

  #createBindGroup(label: string, source: GPUTexture): GPUBindGroup {
    return this.#device.createBindGroup({
      label,
      layout: this.#bindGroupLayout,
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: { buffer: this.#uniformBuffer } },
      ],
    });
  }

  destroy(): void {
    if (this.#textures) {
      for (const texture of this.#textures.downsampleMipChain) texture.destroy();
      for (const texture of this.#textures.upsampleMipChain) texture.destroy();
      this.#textures = null;
    }
    this.invalidateCache();
    this.#upsampleBinding = null;
    this.#uniformBuffer.destroy();
  }

  #getOrCreateTextures(
    width: number,
    height: number,
  ): {
    downsampleMipChain: GPUTexture[];
    upsampleMipChain: GPUTexture[];
  } {
    const cached = this.#textures;
    if (cached && cached.width === width && cached.height === height) {
      return cached;
    }

    if (cached) {
      for (const texture of cached.downsampleMipChain) texture.destroy();
      for (const texture of cached.upsampleMipChain) texture.destroy();
    }
    this.invalidateCache();
    this.#upsampleBinding = null;

    const downsampleMipChain: GPUTexture[] = [];
    const upsampleMipChain: GPUTexture[] = [];
    const mipDimensions: Array<{ width: number; height: number }> = [];
    let byteSize = 0;
    let mipWidth = width;
    let mipHeight = height;
    for (let level = 0; level < config.actionLayer.blurLevels; level++) {
      mipWidth = Math.max(1, Math.floor(mipWidth / 2));
      mipHeight = Math.max(1, Math.floor(mipHeight / 2));
      byteSize += getTextureByteSize(mipWidth, mipHeight, this.#intermediateFormat);
      mipDimensions.push({ width: mipWidth, height: mipHeight });
      downsampleMipChain.push(
        this.#device.createTexture({
          label: `Action layer blur downsample mip ${level} (${mipWidth}x${mipHeight})`,
          size: [mipWidth, mipHeight],
          format: this.#intermediateFormat,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        }),
      );
    }

    for (let level = 0; level < downsampleMipChain.length - 1; level++) {
      const dimensions = mipDimensions[level]!;
      byteSize += getTextureByteSize(dimensions.width, dimensions.height, this.#intermediateFormat);
      upsampleMipChain.push(
        this.#device.createTexture({
          label: `Action layer blur upsample mip ${level} (${dimensions.width}x${dimensions.height})`,
          size: [dimensions.width, dimensions.height],
          format: this.#intermediateFormat,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        }),
      );
    }

    this.#textures = { width, height, downsampleMipChain, upsampleMipChain, byteSize };
    return this.#textures;
  }
}
