/**
 * SVG string -> GPUTexture cache.
 * Rasterizes SVGs at a small fixed size (48px) and uploads to GPU.
 */
export class UIIconCache {
  #device: GPUDevice;
  #cache: Map<string, GPUTexture> = new Map();
  #pending: Set<string> = new Set();
  #onTextureReady: (() => void) | null = null;

  static readonly ICON_SIZE = 48;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** Set a callback invoked when an async texture finishes loading. */
  set onTextureReady(cb: (() => void) | null) {
    this.#onTextureReady = cb;
  }

  /**
   * Get or create a GPU texture for the given SVG string.
   * First call rasterizes the SVG; subsequent calls return cached texture.
   * Returns null if rasterization fails.
   */
  async getTexture(svg: string): Promise<GPUTexture | null> {
    const cached = this.#cache.get(svg);
    if (cached) return cached;

    if (this.#pending.has(svg)) return null;

    return this.#rasterizeAndUpload(svg);
  }

  /** Check if a texture is already cached (synchronous). */
  has(svg: string): boolean {
    return this.#cache.has(svg);
  }

  /** Get cached texture synchronously (returns null if not cached yet). */
  get(svg: string): GPUTexture | null {
    return this.#cache.get(svg) ?? null;
  }

  /** Kick off rasterization in the background without awaiting. */
  preload(svg: string): void {
    if (this.#cache.has(svg) || this.#pending.has(svg)) return;
    void this.#rasterizeAndUpload(svg);
  }

  /** Preload multiple SVGs and wait for all to finish. */
  async preloadAll(svgs: string[]): Promise<void> {
    await Promise.all(svgs.map((svg) => this.getTexture(svg)));
  }

  /** Destroy all cached textures. */
  destroy(): void {
    for (const texture of this.#cache.values()) {
      texture.destroy();
    }
    this.#cache.clear();
    this.#pending.clear();
  }

  async #rasterizeAndUpload(svg: string): Promise<GPUTexture | null> {
    this.#pending.add(svg);

    try {
      const bitmap = await this.#rasterize(svg);
      if (!bitmap) {
        this.#pending.delete(svg);
        return null;
      }

      const texture = this.#device.createTexture({
        size: [bitmap.width, bitmap.height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      this.#device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [
        bitmap.width,
        bitmap.height,
      ]);

      bitmap.close();
      this.#cache.set(svg, texture);
      this.#pending.delete(svg);
      this.#onTextureReady?.();
      return texture;
    } catch {
      this.#pending.delete(svg);
      return null;
    }
  }

  async #rasterize(svg: string): Promise<ImageBitmap | null> {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svg, "image/svg+xml");
      const svgEl = doc.documentElement;

      // Determine aspect ratio from viewBox or width/height
      let aspectRatio = 1;
      const viewBox = svgEl.getAttribute("viewBox");
      if (viewBox) {
        const parts = viewBox.split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) {
          aspectRatio = parts[2]! / parts[3]!;
        }
      } else {
        const w = parseFloat(svgEl.getAttribute("width") ?? "0");
        const h = parseFloat(svgEl.getAttribute("height") ?? "0");
        if (w > 0 && h > 0) {
          aspectRatio = w / h;
        }
      }

      // Size: longest axis = ICON_SIZE
      let canvasWidth: number;
      let canvasHeight: number;
      if (aspectRatio >= 1) {
        canvasWidth = UIIconCache.ICON_SIZE;
        canvasHeight = Math.round(UIIconCache.ICON_SIZE / aspectRatio);
      } else {
        canvasHeight = UIIconCache.ICON_SIZE;
        canvasWidth = Math.round(UIIconCache.ICON_SIZE * aspectRatio);
      }

      // Ensure minimum 1px
      canvasWidth = Math.max(1, canvasWidth);
      canvasHeight = Math.max(1, canvasHeight);

      const blob = new Blob([svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);

      try {
        const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            createImageBitmap(img, {
              resizeWidth: canvasWidth,
              resizeHeight: canvasHeight,
            }).then(resolve, reject);
          };
          img.onerror = () => reject(new Error("SVG image load failed"));
          img.src = url;
        });
        return bitmap;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      return null;
    }
  }
}
