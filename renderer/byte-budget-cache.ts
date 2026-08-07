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
    // Map iteration order is the LRU queue. Reinsert in O(1) instead of sorting
    // the entire cache when pressure eventually requires eviction.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
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

    for (const [key, entry] of this.#entries) {
      if (this.#residentBytes <= this.#budgetBytes) break;
      // Current-frame entries were most recently reinserted at the tail. Once
      // one is reached, every remaining entry is protected for this frame.
      if (entry.lastUsedFrame === this.#currentFrame) break;
      this.#entries.delete(key);
      this.#residentBytes -= entry.byteSize;
      this.#evictions++;
      entry.destroy();
    }
  }
}
