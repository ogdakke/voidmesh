export class AssetRequestPool {
  readonly #limit: number;
  readonly #peersByHash = new Map<string, string>();

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Asset request limit must be a positive integer");
    }
    this.#limit = limit;
  }

  get size(): number {
    return this.#peersByHash.size;
  }

  has(hash: string): boolean {
    return this.#peersByHash.has(hash);
  }

  peerFor(hash: string): string | undefined {
    return this.#peersByHash.get(hash);
  }

  add(hash: string, peerId: string): boolean {
    if (this.#peersByHash.has(hash) || this.#peersByHash.size >= this.#limit) return false;
    this.#peersByHash.set(hash, peerId);
    return true;
  }

  delete(hash: string): boolean {
    return this.#peersByHash.delete(hash);
  }

  deletePeer(peerId: string): number {
    let deleted = 0;
    for (const [hash, sourcePeerId] of this.#peersByHash) {
      if (sourcePeerId !== peerId) continue;
      this.#peersByHash.delete(hash);
      deleted++;
    }
    return deleted;
  }

  clear(): void {
    this.#peersByHash.clear();
  }
}
