import { hashBlob } from "#lib/collaboration/protocol.ts";

type BlobHasher = (blob: Blob) => Promise<string>;

/** Shares one in-flight or completed content hash for each Blob identity. */
export class AssetHashCache {
  #hashes = new WeakMap<Blob, Promise<string>>();
  readonly #hash: BlobHasher;

  constructor(hash: BlobHasher = hashBlob) {
    this.#hash = hash;
  }

  get(blob: Blob, onDuration?: (durationMs: number) => void): Promise<string> {
    const cached = this.#hashes.get(blob);
    if (cached) return cached;

    const startedAt = performance.now();
    const pending = this.#hash(blob)
      .then((result) => {
        onDuration?.(performance.now() - startedAt);
        return result;
      })
      .catch((error: unknown) => {
        this.#hashes.delete(blob);
        throw error;
      });
    this.#hashes.set(blob, pending);
    return pending;
  }

  clear(): void {
    this.#hashes = new WeakMap();
  }
}
