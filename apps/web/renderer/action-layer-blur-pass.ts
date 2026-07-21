import { config } from "#config";
import actionLayerBlitShaderSource from "./action-layer-blit.wgsl?raw";
import type { ProcessingPipeline } from "./processing-pipeline.ts";

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
}

export class ActionLayerBlurPass {
  readonly #device: GPUDevice;
  readonly #intermediateFormat: GPUTextureFormat;
  readonly #pipeline: GPURenderPipeline;
  readonly #bindGroupLayout: GPUBindGroupLayout;
  readonly #uniformBuffer: GPUBuffer;
  readonly #sampler: GPUSampler;

  #tintColor: [number, number, number];
  #textures: {
    width: number;
    height: number;
    output: GPUTexture;
  } | null = null;
  #cacheValid = false;
  #bindGroupCached: GPUBindGroup | null = null;

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
      size: 32,
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

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Action layer blit pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: options.canvasFormat,
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

  setTint(color: [number, number, number]): void {
    this.#tintColor = color;
  }

  invalidateCache(): void {
    this.#cacheValid = false;
  }

  encode(options: EncodeActionLayerBlurOptions): void {
    const { encoder, processingPipeline, sourceTexture, targetView, width, height, blurIntensity } =
      options;
    const blurTextures = this.#getOrCreateTextures(width, height);

    // Only re-run the expensive Kawase blur pipeline when content has actually changed.
    const blurNeedsUpdate = !this.#cacheValid || options.contentDirty;

    if (blurNeedsUpdate) {
      // The canvas texture is configured with TEXTURE_BINDING usage. Sample it
      // directly before the later blit writes back to the canvas.
      processingPipeline.encodeFullScreenBlur(
        encoder,
        sourceTexture,
        blurTextures.output,
        width,
        height,
      );

      this.#cacheValid = true;
    }

    // Always update uniforms (intensity may change during fade animation).
    const tintAmount = config.actionLayer.dimOpacity * blurIntensity;
    const [tr, tg, tb] = this.#tintColor;
    const uniformData = new Float32Array([tintAmount, blurIntensity, 0, 0, tr, tg, tb, 0]);
    this.#device.queue.writeBuffer(this.#uniformBuffer, 0, uniformData);

    // Cache blit bind group (only recreate when textures change).
    if (!this.#bindGroupCached) {
      this.#bindGroupCached = this.#device.createBindGroup({
        label: "Action layer blit bind group",
        layout: this.#bindGroupLayout,
        entries: [
          { binding: 0, resource: blurTextures.output.createView() },
          { binding: 1, resource: this.#sampler },
          { binding: 2, resource: { buffer: this.#uniformBuffer } },
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
    blitPass.setPipeline(this.#pipeline);
    blitPass.setBindGroup(0, this.#bindGroupCached);
    blitPass.draw(3);
    blitPass.end();
  }

  destroy(): void {
    if (this.#textures) {
      this.#textures.output.destroy();
      this.#textures = null;
    }
    this.#cacheValid = false;
    this.#bindGroupCached = null;
    this.#uniformBuffer.destroy();
  }

  #getOrCreateTextures(width: number, height: number): { output: GPUTexture } {
    const cached = this.#textures;
    if (cached && cached.width === width && cached.height === height) {
      return cached;
    }

    if (cached) {
      cached.output.destroy();
    }
    this.#cacheValid = false;
    this.#bindGroupCached = null;

    const output = this.#device.createTexture({
      label: `Action layer blur output (${width}x${height})`,
      size: [width, height],
      format: this.#intermediateFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.#textures = { width, height, output };
    return this.#textures;
  }
}
