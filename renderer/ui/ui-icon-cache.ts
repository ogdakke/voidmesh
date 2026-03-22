interface IconRasterRequest {
  cacheKey: string;
  variantKey: string;
  rasterWidth: number;
  rasterHeight: number;
}

interface CachedIconTexture {
  cacheKey: string;
  variantKey: string;
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

export interface UIIconTextureMatch {
  texture: GPUTexture;
  rasterWidth: number;
  rasterHeight: number;
  exact: boolean;
}

const DEFAULT_ICON_SIZE = 48;
const ICON_OVERSAMPLE = 1.5;
const ICON_BUCKET_STEP = 16;
const MAX_ICON_TEXTURE_EDGE = 512;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

function bucketIconTextureSize(displayPixels: number): number {
  const scaled = Math.max(1, Math.ceil(displayPixels * ICON_OVERSAMPLE));
  return Math.min(MAX_ICON_TEXTURE_EDGE, Math.ceil(scaled / ICON_BUCKET_STEP) * ICON_BUCKET_STEP);
}

export function getIconRasterSize(width: number, height: number, pixelScale = 1): IconRasterSize {
  const displayWidth = Math.max(1, Math.abs(width * pixelScale));
  const displayHeight = Math.max(1, Math.abs(height * pixelScale));
  return {
    width: bucketIconTextureSize(displayWidth),
    height: bucketIconTextureSize(displayHeight),
  };
}

export function pickClosestIconRasterSize(
  requested: IconRasterSize,
  available: IconRasterSize[],
): IconRasterSize | null {
  let best: IconRasterSize | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestDelta = Number.POSITIVE_INFINITY;
  let bestAreaDelta = Number.POSITIVE_INFINITY;
  const requestedArea = requested.width * requested.height;

  for (const candidate of available) {
    const isLargerOrEqual =
      candidate.width >= requested.width && candidate.height >= requested.height;
    const rank = isLargerOrEqual ? 0 : 1;
    const delta =
      Math.abs(candidate.width - requested.width) + Math.abs(candidate.height - requested.height);
    const areaDelta = Math.abs(candidate.width * candidate.height - requestedArea);

    if (
      rank < bestRank ||
      (rank === bestRank && delta < bestDelta) ||
      (rank === bestRank && delta === bestDelta && areaDelta < bestAreaDelta)
    ) {
      best = candidate;
      bestRank = rank;
      bestDelta = delta;
      bestAreaDelta = areaDelta;
    }
  }

  return best;
}

/**
 * SVG string + raster size -> GPUTexture cache.
 * Rasterizes icons close to their final display size to avoid magnifying a
 * single low-resolution bitmap when world-space UI is zoomed in.
 */
export class UIIconCache {
  #device: GPUDevice;
  #cache: Map<string, CachedIconTexture> = new Map();
  #variantsBySvg: Map<string, Map<string, CachedIconTexture>> = new Map();
  #pending: Set<string> = new Set();
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
   * First call rasterizes the SVG; subsequent calls return cached texture.
   * Returns null if rasterization fails.
   */
  async getTexture(
    svg: string,
    width = DEFAULT_ICON_SIZE,
    height = DEFAULT_ICON_SIZE,
    pixelScale = 1,
  ): Promise<GPUTexture | null> {
    const request = this.#createRasterRequest(svg, width, height, pixelScale);
    const cached = this.#cache.get(request.cacheKey);
    if (cached) {
      cached.lastUsedAt = performance.now();
      return cached.texture;
    }

    if (this.#pending.has(request.cacheKey)) return null;

    return this.#rasterizeAndUpload(svg, request);
  }

  /** Check if a texture is already cached (synchronous). */
  has(svg: string, width = DEFAULT_ICON_SIZE, height = DEFAULT_ICON_SIZE, pixelScale = 1): boolean {
    return this.#cache.has(this.#createRasterRequest(svg, width, height, pixelScale).cacheKey);
  }

  /** Get cached texture synchronously (returns null if not cached yet). */
  get(
    svg: string,
    width = DEFAULT_ICON_SIZE,
    height = DEFAULT_ICON_SIZE,
    pixelScale = 1,
  ): GPUTexture | null {
    const cached = this.#cache.get(
      this.#createRasterRequest(svg, width, height, pixelScale).cacheKey,
    );
    if (!cached) return null;
    cached.lastUsedAt = performance.now();
    return cached.texture;
  }

  getBest(
    svg: string,
    width = DEFAULT_ICON_SIZE,
    height = DEFAULT_ICON_SIZE,
    pixelScale = 1,
  ): UIIconTextureMatch | null {
    const request = this.#createRasterRequest(svg, width, height, pixelScale);
    const exact = this.#cache.get(request.cacheKey);
    if (exact) {
      exact.lastUsedAt = performance.now();
      return {
        texture: exact.texture,
        rasterWidth: exact.rasterWidth,
        rasterHeight: exact.rasterHeight,
        exact: true,
      };
    }

    const fallback = this.#findClosestVariant(svg, request.rasterWidth, request.rasterHeight);
    if (!fallback) return null;
    fallback.lastUsedAt = performance.now();
    return {
      texture: fallback.texture,
      rasterWidth: fallback.rasterWidth,
      rasterHeight: fallback.rasterHeight,
      exact: false,
    };
  }

