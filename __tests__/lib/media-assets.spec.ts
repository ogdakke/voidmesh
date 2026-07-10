import { describe, expect, test, vi } from "vitest";
import {
  createImageAsset,
  getImageAssetReferenceCount,
  releaseImageAsset,
  retainImageAsset,
} from "#lib/media-assets.ts";
import { cloneMediaSource } from "#lib/media-loader.ts";

function createBitmap(close = vi.fn<() => void>()): ImageBitmap {
  return { width: 640, height: 853, close } as unknown as ImageBitmap;
}

describe("shared image asset lifetime", () => {
  test("closes decoded pixels only after the final owner releases the asset", () => {
    const close = vi.fn<() => void>();
    const asset = createImageAsset({
      id: "image-shared",
      imageBitmap: createBitmap(close),
      blob: new Blob(["image"], { type: "image/jpeg" }),
    });

    retainImageAsset(asset);
    expect(getImageAssetReferenceCount(asset)).toBe(2);

    releaseImageAsset(asset);
    expect(close).not.toHaveBeenCalled();
    expect(getImageAssetReferenceCount(asset)).toBe(1);

    releaseImageAsset(asset);
    expect(close).toHaveBeenCalledOnce();
    expect(getImageAssetReferenceCount(asset)).toBe(0);
  });

  test("duplicates reuse the encoded and decoded image payload", async () => {
    const asset = createImageAsset({
      id: "image-duplicate",
      imageBitmap: createBitmap(),
      blob: new Blob(["image"], { type: "image/jpeg" }),
    });

    const duplicate = await cloneMediaSource({ type: "image", asset }, asset.imageBitmap);

    expect(duplicate.mediaSource).toEqual({ type: "image", asset });
    expect(duplicate.imageBitmap).toBe(asset.imageBitmap);
    expect(getImageAssetReferenceCount(asset)).toBe(2);

    releaseImageAsset(asset);
    releaseImageAsset(asset);
  });

  test("rejects retaining an asset after its decoded payload was released", () => {
    const asset = createImageAsset({
      id: "image-released",
      imageBitmap: createBitmap(),
      blob: new Blob(["image"], { type: "image/jpeg" }),
    });

    releaseImageAsset(asset);

    expect(() => retainImageAsset(asset)).toThrow(
      "Cannot retain released image asset image-released",
    );
  });
});
