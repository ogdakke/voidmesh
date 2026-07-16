import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { getFrameAtTime } from "#lib/gif-decoder.ts";
import { CopyPass } from "./copy-pass.ts";
import { type ImageExportOptions, getImageMimeType } from "./export-formats.ts";
import type { GpuColorConfig } from "./gpu-color-space.ts";
import {
  createRgba8Texture,
  readRgba8TextureToPixels,
  uploadExternalImageToTexture,
} from "./gpu-texture-io.ts";
import type { TexturePool } from "./texture-pool.ts";

type ExportImageSource = ImageBitmap | OffscreenCanvas | HTMLCanvasElement | HTMLVideoElement;

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
    this.#colorConfig = colorConfig;
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
    const stagingTexture = createRgba8Texture(
      this.#device,
      width,
      height,
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      "Export staging texture (rgba8unorm)",
    );

    // GPU-side format conversion: rgba16float → rgba8unorm (values clamped to [0,1])
    this.#copyPass.execute(shaderOutput, stagingTexture);

    const data = await readRgba8TextureToPixels(this.#device, stagingTexture, {
      width,
      height,
      label: "Export texture readback",
    });
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

  async #convertTextureToBlob(
    texture: GPUTexture,
    width: number,
    height: number,
    options?: ImageExportOptions,
  ): Promise<Blob | null> {
    // rgba8unorm is the readback storage format, not the color gamut.
    // ImageData and OffscreenCanvas below use textureColorSpace, so P3-capable
    // exports preserve display-p3 interpretation while converting to 8-bit pixels.
    const stagingTexture = createRgba8Texture(
      this.#device,
      width,
      height,
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      "Export staging texture (rgba8unorm)",
    );

    this.#copyPass.execute(texture, stagingTexture);

    const data = await readRgba8TextureToPixels(this.#device, stagingTexture, {
      width,
      height,
      label: "Export texture readback",
    });

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

    const mimeType = options ? getImageMimeType(options.format) : "image/png";
    return await offscreen.convertToBlob({
      type: mimeType,
      ...(options?.format === "jpeg" && { quality: options.quality }),
    });
  }

  /**
   * Render a decoded video frame through shaders.
   * Used by the export pipeline with WebCodecs-decoded frames.
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

    const frame = getFrameAtTime(entity.mediaSource.frames, timestampSeconds, true);

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
    source: ExportImageSource,
    width: number,
    height: number,
  ): Promise<ImageBitmap | null> {
    const outputTexture = this.#renderSourceToTexture(entity, source, width, height);
    const bitmap = await this.#convertToImageBitmap(outputTexture, width, height);
    this.#releaseRenderedSourceTexture(outputTexture, width, height);
    return bitmap;
  }

  async renderSourceToBlob(
    entity: ShaderCanvasEntity,
    source: ExportImageSource,
    width: number,
    height: number,
    options?: ImageExportOptions,
  ): Promise<Blob | null> {
    const outputTexture = this.#renderSourceToTexture(entity, source, width, height);
    const blob = await this.#convertTextureToBlob(outputTexture, width, height, options);
    this.#releaseRenderedSourceTexture(outputTexture, width, height);
    return blob;
  }

  #renderSourceToTexture(
    entity: ShaderCanvasEntity,
    source: ExportImageSource,
    width: number,
    height: number,
  ): GPUTexture {
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

    uploadExternalImageToTexture(
      this.#device,
      source,
      sourceTexture,
      width,
      height,
      this.#colorConfig,
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

    this.#applyShader(entity, sourceTexture, outputTexture);

    sourceTexture.destroy();
    return outputTexture;
  }

  #releaseRenderedSourceTexture(texture: GPUTexture, width: number, height: number): void {
    const outputUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST;
    if (this.#texturePool) {
      this.#texturePool.release(texture, width, height, outputUsage);
      this.#texturePool.commitSubmitted();
    } else {
      texture.destroy();
    }
  }

  /**
   * Convert an already-rendered entity texture to a Blob.
   * Used by copy/save so exports capture the exact frame currently composited
   * on the canvas, including static entities, animated media, and time-animated
   * shaders.
   */
  async renderTextureToBlob(
    texture: GPUTexture,
    width: number,
    height: number,
    options?: ImageExportOptions,
  ): Promise<Blob | null> {
    return this.#convertTextureToBlob(texture, width, height, options);
  }
}
