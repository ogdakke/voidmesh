import { config } from "#config";
import { getTextureByteSize } from "#lib/textures.ts";

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
  #textureCount = 0;
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
      this.#textureCount--;
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

    // The texture may still be referenced by the command buffer currently being encoded.
    // Keep it recyclable, but never destroy released resources before commitSubmitted(),
    // which callers invoke strictly after queue.submit().
    const byteSize = getTextureByteSize(width, height, this.#format);
    pool.push({ texture, lastUsedFrame: this.#currentFrame, byteSize });
    this.#residentBytes += byteSize;
    this.#textureCount++;
  }

  /** Apply retention limits after the encoder containing released textures was submitted. */
  commitSubmitted(): void {
    for (const [key, pool] of this.#pool) {
      for (let index = pool.length - 1; index >= 0; index--) {
        const entry = pool[index]!;
        if (entry.byteSize <= this.#budgetBytes) continue;
        pool.splice(index, 1);
        entry.texture.destroy();
        this.#residentBytes -= entry.byteSize;
        this.#textureCount--;
      }

      while (pool.length > 4) {
        const entry = pool.shift()!;
        entry.texture.destroy();
        this.#residentBytes -= entry.byteSize;
        this.#textureCount--;
      }
      if (pool.length === 0) this.#pool.delete(key);
    }
    this.#trimToBudget();
  }

  /**
   * Call at end of each frame to advance frame counter and cleanup stale textures
   */
  nextFrame(): void {
    this.commitSubmitted();
    this.#currentFrame++;

    // Cleanup stale textures every 60 frames
    if (this.#currentFrame % 60 !== 0) return;

    for (const [key, pool] of this.#pool.entries()) {
      for (let index = pool.length - 1; index >= 0; index--) {
        const entry = pool[index]!;
        const isStale = this.#currentFrame - entry.lastUsedFrame > this.#staleFrameThreshold;
        if (isStale) {
          entry.texture.destroy();
          this.#residentBytes -= entry.byteSize;
          this.#textureCount--;
          pool.splice(index, 1);
        }
      }

      if (pool.length === 0) this.#pool.delete(key);
    }
  }

  getStats(): TexturePoolStats {
    return {
      budgetBytes: this.#budgetBytes,
      residentBytes: this.#residentBytes,
      textureCount: this.#textureCount,
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
    this.#textureCount = 0;
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
      this.#textureCount--;
      if (pool.length === 0) this.#pool.delete(oldestKey);
    }
  }
}
