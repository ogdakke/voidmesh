export interface ByteBudgetCacheStats {
  budgetBytes: number;
  residentBytes: number;
  entryCount: number;
  evictions: number;
}

interface ByteBudgetCacheEntry {
  byteSize: number;
  lastUsedFrame: number;
  destroy: () => void;
}

/**
 * Tracks renderer-owned cache entries that must stay alive for the current frame.
 * Callers own the actual maps; eviction callbacks remove and destroy their resources.
 */
export class ByteBudgetCache {
  readonly #budgetBytes: number;
  #entries = new Map<string, ByteBudgetCacheEntry>();
  #currentFrame = 0;
  #residentBytes = 0;
  #evictions = 0;

  constructor(budgetBytes: number) {
    this.#budgetBytes = budgetBytes;
  }

  register(key: string, byteSize: number, destroy: () => void): void {
    if (this.#entries.has(key)) throw new Error(`Byte-budget cache already contains ${key}`);
    this.#entries.set(key, { byteSize, lastUsedFrame: this.#currentFrame, destroy });
    this.#residentBytes += byteSize;
  }

  markUsed(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) throw new Error(`Byte-budget cache does not contain ${key}`);
    entry.lastUsedFrame = this.#currentFrame;
  }

  endFrame(): void {
    this.#evictToBudget();
    this.#currentFrame++;
  }

  getStats(): ByteBudgetCacheStats {
    return {
      budgetBytes: this.#budgetBytes,
      residentBytes: this.#residentBytes,
      entryCount: this.#entries.size,
      evictions: this.#evictions,
    };
  }

  destroy(): void {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    this.#residentBytes = 0;
    for (const entry of entries) entry.destroy();
  }

  #evictToBudget(): void {
    if (this.#residentBytes <= this.#budgetBytes) return;

    const candidates = [...this.#entries.entries()]
      .filter(([, entry]) => entry.lastUsedFrame !== this.#currentFrame)
      .sort((a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame);

    for (const [key, entry] of candidates) {
      if (this.#residentBytes <= this.#budgetBytes) break;
      this.#entries.delete(key);
      this.#residentBytes -= entry.byteSize;
      this.#evictions++;
      entry.destroy();
    }
  }
}
