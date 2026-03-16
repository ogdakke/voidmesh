type DepthResult = {
  depth: { toBlob: (type?: string) => Promise<Blob>; width: number; height: number };
};
type DepthPipeline = (input: unknown) => Promise<DepthResult>;

/**
 * Depth estimation service using Transformers.js + Depth Anything V2 Small.
 * Lazy-loads the model on first use (~50MB download, browser-cached).
 * Runs inference on WebGPU device (separate from the app's rendering device).
 */
export class DepthService {
  #pipeline: DepthPipeline | null = null;
  #loading: Promise<DepthPipeline> | null = null;
  #RawImage: { fromCanvas: (canvas: OffscreenCanvas) => unknown } | null = null;

  /**
   * Estimate depth for a single image.
   * Returns a grayscale ImageBitmap where brighter = closer, darker = farther.
   */
  async estimateDepth(source: ImageBitmap): Promise<ImageBitmap> {
    const pipeline = await this.#getPipeline();

    // Convert ImageBitmap → OffscreenCanvas → RawImage (format Transformers.js accepts)
    const canvas = new OffscreenCanvas(source.width, source.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, 0, 0);
    const rawImage = this.#RawImage!.fromCanvas(canvas);

    const result = await pipeline(rawImage);
    const blob = await result.depth.toBlob("image/png");
    return createImageBitmap(blob);
  }

  async #getPipeline(): Promise<DepthPipeline> {
    if (this.#pipeline) return this.#pipeline;
    if (this.#loading) return this.#loading;

    this.#loading = this.#initPipeline();
    try {
      this.#pipeline = await this.#loading;
      return this.#pipeline;
    } finally {
      this.#loading = null;
    }
  }

  async #initPipeline(): Promise<DepthPipeline> {
    const { pipeline, env, RawImage } = await import("@huggingface/transformers");

    // Disable local model loading — always fetch from HuggingFace CDN
    env.allowLocalModels = false;

    // Cache RawImage for later conversions
    this.#RawImage = RawImage as unknown as { fromCanvas: (canvas: OffscreenCanvas) => unknown };

    const pipe = await pipeline("depth-estimation", "onnx-community/depth-anything-v2-small", {
      device: "webgpu",
      dtype: "fp16",
    });

    return pipe as unknown as DepthPipeline;
  }

  destroy(): void {
    this.#pipeline = null;
    this.#loading = null;
    this.#RawImage = null;
  }
}