  /**
   * Get the closest already-cached variant for this SVG while a better-sized
   * texture is still loading. This avoids visible one-frame pop/flicker when
   * zoom crosses a raster bucket boundary.
   */
  getFallback(
    svg: string,
    width = DEFAULT_ICON_SIZE,
    height = DEFAULT_ICON_SIZE,
    pixelScale = 1,
  ): GPUTexture | null {
    const request = this.#createRasterRequest(svg, width, height, pixelScale);
    const fallback = this.#findClosestVariant(svg, request.rasterWidth, request.rasterHeight);
    if (!fallback) return null;
    fallback.lastUsedAt = performance.now();
    return fallback.texture;
  }

  /** Kick off rasterization in the background without awaiting. */
  preload(
    svg: string,
    width = DEFAULT_ICON_SIZE,
    height = DEFAULT_ICON_SIZE,
    pixelScale = 1,
  ): void {
    const request = this.#createRasterRequest(svg, width, height, pixelScale);
    if (this.#cache.has(request.cacheKey) || this.#pending.has(request.cacheKey)) return;
    void this.#rasterizeAndUpload(svg, request);
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
    this.#variantsBySvg.clear();
    this.#pending.clear();
    this.#cacheBytes = 0;
  }

  #getVariantKey(width: number, height: number): string {
    return `${width}x${height}`;
  }

  #createRasterRequest(
    svg: string,
    width: number,
    height: number,
    pixelScale: number,
  ): IconRasterRequest {
    const raster = getIconRasterSize(width, height, pixelScale);
    const variantKey = this.#getVariantKey(raster.width, raster.height);
    return {
      cacheKey: `${svg}\u0000${variantKey}`,
      variantKey,
      rasterWidth: raster.width,
      rasterHeight: raster.height,
    };
  }

  #storeCached(cached: CachedIconTexture): void {
    this.#cache.set(cached.cacheKey, cached);
    let variants = this.#variantsBySvg.get(cached.svg);
    if (!variants) {
      variants = new Map();
      this.#variantsBySvg.set(cached.svg, variants);
    }
    variants.set(cached.variantKey, cached);
  }

  #findClosestVariant(
    svg: string,
    rasterWidth: number,
    rasterHeight: number,
  ): CachedIconTexture | null {
    const variants = this.#variantsBySvg.get(svg);
    if (!variants || variants.size === 0) return null;

    let best: CachedIconTexture | null = null;
    let bestRank = Number.POSITIVE_INFINITY;
    let bestDelta = Number.POSITIVE_INFINITY;
    let bestAreaDelta = Number.POSITIVE_INFINITY;
    const requestedArea = rasterWidth * rasterHeight;

    for (const variant of variants.values()) {
      const isLargerOrEqual =
        variant.rasterWidth >= rasterWidth && variant.rasterHeight >= rasterHeight;
      const rank = isLargerOrEqual ? 0 : 1;
      const delta =
        Math.abs(variant.rasterWidth - rasterWidth) + Math.abs(variant.rasterHeight - rasterHeight);
      const areaDelta = Math.abs(variant.rasterWidth * variant.rasterHeight - requestedArea);

      if (
        rank < bestRank ||
        (rank === bestRank && delta < bestDelta) ||
        (rank === bestRank && delta === bestDelta && areaDelta < bestAreaDelta)
      ) {
        best = variant;
        bestRank = rank;
        bestDelta = delta;
        bestAreaDelta = areaDelta;
      }
    }

    return best;
  }

  #deleteCached(cacheKey: string, cached: CachedIconTexture): void {
    cached.texture.destroy();
    this.#cache.delete(cacheKey);
    this.#cacheBytes -= cached.bytes;

    const variants = this.#variantsBySvg.get(cached.svg);
    variants?.delete(cached.variantKey);
    if (variants && variants.size === 0) {
      this.#variantsBySvg.delete(cached.svg);
    }
  }

  async #rasterizeAndUpload(svg: string, request: IconRasterRequest): Promise<GPUTexture | null> {
    this.#pending.add(request.cacheKey);

    try {
      const bitmap = await this.#rasterize(svg, request.rasterWidth, request.rasterHeight);
      if (!bitmap) {
        this.#pending.delete(request.cacheKey);
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

      const textureBytes = bitmap.width * bitmap.height * 4;
      bitmap.close();
      this.#storeCached({
        cacheKey: request.cacheKey,
        variantKey: request.variantKey,
        svg,
        rasterWidth: request.rasterWidth,
        rasterHeight: request.rasterHeight,
        texture,
        bytes: textureBytes,
        lastUsedAt: performance.now(),
      });
      this.#cacheBytes += textureBytes;
      this.#pending.delete(request.cacheKey);
      this.#evictOldEntries(request.cacheKey);
      this.#onTextureReady?.();
      return texture;
    } catch {
      this.#pending.delete(request.cacheKey);
      return null;
    }
  }

  #evictOldEntries(preserveKey: string): void {
    if (this.#cacheBytes <= MAX_CACHE_BYTES) return;

    const entries = [...this.#cache.entries()]
      .filter(([key]) => key !== preserveKey)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    for (const [key, cached] of entries) {
      if (this.#cacheBytes <= MAX_CACHE_BYTES) break;
      this.#deleteCached(key, cached);
    }
  }

  async #rasterize(
    svg: string,
    rasterWidth: number,
    rasterHeight: number,
  ): Promise<ImageBitmap | null> {
    try {
      const blob = new Blob([svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);

      try {
        const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            createImageBitmap(img, {
              resizeWidth: rasterWidth,
              resizeHeight: rasterHeight,
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
