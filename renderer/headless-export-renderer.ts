import { config } from "#config";
import { CopyPass } from "./copy-pass.ts";
import { detectGpuColorConfig, type GpuColorConfig } from "./gpu-color-space.ts";
import { TexturePool } from "./texture-pool.ts";
import type { ExportEntitySnapshot } from "./export-snapshot.ts";
import {
  createRgba8Texture,
  readRgba8TextureToPixels,
  uploadExternalImageToTexture,
} from "./gpu-texture-io.ts";
import { EntityShaderRuntime } from "./entity-shader-runtime.ts";
import type { EffectRenderEntity } from "./effect-render-entity.ts";

type ExportFrameSource = ImageBitmap | VideoFrame | OffscreenCanvas;

export class HeadlessExportRenderer {
  #device: GPUDevice;
  #canvas: OffscreenCanvas;
  #context: GPUCanvasContext;
  #colorConfig: GpuColorConfig;
  #texturePool: TexturePool;
  #entityShaderRuntime: EntityShaderRuntime;
  #rgba8CopyPass: CopyPass;
  #presentCopyPass: CopyPass;
  #sourceCanvas: OffscreenCanvas;
  #sourceCtx: OffscreenCanvasRenderingContext2D;

  private constructor(
    device: GPUDevice,
    canvas: OffscreenCanvas,
    context: GPUCanvasContext,
    colorConfig: GpuColorConfig,
    width: number,
    height: number,
  ) {
    this.#device = device;
    this.#canvas = canvas;
    this.#context = context;
    this.#colorConfig = colorConfig;
    this.#texturePool = new TexturePool(device, colorConfig.intermediateFormat);
    this.#sourceCanvas = new OffscreenCanvas(width, height);
    const sourceCtx = this.#sourceCanvas.getContext("2d", {
      alpha: true,
      colorSpace: colorConfig.textureColorSpace,
      willReadFrequently: false,
    });
    if (!sourceCtx) throw new Error("Could not create export source 2D context");
    sourceCtx.imageSmoothingEnabled = true;
    sourceCtx.imageSmoothingQuality = "high";
    this.#sourceCtx = sourceCtx;

    this.#entityShaderRuntime = new EntityShaderRuntime({
      device,
      texturePool: this.#texturePool,
      colorConfig,
    });
    this.#rgba8CopyPass = new CopyPass(device, "rgba8unorm");
    this.#presentCopyPass = new CopyPass(device, colorConfig.canvasFormat);
  }

  static async create(width: number, height: number): Promise<HeadlessExportRenderer> {
    if (!navigator.gpu) throw new Error("Worker WebGPU is not available");

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("Could not request WebGPU adapter in export worker");

    const requiredLimits: Record<string, number> = {};
    if (adapter.limits.maxStorageBufferBindingSize > config.rendering.maxStorageBufferSizeBytes) {
      requiredLimits.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
    }
    if (adapter.limits.maxBufferSize > 268435456) {
      requiredLimits.maxBufferSize = adapter.limits.maxBufferSize;
    }

    const device = await adapter.requestDevice({ requiredLimits });
    const colorConfig = detectGpuColorConfig(device);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("OffscreenCanvas WebGPU context is not available");

    context.configure({
      device,
      format: colorConfig.canvasFormat,
      colorSpace: colorConfig.canvasColorSpace,
      alphaMode: "premultiplied",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING,
    });

    const renderer = new HeadlessExportRenderer(
      device,
      canvas,
      context,
      colorConfig,
      width,
      height,
    );
    await renderer.#entityShaderRuntime.initialize();
    return renderer;
  }

  get canvas(): OffscreenCanvas {
    return this.#canvas;
  }

  get colorConfig(): GpuColorConfig {
    return this.#colorConfig;
  }

  resize(width: number, height: number): void {
    if (this.#canvas.width !== width) this.#canvas.width = width;
    if (this.#canvas.height !== height) this.#canvas.height = height;
    if (this.#sourceCanvas.width !== width) this.#sourceCanvas.width = width;
    if (this.#sourceCanvas.height !== height) this.#sourceCanvas.height = height;
  }

  async renderToCanvas(
    snapshot: ExportEntitySnapshot,
    source: ExportFrameSource,
    width: number,
    height: number,
  ): Promise<void> {
    await this.#withRenderedOutput(snapshot, source, width, height, async (encoder, output) => {
      this.#presentCopyPass.encode(encoder, output, this.#context.getCurrentTexture());
      this.#device.queue.submit([encoder.finish()]);
      await this.#device.queue.onSubmittedWorkDone();
    });
  }

  async renderToPixels(
    snapshot: ExportEntitySnapshot,
    source: ExportFrameSource,
    width: number,
    height: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    return this.#withRenderedOutput(snapshot, source, width, height, async (encoder, output) => {
      const stagingTexture = createRgba8Texture(
        this.#device,
        width,
        height,
        GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
        "Headless export rgba8 staging texture",
      );
      try {
        this.#rgba8CopyPass.encode(encoder, output, stagingTexture);
        return await readRgba8TextureToPixels(this.#device, stagingTexture, {
          width,
          height,
          encoder,
          label: "Headless export texture readback",
        });
      } finally {
        stagingTexture.destroy();
      }
    });
  }

  async #withRenderedOutput<T>(
    snapshot: ExportEntitySnapshot,
    source: ExportFrameSource,
    width: number,
    height: number,
    consume: (encoder: GPUCommandEncoder, outputTexture: GPUTexture) => Promise<T>,
  ): Promise<T> {
    this.resize(width, height);
    const entity = this.#createEntity(snapshot, width, height);
    const { encoder, sourceTexture, outputTexture, outputUsage } = this.#encodeSourceToOutput(
      entity,
      source,
      width,
      height,
    );

    try {
      return await consume(encoder, outputTexture);
    } finally {
      this.#entityShaderRuntime.flushTextureReleases();
      sourceTexture.destroy();
      this.#texturePool.release(outputTexture, width, height, outputUsage);
      this.#texturePool.nextFrame();
    }
  }

  #encodeSourceToOutput(
    entity: EffectRenderEntity,
    source: ExportFrameSource,
    width: number,
    height: number,
  ): {
    encoder: GPUCommandEncoder;
    sourceTexture: GPUTexture;
    outputTexture: GPUTexture;
    outputUsage: GPUTextureUsageFlags;
  } {
    this.#sourceCtx.clearRect(0, 0, width, height);
    this.#sourceCtx.drawImage(source as CanvasImageSource, 0, 0, width, height);

    const sourceTexture = createRgba8Texture(
      this.#device,
      width,
      height,
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
      "Headless export source texture",
    );
    uploadExternalImageToTexture(
      this.#device,
      this.#sourceCanvas,
      sourceTexture,
      width,
      height,
      this.#colorConfig,
    );

    const outputUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST;
    const outputTexture = this.#texturePool.acquire(
      width,
      height,
      outputUsage,
      "Headless export output texture",
    );
    const encoder = this.#device.createCommandEncoder({ label: "Headless export frame encoder" });

    this.#entityShaderRuntime.encode({
      entity,
      source: { kind: "texture", texture: sourceTexture },
      outputTexture,
      encoder,
      width,
      height,
      respectShowOriginal: true,
    });

    return { encoder, sourceTexture, outputTexture, outputUsage };
  }

  #createEntity(snapshot: ExportEntitySnapshot, width: number, height: number): EffectRenderEntity {
    return {
      id: snapshot.id,
      originalSize: { width, height },
      shaderType: snapshot.shaderType,
      shaderParams: snapshot.shaderParams,
    };
  }

  destroy(): void {
    this.#entityShaderRuntime.destroy();
    this.#texturePool.destroy();
    this.#context.unconfigure();
  }
}
