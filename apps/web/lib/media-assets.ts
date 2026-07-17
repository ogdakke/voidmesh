import type { AlphaHitGrid, MediaAlphaMode, MediaImageAsset } from "#types/canvas.ts";

interface ImageAssetLifetime {
  referenceCount: number;
  released: boolean;
}

const imageAssetLifetimes = new WeakMap<MediaImageAsset, ImageAssetLifetime>();

export interface CreateImageAssetOptions {
  imageBitmap: ImageBitmap;
  blob: Blob;
  alphaHitGrid?: AlphaHitGrid;
  id?: string;
  revision?: number;
  alphaMode?: MediaAlphaMode;
}

/** Create a shared image payload with one owning reference. */
export function createImageAsset(options: CreateImageAssetOptions): MediaImageAsset {
  const asset: MediaImageAsset = {
    id: options.id ?? `image-${crypto.randomUUID()}`,
    revision: options.revision ?? 0,
    alphaMode: options.alphaMode ?? getImageAlphaMode(options.blob),
    imageBitmap: options.imageBitmap,
    blob: options.blob,
    alphaHitGrid: options.alphaHitGrid,
  };
  imageAssetLifetimes.set(asset, { referenceCount: 1, released: false });
  return asset;
}

function getImageAlphaMode(blob: Blob): MediaAlphaMode {
  return blob.type.toLowerCase() === "image/jpeg" ? "none" : "unknown";
}

/** Add one owner for an existing image asset. */
export function retainImageAsset(asset: MediaImageAsset): void {
  const lifetime = getImageAssetLifetime(asset);
  if (lifetime.released) {
    throw new Error(`Cannot retain released image asset ${asset.id}`);
  }
  lifetime.referenceCount++;
}

/** Release decoded pixels when the final asset owner disappears. */
export function releaseImageAsset(asset: MediaImageAsset): void {
  const lifetime = getImageAssetLifetime(asset);
  if (lifetime.released || lifetime.referenceCount <= 0) {
    throw new Error(`Image asset ${asset.id} has already been released`);
  }

  lifetime.referenceCount--;
  if (lifetime.referenceCount === 0) {
    lifetime.released = true;
    asset.imageBitmap.close();
  }
}

/** Exposed for diagnostics and lifecycle tests. */
export function getImageAssetReferenceCount(asset: MediaImageAsset): number {
  return getImageAssetLifetime(asset).referenceCount;
}

function getImageAssetLifetime(asset: MediaImageAsset): ImageAssetLifetime {
  const lifetime = imageAssetLifetimes.get(asset);
  if (!lifetime) {
    throw new Error(`Image asset ${asset.id} is not managed by the media asset lifetime`);
  }
  return lifetime;
}
