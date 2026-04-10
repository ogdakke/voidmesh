import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { getFrameAtTime } from "../lib/gif-decoder.ts";
import { mediaAssetRegistry } from "../lib/media-asset-registry.ts";
import { CopyPass } from "./copy-pass.ts";
import { type ImageExportOptions, getImageMimeType } from "./export-formats.ts";
import type { GpuColorConfig } from "./gpu-color-space.ts";
import type { TexturePool } from "./texture-pool.ts";

export type ApplyShaderFn = (
  entity: ShaderCanvasEntity,
  sourceTexture: GPUTexture,
  outputTexture: GPUTexture,
) => void;

export class ExportService {
  #device: GPUDevice;
  #texturePool: TexturePool | null;
  #applyShader: ApplyShaderFn;
  #copyPass: CopyPass;
  #passthroughCopyPass: CopyPass;
  #colorConfig: GpuColorConfig;

  constructor(
    device: GPUDevice,
    texturePool: TexturePool | null,
    applyShader: ApplyShaderFn,
    colorConfig: GpuColorConfig,
  ) {
    this.#device = device;
    this.#texturePool = texturePool;
    this.#applyShader = applyShader;
    this.#copyPass = new CopyPass(device);
    this.#passthroughCopyPass = new CopyPass(device, colorConfig.intermediateFormat);
    this.#colorConfig = colorConfig;
  }

  /**
   * Read texture pixels to CPU memory via staging buffer.
   * Expects an rgba8unorm texture (use CopyPass to convert from rgba16float first).
   */
  async #readTextureToPixelData(
    texture: GPUTexture,
    width: number,
    height: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256; // Must be 256-byte aligned
    const bufferSize = bytesPerRow * height;

