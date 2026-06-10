import { config } from "#config";
import { MediaType, type RGBA, type ShaderCanvasEntity } from "#types/canvas.ts";
import { CopyPass } from "./copy-pass.ts";
import { detectGpuColorConfig, type GpuColorConfig } from "./gpu-color-space.ts";
import { encodeEntityTexturePipeline } from "./entity-texture-pipeline.ts";
import { ProcessingPipeline } from "./processing-pipeline.ts";
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
import type { ExportEntitySnapshot } from "./export-snapshot.ts";
import { ShaderType } from "#types/canvas.ts";

type ExportFrameSource = ImageBitmap | VideoFrame | OffscreenCanvas;

export class HeadlessExportRenderer {
  #device: GPUDevice;
  #canvas: OffscreenCanvas;
  #context: GPUCanvasContext;
  #colorConfig: GpuColorConfig;
  #texturePool: TexturePool;
  #shaderRegistry: ShaderRegistry;
  #shaderContext: ShaderContext;
  #processingPipeline: ProcessingPipeline;
  #passthroughCopyPass: CopyPass;
  #rgba8CopyPass: CopyPass;
  #presentCopyPass: CopyPass;
  #sourceCanvas: OffscreenCanvas;
  #sourceCtx: OffscreenCanvasRenderingContext2D;
  #shaderUniformData = new ArrayBuffer(config.rendering.ditheringUniformSize);
  #shaderFloatView = new Float32Array(this.#shaderUniformData);
  #shaderUintView = new Uint32Array(this.#shaderUniformData);
  #entityShaderUniformBuffer: GPUBuffer;
  #entityShaderSampler: GPUSampler;
  #sortedPaletteCache: { original: readonly RGBA[]; reversed: boolean; sorted: RGBA[] } | null =
    null;

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

    this.#entityShaderUniformBuffer = device.createBuffer({
      label: "Headless entity shader uniforms",
      size: config.rendering.ditheringUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#entityShaderSampler = device.createSampler({
      label: "Headless entity shader sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.#shaderContext = {
      device,
      uniformBuffer: this.#entityShaderUniformBuffer,
      uniformData: this.#shaderUniformData,
      floatView: this.#shaderFloatView,
      uintView: this.#shaderUintView,
      sampler: this.#entityShaderSampler,
      sortedPaletteCache: this.#sortedPaletteCache,
      texturePool: this.#texturePool,
      intermediateFormat: colorConfig.intermediateFormat,
      supportsP3: colorConfig.supportsP3,
    };
    this.#shaderRegistry = new ShaderRegistry();
    this.#processingPipeline = new ProcessingPipeline(
      device,
      colorConfig.intermediateFormat,
      colorConfig.supportsP3,
    );
    this.#passthroughCopyPass = new CopyPass(device, colorConfig.intermediateFormat);
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

    const renderer = new HeadlessExportRenderer(device, canvas, context, colorConfig, width, height);
    await renderer.#initialize();
    return renderer;
  }

  get canvas(): OffscreenCanvas {
    return this.#canvas;
  }

  get colorConfig(): GpuColorConfig {
    return this.#colorConfig;
  }

  async #initialize(): Promise<void> {
    const asciiShader = new AsciiShader(this.#shaderContext);
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
        this.#shaderRegistry.register(type, pass);
      }),
    );
    this.#processingPipeline.initialize();
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
    this.resize(width, height);
    const entity = this.#createEntity(snapshot, width, height);
    const { encoder, sourceTexture, outputTexture, outputUsage } = this.#encodeSourceToOutput(
      entity,
      source,
      width,
      height,
    );

    this.#presentCopyPass.encode(encoder, outputTexture, this.#context.getCurrentTexture());
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();

    sourceTexture.destroy();
    this.#texturePool.release(outputTexture, width, height, outputUsage);
    this.#texturePool.nextFrame();
  }

  async renderToPixels(
    snapshot: ExportEntitySnapshot,
    source: ExportFrameSource,
    width: number,
    height: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    this.resize(width, height);
    const entity = this.#createEntity(snapshot, width, height);
    const { encoder, sourceTexture, outputTexture, outputUsage } = this.#encodeSourceToOutput(
      entity,
      source,
      width,
      height,
    );

    const stagingTexture = this.#device.createTexture({
      label: "Headless export rgba8 staging texture",
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#rgba8CopyPass.encode(encoder, outputTexture, stagingTexture);

    const pixels = await this.#readTextureToPixelData(encoder, stagingTexture, width, height);

    sourceTexture.destroy();
    stagingTexture.destroy();
    this.#texturePool.release(outputTexture, width, height, outputUsage);
    this.#texturePool.nextFrame();
    return pixels;
  }

  #encodeSourceToOutput(
    entity: ShaderCanvasEntity,
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

    const sourceTexture = this.#device.createTexture({
      label: "Headless export source texture",
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.#device.queue.copyExternalImageToTexture(
      { source: this.#sourceCanvas },
      { texture: sourceTexture, colorSpace: this.#colorConfig.textureColorSpace },
      [width, height],
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

    this.#encodeShaderPipeline(entity, sourceTexture, outputTexture, encoder, width, height);

    return { encoder, sourceTexture, outputTexture, outputUsage };
  }

  async #readTextureToPixelData(
    encoder: GPUCommandEncoder,
    texture: GPUTexture,
    width: number,
    height: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const bufferSize = bytesPerRow * height;
    const stagingBuffer = this.#device.createBuffer({
      label: "Headless export staging buffer",
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    encoder.copyTextureToBuffer({ texture }, { buffer: stagingBuffer, bytesPerRow }, [
      width,
      height,
    ]);
    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
    await stagingBuffer.mapAsync(GPUMapMode.READ);

    const mapped = stagingBuffer.getMappedRange();
    const src = new Uint8ClampedArray(mapped);
    const data: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcOffset = y * bytesPerRow;
      const dstOffset = y * width * 4;
      data.set(src.subarray(srcOffset, srcOffset + width * 4), dstOffset);
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();
    return data;
  }

  #encodeShaderPipeline(
    entity: ShaderCanvasEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
    width: number,
    height: number,
  ): void {
    encodeEntityTexturePipeline({
      device: this.#device,
      entity,
      sourceTexture,
      outputTexture,
      encoder,
      width,
      height,
      processingPipeline: this.#processingPipeline,
      shaderRegistry: this.#shaderRegistry,
      texturePool: this.#texturePool,
      passthroughCopyPass: this.#passthroughCopyPass,
      intermediateFormat: this.#colorConfig.intermediateFormat,
      respectShowOriginal: true,
    });
  }

  #createEntity(
    snapshot: ExportEntitySnapshot,
    width: number,
    height: number,
  ): ShaderCanvasEntity {
    return {
      id: snapshot.id,
      name: snapshot.name,
      position: { x: 0, y: 0 },
      size: { width, height },
      zIndex: 0,
      rotation: 0,
      imageBitmap: null as unknown as ImageBitmap,
      originalSize: { width, height },
      shaderType: snapshot.shaderType,
      shaderParams: snapshot.shaderParams,
      edited: true,
      mediaSource: {
        type: MediaType.image,
        imageBitmap: null as unknown as ImageBitmap,
        blob: new Blob(),
      },
    };
  }

  destroy(): void {
    this.#shaderRegistry.destroy();
    this.#processingPipeline.destroy();
    this.#texturePool.destroy();
    this.#entityShaderUniformBuffer.destroy();
    this.#context.unconfigure();
  }
}
