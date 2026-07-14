import { retainImageAsset } from "#lib/media-assets.ts";
import type { MediaImageAsset } from "#types/canvas.ts";

interface SharedImageAssetRecord {
  key: string;
  asset: MediaImageAsset;
  owners: number;
}

/** Tracks canvas-owned references to image assets shared by collaborative duplicates. */
export class SharedImageAssetRegistry {
  #records = new Map<string, SharedImageAssetRecord>();
  #recordsByAsset = new WeakMap<MediaImageAsset, SharedImageAssetRecord>();

  acquire(key: string, create?: () => MediaImageAsset): MediaImageAsset | null {
    const cached = this.#records.get(key);
    if (cached) {
      retainImageAsset(cached.asset);
      cached.owners++;
      return cached.asset;
    }
    if (!create) return null;
    const asset = create();
    const record = { key, asset, owners: 1 };
    this.#records.set(key, record);
    this.#recordsByAsset.set(asset, record);
    return asset;
  }

  /** Forget one owner before the caller releases its normal media ownership. */
  forgetOwner(asset: MediaImageAsset): void {
    const record = this.#recordsByAsset.get(asset);
    if (!record) return;
    record.owners--;
    if (record.owners === 0) {
      this.#records.delete(record.key);
      this.#recordsByAsset.delete(asset);
    }
  }

  has(key: string): boolean {
    return this.#records.has(key);
  }

  /** Drop lookup ownership without changing any canvas-owned asset references. */
  clear(): void {
    this.#records.clear();
    this.#recordsByAsset = new WeakMap();
  }
}
