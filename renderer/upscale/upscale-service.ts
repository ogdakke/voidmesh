import type {
  ContentVariant,
  ModelSize,
  UpscaleOptions,
  UpscaleVideoOptions,
} from "./upscale-types.ts";
import { buildNetwork, type UpscaleNetwork } from "./upscale-network.ts";
import { loadWeights } from "./upscale-weights.ts";
import { WORKGROUP_SIZE } from "./upscale-wgsl.ts";
import {
  encodeFrames,
  type FrameEncoderHandle,
  type EncodeProgress,
} from "#renderer/frame-encoder.ts";
import type { GifFrame } from "#types/canvas.ts";
import { logger } from "#lib/client.logger.ts";

/**
 * WebGPU image upscaling service using Anime4K CNN-2x models.
 *
 * Port of the WebSR library's compute shader approach:
 * - Pure WGSL compute shaders, no ML runtime dependency
 * - 3 model sizes (S/M/L) and 3 content variants (rl/an/3d)
 * - 2x upscaling via sub-pixel shuffle + bicubic residual
 *
 * All GPU work is batched into a single command encoder submission.
 */
export class UpscaleService {
  #device: GPUDevice;
  #cache: {
    key: string;
    network: UpscaleNetwork;
    inputTexture: GPUTexture;
    outputTexture: GPUTexture;
    paddedWidth: number;
    paddedHeight: number;
  } | null = null;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /**
   * Upscale an ImageBitmap by 2x using the specified model.
   * Returns a new ImageBitmap with 2x dimensions.
   *
   * The network (pipelines, buffers, bind groups) is cached and reused
   * for subsequent calls with the same model config and padded dimensions.
   */
  async upscale(source: ImageBitmap, opts?: UpscaleOptions): Promise<ImageBitmap> {
    const size: ModelSize = opts?.size ?? "s";
    const variant: ContentVariant = opts?.variant ?? "rl";

    const origWidth = source.width;
    const origHeight = source.height;

    // Pad to multiple of workgroup size for compute dispatch
    const paddedWidth = Math.ceil(origWidth / WORKGROUP_SIZE) * WORKGROUP_SIZE;
    const paddedHeight = Math.ceil(origHeight / WORKGROUP_SIZE) * WORKGROUP_SIZE;
    const cacheKey = `${size}-${variant}-${paddedWidth}-${paddedHeight}`;

    // Reuse or rebuild cached network
    let cached = this.#cache;
    if (!cached || cached.key !== cacheKey) {
      this.#destroyCache();

      const weights = await loadWeights(size, variant);

      const inputTexture = this.#device.createTexture({
        label: "upscale-input",
        size: [paddedWidth, paddedHeight],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      const outputWidth = paddedWidth * 2;
      const outputHeight = paddedHeight * 2;
      const outputTexture = this.#device.createTexture({
        label: "upscale-output",
        size: [outputWidth, outputHeight],
        format: "rgba8unorm",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });

      const network = buildNetwork(
        this.#device,
        size,
        weights,
        paddedWidth,
        paddedHeight,
        inputTexture,
        outputTexture,
      );

      cached = { key: cacheKey, network, inputTexture, outputTexture, paddedWidth, paddedHeight };
      this.#cache = cached;
      logger.debug(`[upscale] Network built: ${cacheKey}`);
    }

    // Upload source pixels to cached input texture
    this.#device.queue.copyExternalImageToTexture({ source }, { texture: cached.inputTexture }, [
      origWidth,
      origHeight,
    ]);

    // Execute all passes in a single command encoder
    const encoder = this.#device.createCommandEncoder({ label: "upscale-encoder" });
    for (const layer of cached.network.computeLayers) {
      layer.encode(encoder);
    }
    cached.network.displayLayer.encode(encoder, cached.outputTexture);

    this.#device.queue.submit([encoder.finish()]);
    await this.#device.queue.onSubmittedWorkDone();

    // Read back output texture, cropping to actual 2x dimensions
    const outputWidth = cached.paddedWidth * 2;
    const outputHeight = cached.paddedHeight * 2;
    const finalWidth = origWidth * 2;
    const finalHeight = origHeight * 2;
    return this.#readTexture(
      cached.outputTexture,
      outputWidth,
      outputHeight,
      finalWidth,
      finalHeight,
    );
  }

  /**
   * Upscale all frames in a GIF by 2x.
   * Returns new GifFrame[] with upscaled bitmaps. Original bitmaps are closed.
   */
  async upscaleGif(
    frames: GifFrame[],
    opts?: UpscaleOptions,
    onProgress?: (frame: number, total: number) => void,
  ): Promise<GifFrame[]> {
    const total = frames.length;
    const upscaledFrames: GifFrame[] = [];
    let cumulativeTimestamp = 0;

    for (let i = 0; i < total; i++) {
      const frame = frames[i]!;
      const upscaledBitmap = await this.upscale(frame.bitmap, opts);
      frame.bitmap.close();

      upscaledFrames.push({
        bitmap: upscaledBitmap,
        delay: frame.delay,
        timestamp: cumulativeTimestamp,
      });

      cumulativeTimestamp += frame.delay;
      onProgress?.(i + 1, total);
    }

    logger.debug(`[upscale] GIF upscaled: ${total} frames`);

    return upscaledFrames;
  }

  /**
   * Upscale a video by 2x: decode frames → upscale each → re-encode to MP4/MOV.
   * Setup is async (loading video, extracting audio). Returns a handle immediately;
   * the progress iterable and result promise resolve once setup completes.
   */
  upscaleVideo(source: Blob, opts?: UpscaleVideoOptions): FrameEncoderHandle {
    const fps = opts?.fps ?? 30;
    const format = opts?.format ?? "mp4";
    const quality = opts?.quality ?? "high";
    const includeAudio = opts?.includeAudio ?? true;
    const upscaleOpts: UpscaleOptions = { size: opts?.size, variant: opts?.variant };

    let outerCancelled = false;
    let innerCancel: (() => void) | null = null;

    let resolveResult: (blob: Blob) => void;
    let rejectResult: (err: Error) => void;
    const resultPromise = new Promise<Blob>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    // Async pipeline: setup video + audio → build renderFrame → start encoding
    const pipelinePromise = this.#setupVideoUpscale(source, includeAudio).then(
      ({ video, blobUrl, audioData }) => {
        if (outerCancelled) {
          video.src = "";
          URL.revokeObjectURL(blobUrl);
          throw new Error("Upscale cancelled");
        }

        const outputWidth = video.videoWidth * 2;
        const outputHeight = video.videoHeight * 2;

        const renderFrame = async (timestampSeconds: number): Promise<ImageBitmap> => {
          video.currentTime = timestampSeconds;
          await new Promise<void>((resolve) => {
            const onSeeked = () => {
              video.removeEventListener("seeked", onSeeked);
              resolve();
            };
            video.addEventListener("seeked", onSeeked);
          });

          const frameBitmap = await createImageBitmap(video);
          const upscaled = await this.upscale(frameBitmap, upscaleOpts);
          frameBitmap.close();
          return upscaled;
        };

        const handle = encodeFrames(renderFrame, {
          width: outputWidth,
          height: outputHeight,
          fps,
          duration: video.duration,
          format,
          quality,
          audioData,
        });

        // Cleanup video on completion or error
        handle.result
          .then(
            () => {},
            () => {},
          )
          .finally(() => {
            video.src = "";
            URL.revokeObjectURL(blobUrl);
          });

        return handle;
      },
    );

    // Forward inner handle's result
    pipelinePromise
      .then((handle) => {
        innerCancel = handle.cancel;
        if (outerCancelled) {
          handle.cancel();
          return;
        }
        handle.result.then(resolveResult!).catch(rejectResult!);
      })
      .catch((err) => rejectResult!(err));

    // Forward progress from inner handle
    async function* progressGenerator(): AsyncGenerator<EncodeProgress> {
      let handle: FrameEncoderHandle;
      try {
        handle = await pipelinePromise;
      } catch {
        return;
      }

      for await (const p of handle.progress) {
        if (outerCancelled) return;
        yield p;
      }
    }

    return {
      progress: progressGenerator(),
      result: resultPromise,
      cancel: () => {
        outerCancelled = true;
        if (innerCancel) innerCancel();
        rejectResult(new Error("Upscale cancelled"));
      },
    };
  }

  /** Load video element + extract audio from blob. Cleans up blob URL on error. */
  async #setupVideoUpscale(
    source: Blob,
    includeAudio: boolean,
  ): Promise<{
    video: HTMLVideoElement;
    blobUrl: string;
    audioData: import("#lib/audio-demux.ts").DemuxedAudio | null;
  }> {
    const blobUrl = URL.createObjectURL(source);

    try {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = blobUrl;

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Failed to load video"));
      });

      const audioData = includeAudio
        ? await import("#lib/audio-demux.ts").then(({ demuxAudio }) => demuxAudio(source))
        : null;

      return { video, blobUrl, audioData };
    } catch (err) {
      URL.revokeObjectURL(blobUrl);
      throw err;
    }
  }

  /**
   * Read a GPU texture back to an ImageBitmap.
   * Supports cropping from padded dimensions to actual output dimensions.
   */
  async #readTexture(
    texture: GPUTexture,
    textureWidth: number,
    textureHeight: number,
    cropWidth: number,
    cropHeight: number,
  ): Promise<ImageBitmap> {
    const bytesPerRow = Math.ceil((textureWidth * 4) / 256) * 256;
    const bufferSize = bytesPerRow * textureHeight;

    const stagingBuffer = this.#device.createBuffer({
      label: "upscale-staging",
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = this.#device.createCommandEncoder({ label: "upscale-readback" });
    encoder.copyTextureToBuffer({ texture }, { buffer: stagingBuffer, bytesPerRow }, [
      textureWidth,
      textureHeight,
    ]);
    this.#device.queue.submit([encoder.finish()]);

    await this.#device.queue.onSubmittedWorkDone();
    await stagingBuffer.mapAsync(GPUMapMode.READ);

    const mappedRange = stagingBuffer.getMappedRange();
    const srcData = new Uint8ClampedArray(mappedRange);

    // Copy cropped region row-by-row (due to bytesPerRow padding and potential crop)
    const data = new Uint8ClampedArray(cropWidth * cropHeight * 4);
    for (let y = 0; y < cropHeight; y++) {
      const srcOffset = y * bytesPerRow;
      const dstOffset = y * cropWidth * 4;
      data.set(srcData.subarray(srcOffset, srcOffset + cropWidth * 4), dstOffset);
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return createImageBitmap(new ImageData(data, cropWidth, cropHeight));
  }

  #destroyCache(): void {
    if (!this.#cache) return;
    const { network, inputTexture, outputTexture } = this.#cache;
    inputTexture.destroy();
    outputTexture.destroy();
    for (const buffer of network.buffers) {
      buffer.destroy();
    }
    this.#cache = null;
  }

  destroy(): void {
    this.#destroyCache();
  }
}
