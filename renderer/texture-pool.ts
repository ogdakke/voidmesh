import { config } from "#config";

interface PooledTexture {
  texture: GPUTexture;
  lastUsedFrame: number;
  byteSize: number;
}

export interface TexturePoolStats {
  budgetBytes: number;
  residentBytes: number;
  textureCount: number;
}

/**
 * Texture pool to eliminate per-frame allocation churn.
 * Caches textures by dimensions and usage flags for reuse.
 */
export class TexturePool {
  #device: GPUDevice;
  #format: GPUTextureFormat;
  #budgetBytes: number;
  #residentBytes = 0;
  #pool: Map<string, PooledTexture[]> = new Map();
  #currentFrame = 0;
  #staleFrameThreshold = 60; // Clean up textures unused for 60 frames

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    budgetBytes = config.rendering.texturePoolBudgetBytes,
  ) {
    this.#device = device;
    this.#format = format;
    this.#budgetBytes = budgetBytes;
  }

  /**
   * Generate cache key from texture parameters
   */
  #getKey(width: number, height: number, usage: GPUTextureUsageFlags): string {
    return `${width}x${height}-${usage}`;
  }

  /**
   * Acquire a texture from the pool or create a new one
   */
  acquire(width: number, height: number, usage: GPUTextureUsageFlags, label?: string): GPUTexture {
    const key = this.#getKey(width, height, usage);
    const pool = this.#pool.get(key);

    if (pool && pool.length > 0) {
      const entry = pool.pop()!;
      this.#residentBytes -= entry.byteSize;
      if (pool.length === 0) this.#pool.delete(key);
      return entry.texture;
    }

    // Create new texture
    return this.#device.createTexture({
      label: label ?? `Pooled texture ${key}`,
      size: [width, height],
      format: this.#format,
      usage,
    });
  }

  /**
   * Release a texture back to the pool for reuse
   */
  release(texture: GPUTexture, width: number, height: number, usage: GPUTextureUsageFlags): void {
    const key = this.#getKey(width, height, usage);
    let pool = this.#pool.get(key);

    if (!pool) {
      pool = [];
      this.#pool.set(key, pool);
    }

    // Limit pool size per key to prevent unbounded growth
    if (pool.length < 4) {
      const byteSize = getTextureByteSize(width, height, this.#format);
      if (byteSize > this.#budgetBytes) {
        texture.destroy();
        if (pool.length === 0) this.#pool.delete(key);
        return;
      }
      pool.push({ texture, lastUsedFrame: this.#currentFrame, byteSize });
      this.#residentBytes += byteSize;
      this.#trimToBudget();
    } else {
      // Pool full, destroy the texture
      texture.destroy();
    }
  }

  /**
   * Call at end of each frame to advance frame counter and cleanup stale textures
   */
  nextFrame(): void {
    this.#currentFrame++;

    // Cleanup stale textures every 60 frames
    if (this.#currentFrame % 60 !== 0) return;

    for (const [key, pool] of this.#pool.entries()) {
      const filtered = pool.filter((entry) => {
        const isStale = this.#currentFrame - entry.lastUsedFrame > this.#staleFrameThreshold;
        if (isStale) {
          entry.texture.destroy();
          this.#residentBytes -= entry.byteSize;
        }
        return !isStale;
      });

      if (filtered.length === 0) {
        this.#pool.delete(key);
      } else {
        this.#pool.set(key, filtered);
      }
    }
  }

  getStats(): TexturePoolStats {
    let textureCount = 0;
    for (const pool of this.#pool.values()) textureCount += pool.length;
    return {
      budgetBytes: this.#budgetBytes,
      residentBytes: this.#residentBytes,
      textureCount,
    };
  }

  /**
   * Destroy all pooled textures
   */
  destroy(): void {
    for (const pool of this.#pool.values()) {
      for (const entry of pool) {
        entry.texture.destroy();
      }
    }
    this.#pool.clear();
    this.#residentBytes = 0;
  }

  #trimToBudget(): void {
    while (this.#residentBytes > this.#budgetBytes) {
      let oldestKey: string | null = null;
      let oldestIndex = -1;
      let oldestFrame = Infinity;

      for (const [key, pool] of this.#pool) {
        for (let index = 0; index < pool.length; index++) {
          const entry = pool[index]!;
          if (entry.lastUsedFrame < oldestFrame) {
            oldestKey = key;
            oldestIndex = index;
            oldestFrame = entry.lastUsedFrame;
          }
        }
      }

      if (oldestKey === null) {
        throw new Error("TexturePool byte accounting exceeded its budget without an entry");
      }

      const pool = this.#pool.get(oldestKey)!;
      const [entry] = pool.splice(oldestIndex, 1);
      entry!.texture.destroy();
      this.#residentBytes -= entry!.byteSize;
      if (pool.length === 0) this.#pool.delete(oldestKey);
    }
  }
}

function getTextureByteSize(width: number, height: number, format: GPUTextureFormat): number {
  switch (format) {
    case "rgba8unorm":
    case "bgra8unorm":
    case "rgba8unorm-srgb":
    case "bgra8unorm-srgb":
      return width * height * 4;
    case "rgba16float":
      return width * height * 8;
    default:
      throw new Error(`TexturePool format ${format} needs an explicit byte-size mapping`);
  }
}
