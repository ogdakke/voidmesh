/**
 * Texture pool to eliminate per-frame allocation churn.
 * Caches textures by dimensions and usage flags for reuse.
 */
export class TexturePool {
  #device: GPUDevice;
  #pool: Map<string, { texture: GPUTexture; lastUsedFrame: number }[]> = new Map();
  #currentFrame = 0;
  #staleFrameThreshold = 60; // Clean up textures unused for 60 frames

  constructor(device: GPUDevice) {
    this.#device = device;
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
      entry.lastUsedFrame = this.#currentFrame;
      return entry.texture;
    }

    // Create new texture
    return this.#device.createTexture({
      label: label ?? `Pooled texture ${key}`,
      size: [width, height],
      format: "rgba8unorm",
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
      pool.push({ texture, lastUsedFrame: this.#currentFrame });
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
  }
}
