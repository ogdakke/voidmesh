interface CachedIconTexture {
  svg: string;
  rasterWidth: number;
  rasterHeight: number;
  texture: GPUTexture;
  bytes: number;
  lastUsedAt: number;
}

interface IconRasterSize {
  width: number;
  height: number;
}

interface LoadedIconSource {
  image: HTMLImageElement;
  rasterWidth: number;
  rasterHeight: number;
}

const DEFAULT_ICON_SIZE = 48;
export const FIXED_ICON_RASTER_EDGE = 256;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

export function getFixedIconRasterSize(
  sourceWidth = FIXED_ICON_RASTER_EDGE,
  sourceHeight = FIXED_ICON_RASTER_EDGE,
): IconRasterSize {
  const safeWidth =
    Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : FIXED_ICON_RASTER_EDGE;
  const safeHeight =
    Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : FIXED_ICON_RASTER_EDGE;
  const longestEdge = Math.max(safeWidth, safeHeight, 1);
  const scale = FIXED_ICON_RASTER_EDGE / longestEdge;

  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

/**
 * SVG string -> GPUTexture cache.
 * Each unique SVG is decoded once, rasterized once at a fixed large size, and
 * then reused for every render regardless of zoom level.
 */
export class UIIconCache {
  #device: GPUDevice;
  #cache: Map<string, CachedIconTexture> = new Map();
  #pending: Set<string> = new Set();
  #sourceLoads: Map<string, Promise<LoadedIconSource>> = new Map();
  #onTextureReady: (() => void) | null = null;
  #cacheBytes = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** Set a callback invoked when an async texture finishes loading. */
  set onTextureReady(cb: (() => void) | null) {
    this.#onTextureReady = cb;
  }

  /**
   * Get or create a GPU texture for the given SVG string.
   * Width/height/pixelScale are accepted for call-site compatibility but do not
   * affect rasterization anymore.
   */
  async getTexture(
    svg: string,
    _width = DEFAULT_ICON_SIZE,
    _height = DEFAULT_ICON_SIZE,
    _pixelScale = 1,
  ): Promise<GPUTexture | null> {
    const cached = this.#cache.get(svg);
    if (cached) {
      cached.lastUsedAt = performance.now();
      return cached.texture;
    }

    if (this.#pending.has(svg)) return null;

    return this.#rasterizeAndUpload(svg);
  }

  /** Check if a texture is already cached (synchronous). */
  has(
    svg: string,
    _width = DEFAULT_ICON_SIZE,
    _height = DEFAULT_ICON_SIZE,
    _pixelScale = 1,
  ): boolean {
    return this.#cache.has(svg);
  }

  /** Get cached texture synchronously (returns null if not cached yet). */
  get(
    svg: string,
    _width = DEFAULT_ICON_SIZE,
    _height = DEFAULT_ICON_SIZE,
    _pixelScale = 1,
  ): GPUTexture | null {
    const cached = this.#cache.get(svg);
    if (!cached) return null;
    cached.lastUsedAt = performance.now();
    return cached.texture;
  }

  /** Kick off rasterization in the background without awaiting. */
  preload(
    svg: string,
    _width = DEFAULT_ICON_SIZE,
    _height = DEFAULT_ICON_SIZE,
    _pixelScale = 1,
  ): void {
    if (this.#cache.has(svg) || this.#pending.has(svg)) return;
    void this.#rasterizeAndUpload(svg);
  }

  /** Preload multiple SVGs and wait for all to finish. */
  async preloadAll(svgs: string[]): Promise<void> {
    await Promise.all(svgs.map((svg) => this.getTexture(svg)));
  }

  /** Destroy all cached textures. */
  destroy(): void {
    for (const cached of this.#cache.values()) {
      cached.texture.destroy();
    }
    this.#cache.clear();
    this.#pending.clear();
    this.#sourceLoads.clear();
    this.#cacheBytes = 0;
  }

  #deleteCached(svg: string, cached: CachedIconTexture): void {
    cached.texture.destroy();
    this.#cache.delete(svg);
    this.#cacheBytes -= cached.bytes;
  }

  async #rasterizeAndUpload(svg: string): Promise<GPUTexture | null> {
    this.#pending.add(svg);

    try {
      const bitmap = await this.#rasterize(svg);
      if (!bitmap) return null;

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

      const textureBytes = bitmap.width * bitmap.height * 4;
      bitmap.close();
      this.#cache.set(svg, {
        svg,
        rasterWidth: texture.width,
        rasterHeight: texture.height,
        texture,
        bytes: textureBytes,
        lastUsedAt: performance.now(),
      });
      this.#cacheBytes += textureBytes;
      this.#evictOldEntries(svg);
      this.#onTextureReady?.();
      return texture;
    } catch {
      return null;
    } finally {
      this.#pending.delete(svg);
    }
  }

  #evictOldEntries(preserveSvg: string): void {
    if (this.#cacheBytes <= MAX_CACHE_BYTES) return;

    const entries = [...this.#cache.entries()]
      .filter(([svg]) => svg !== preserveSvg)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    for (const [svg, cached] of entries) {
      if (this.#cacheBytes <= MAX_CACHE_BYTES) break;
      this.#deleteCached(svg, cached);
    }
  }

  async #rasterize(svg: string): Promise<ImageBitmap | null> {
    try {
      const source = await this.#getSource(svg);
      return await createImageBitmap(source.image, {
        resizeWidth: source.rasterWidth,
        resizeHeight: source.rasterHeight,
      });
    } catch {
      return null;
    }
  }

  #getSource(svg: string): Promise<LoadedIconSource> {
    const existing = this.#sourceLoads.get(svg);
    if (existing) return existing;

    const pending = this.#loadSource(svg).catch((error) => {
      this.#sourceLoads.delete(svg);
      throw error;
    });
    this.#sourceLoads.set(svg, pending);
    return pending;
  }

  async #loadSource(svg: string): Promise<LoadedIconSource> {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);

    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("SVG image load failed"));
        img.src = url;
      });

      const width = image.naturalWidth || image.width || FIXED_ICON_RASTER_EDGE;
      const height = image.naturalHeight || image.height || FIXED_ICON_RASTER_EDGE;
      const raster = getFixedIconRasterSize(width, height);

      return {
        image,
        rasterWidth: raster.width,
        rasterHeight: raster.height,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