    const stagingBuffer = this.#device.createBuffer({
      label: `Staging buffer for texture readback`,
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // Copy texture to staging buffer
    const encoder = this.#device.createCommandEncoder({
      label: `Texture readback encoder`,
    });

    encoder.copyTextureToBuffer({ texture }, { buffer: stagingBuffer, bytesPerRow }, [
      width,
      height,
    ]);

    this.#device.queue.submit([encoder.finish()]);

    // Wait for GPU work and map buffer
    await this.#device.queue.onSubmittedWorkDone();
    await stagingBuffer.mapAsync(GPUMapMode.READ);

    // Read pixel data
    const copyArrayBuffer = stagingBuffer.getMappedRange();
    const data: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(width * height * 4);

    // Copy row by row (due to bytesPerRow padding)
    const srcData = new Uint8ClampedArray(copyArrayBuffer);
    for (let y = 0; y < height; y++) {
      const srcOffset = y * bytesPerRow;
      const dstOffset = y * width * 4;
      data.set(srcData.subarray(srcOffset, srcOffset + width * 4), dstOffset);
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return data;
  }

  /**
   * Convert an rgba16float shader output to 8-bit pixel data via CopyPass,
   * then create an ImageBitmap for export (P3 or sRGB based on GPU capability).
   */
  async #convertToImageBitmap(
    shaderOutput: GPUTexture,
    width: number,
    height: number,
  ): Promise<ImageBitmap | null> {
    // Create rgba8unorm staging texture for readback
    const stagingTexture = this.#device.createTexture({
      label: "Export staging texture (rgba8unorm)",
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // GPU-side format conversion: rgba16float → rgba8unorm (values clamped to [0,1])
    this.#copyPass.execute(shaderOutput, stagingTexture);

    const data = await this.#readTextureToPixelData(stagingTexture, width, height);
    stagingTexture.destroy();

    const imageData = new ImageData(data, width, height, {
      colorSpace: this.#colorConfig.textureColorSpace,
    });
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext("2d", { colorSpace: this.#colorConfig.textureColorSpace });
    if (!ctx) {
      return null;
    }

    ctx.putImageData(imageData, 0, 0);
    return await createImageBitmap(offscreen);
  }

  /**
   * Render a decoded video frame through shaders.
   * Used by the export and upscale pipelines with WebCodecs-decoded frames.
   */
  async renderFrameWithShader(
    entity: ShaderCanvasEntity,
    frameSource: ImageBitmap | OffscreenCanvas,
    width: number,
    height: number,
  ): Promise<ImageBitmap | null> {
    return this.#renderSourceToImageBitmap(entity, frameSource, width, height);
  }

  /**
   * Render a GIF entity's frame at a specific timestamp through shaders.
   * Used for video export - looks up the correct frame via binary search.
   */
  async renderGifFrameAtTime(
    entity: ShaderCanvasEntity,
    timestampSeconds: number,
  ): Promise<ImageBitmap | null> {
    if (entity.mediaSource.type !== "gif") {
      return null;
    }

    const frames = mediaAssetRegistry.getGifFrames(entity.assetId);
    const frame = getFrameAtTime(frames, timestampSeconds, true);

    return this.#renderSourceToImageBitmap(
      entity,
      frame.bitmap,
      entity.originalSize.width,
      entity.originalSize.height,
    );
  }

  /**
   * Shared helper: apply shader to a source image and return the result as ImageBitmap.
   * Source textures stay rgba8unorm (uploaded images are 8-bit).
   * Output textures use the intermediate format (shader processing precision).
   * CopyPass converts to rgba8unorm for readback.
   */
  async #renderSourceToImageBitmap(
    entity: ShaderCanvasEntity,
    source: ImageBitmap | OffscreenCanvas,
    width: number,
    height: number,
  ): Promise<ImageBitmap | null> {
    const sourceUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT;
    const outputUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST;

    const sourceTexture = this.#device.createTexture({
      label: "Export source texture",
      size: [width, height],
      format: "rgba8unorm",
      usage: sourceUsage,
    });

    this.#device.queue.copyExternalImageToTexture(
      { source },
      { texture: sourceTexture, colorSpace: this.#colorConfig.textureColorSpace },
      [width, height],
    );

    // Output texture uses intermediate format (shader processing precision)
    const outputTexture = this.#texturePool
      ? this.#texturePool.acquire(width, height, outputUsage, "Export output texture")
      : this.#device.createTexture({
          label: "Export output texture",
          size: [width, height],
          format: this.#colorConfig.intermediateFormat,
          usage: outputUsage,
        });

    if (entity.shaderParams.showOriginal) {
      this.#passthroughCopyPass.execute(sourceTexture, outputTexture);
    } else {
      this.#applyShader(entity, sourceTexture, outputTexture);
    }

    const bitmap = await this.#convertToImageBitmap(outputTexture, width, height);

    // Cleanup
    sourceTexture.destroy();
    if (this.#texturePool) {
      this.#texturePool.release(outputTexture, width, height, outputUsage);
    } else {
      outputTexture.destroy();
    }

    return bitmap;
  }

  /**
   * Render an entity to a Blob for export/clipboard.
   * This renders just the entity's shader output without viewport transforms.
   * Supports PNG (default, lossless) and JPEG (lossy, smaller files).
   * PNG/JPEG are exported with P3 ICC profile via P3 OffscreenCanvas.
   */
  async renderEntityToBlob(
    entity: ShaderCanvasEntity,
    options?: ImageExportOptions,
  ): Promise<Blob | null> {
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const source =
      entity.mediaSource.type === "image" || entity.mediaSource.type === "svg"
        ? mediaAssetRegistry.getStaticAssetBitmap(entity.assetId)
        : entity.imageBitmap;

    // Source texture: rgba8unorm (uploaded images are 8-bit)
    const sourceTexture = this.#device.createTexture({
      label: "Export source texture",
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.#device.queue.copyExternalImageToTexture(
      { source },
      { texture: sourceTexture, colorSpace: this.#colorConfig.textureColorSpace },
      [width, height],
    );

    // Output texture uses intermediate format (shader processing precision)
    const outputTexture = this.#device.createTexture({
      label: "Export output texture",
      size: [width, height],
      format: this.#colorConfig.intermediateFormat,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });

    // Apply shader or passthrough original based on showOriginal toggle
    if (entity.shaderParams.showOriginal) {
      this.#passthroughCopyPass.execute(sourceTexture, outputTexture);
    } else {
      this.#applyShader(entity, sourceTexture, outputTexture);
    }

    // Convert rgba16float → rgba8unorm via CopyPass, then read back as P3 ImageData
    const stagingTexture = this.#device.createTexture({
      label: "Export staging texture (rgba8unorm)",
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.#copyPass.execute(outputTexture, stagingTexture);

    const data = await this.#readTextureToPixelData(stagingTexture, width, height);

    const imageData = new ImageData(data, width, height, {
      colorSpace: this.#colorConfig.textureColorSpace,
    });
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext("2d", { colorSpace: this.#colorConfig.textureColorSpace });
    if (!ctx) {
      sourceTexture.destroy();
      outputTexture.destroy();
      stagingTexture.destroy();
      return null;
    }

    ctx.putImageData(imageData, 0, 0);

    // Cleanup
    sourceTexture.destroy();
    outputTexture.destroy();
    stagingTexture.destroy();

    // PNG/JPEG will embed the appropriate ICC profile from the canvas color space
    const mimeType = options ? getImageMimeType(options.format) : "image/png";
    return await offscreen.convertToBlob({
      type: mimeType,
      ...(options?.format === "jpeg" && { quality: options.quality }),
    });
  }
}
