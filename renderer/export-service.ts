import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { isVideoEntity } from "#types/canvas.ts";
import { getFrameAtTime } from "../lib/gif-decoder.ts";
import { type ImageExportOptions, getImageMimeType } from "./export-formats.ts";
import type { TexturePool } from "./texture-pool.ts";

export type ApplyShaderFn = (
  entity: ShaderCanvasEntity,
  sourceTexture: GPUTexture,
  outputTexture: GPUTexture,
) => void;

export type GetVideoFrameSourceFn = (
  video: HTMLVideoElement,
  width: number,
  height: number,
) => OffscreenCanvas;

export class ExportService {
  #device: GPUDevice;
  #texturePool: TexturePool | null;
  #applyShader: ApplyShaderFn;
  #getVideoFrameSource: GetVideoFrameSourceFn;

  constructor(
    device: GPUDevice,
    texturePool: TexturePool | null,
    applyShader: ApplyShaderFn,
    getVideoFrameSource: GetVideoFrameSourceFn,
  ) {
    this.#device = device;
    this.#texturePool = texturePool;
    this.#applyShader = applyShader;
    this.#getVideoFrameSource = getVideoFrameSource;
  }

  /**
   * Read texture pixels to CPU memory via staging buffer.
   * Used by export methods to get pixel data from GPU textures.
   *
   * @param texture - Source texture to read from (must have COPY_SRC usage)
   * @param width - Width of the texture
   * @param height - Height of the texture
   * @returns Pixel data as Uint8ClampedArray (RGBA format)
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
   * Render a video entity at a specific timestamp to an ImageBitmap.
   * Used for video export - more efficient than Blob for encoding multiple frames.
   *
   * @param entity - Video entity to render
   * @param timestampSeconds - Time in seconds to render
   * @param videoOverride - Optional video element to use instead of entity's video (for export isolation)
   * @returns ImageBitmap of the rendered frame, or null if failed
   */
  async renderVideoFrameAtTime(
    entity: ShaderCanvasEntity,
    timestampSeconds: number,
    videoOverride?: HTMLVideoElement,
  ): Promise<ImageBitmap | null> {
    if (!isVideoEntity(entity)) {
      return null;
    }

    const video = videoOverride ?? entity.mediaSource.videoElement;

    // Seek to target timestamp and wait for seeked event
    video.currentTime = Math.min(timestampSeconds, video.duration);
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
    });

    return this.#renderSourceToImageBitmap(
      entity,
      this.#getVideoFrameSource(video, entity.originalSize.width, entity.originalSize.height),
      entity.originalSize.width,
      entity.originalSize.height,
    );
  }

  /**
   * Render the current video frame through shaders WITHOUT seeking.
   * Used for playback-based export: the video is playing and RVFC has
   * confirmed a new decoded frame is available. This avoids B-frame
   * issues that occur when seeking a paused video frame-by-frame.
   */
  async renderCurrentVideoFrame(
    entity: ShaderCanvasEntity,
    video: HTMLVideoElement,
  ): Promise<ImageBitmap | null> {
    if (!isVideoEntity(entity)) {
      return null;
    }

    return this.#renderSourceToImageBitmap(
      entity,
      this.#getVideoFrameSource(video, entity.originalSize.width, entity.originalSize.height),
      entity.originalSize.width,
      entity.originalSize.height,
    );
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
   * Handles texture acquisition from pool, shader application, GPU readback, and cleanup.
   */
  async #renderSourceToImageBitmap(
    entity: ShaderCanvasEntity,
    source: ImageBitmap | OffscreenCanvas,
    width: number,
    height: number,
  ): Promise<ImageBitmap | null> {
    // Acquire textures from pool (avoids per-frame GPU allocation churn)
    const sourceUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT;
    const outputUsage =
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;

    const sourceTexture = this.#texturePool
      ? this.#texturePool.acquire(width, height, sourceUsage, `Export source texture`)
      : this.#device.createTexture({
          label: `Export source texture`,
          size: [width, height],
          format: "rgba8unorm",
          usage: sourceUsage,
        });

    this.#device.queue.copyExternalImageToTexture({ source }, { texture: sourceTexture }, [
      width,
      height,
    ]);

    const outputTexture = this.#texturePool
      ? this.#texturePool.acquire(width, height, outputUsage, `Export output texture`)
      : this.#device.createTexture({
          label: `Export output texture`,
          size: [width, height],
          format: "rgba8unorm",
          usage: outputUsage,
        });

    this.#applyShader(entity, sourceTexture, outputTexture);

    const data = await this.#readTextureToPixelData(outputTexture, width, height);

    // Release textures back to pool for reuse by the next frame
    if (this.#texturePool) {
      this.#texturePool.release(sourceTexture, width, height, sourceUsage);
      this.#texturePool.release(outputTexture, width, height, outputUsage);
    } else {
      sourceTexture.destroy();
      outputTexture.destroy();
    }

    const imageData = new ImageData(data, width, height);
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext("2d");
    if (!ctx) {
      return null;
    }

    ctx.putImageData(imageData, 0, 0);
    return await createImageBitmap(offscreen);
  }

  /**
   * Render an entity to a Blob for export/clipboard.
   * This renders just the entity's shader output without viewport transforms.
   * Supports PNG (default, lossless) and JPEG (lossy, smaller files).
   */
  async renderEntityToBlob(
    entity: ShaderCanvasEntity,
    options?: ImageExportOptions,
  ): Promise<Blob | null> {
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;

    // Create source texture from ImageBitmap
    const sourceTexture = this.#device.createTexture({
      label: `Export source texture`,
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.#device.queue.copyExternalImageToTexture(
      { source: entity.imageBitmap },
      { texture: sourceTexture },
      [width, height],
    );

    // Create output texture for shader result
    // Needs COPY_SRC for readback, COPY_DST for compute shader path (copies from intermediate texture)
    const outputTexture = this.#device.createTexture({
      label: `Export output texture`,
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });

    // Apply shader using unified method (handles both compute and fragment shader paths)
    this.#applyShader(entity, sourceTexture, outputTexture);

    // Read pixel data from output texture
    const data = await this.#readTextureToPixelData(outputTexture, width, height);

    // Create ImageData and draw to canvas
    const imageData = new ImageData(data, width, height);
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext("2d");
    if (!ctx) {
      sourceTexture.destroy();
      outputTexture.destroy();
      return null;
    }

    ctx.putImageData(imageData, 0, 0);

    // Cleanup
    sourceTexture.destroy();
    outputTexture.destroy();

    const mimeType = options ? getImageMimeType(options.format) : "image/png";
    return await offscreen.convertToBlob({
      type: mimeType,
      ...(options?.format === "jpeg" && { quality: options.quality }),
    });
  }
}
