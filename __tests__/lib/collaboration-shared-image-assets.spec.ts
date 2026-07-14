import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SharedImageAssetRegistry } from "#lib/collaboration/shared-image-asset-registry.ts";
import {
  createImageAsset,
  getImageAssetReferenceCount,
  releaseImageAsset,
} from "#lib/media-assets.ts";
import { createMockImageBitmap } from "../mocks/media.mock.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";

describe("SharedImageAssetRegistry", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupCanvasTest();
  });

  afterEach(() => cleanup());

  it("shares one decoded asset across duplicate owners", () => {
    const registry = new SharedImageAssetRegistry();
    const asset = createImageAsset({
      imageBitmap: createMockImageBitmap() as unknown as ImageBitmap,
      blob: new Blob(["image"], { type: "image/png" }),
    });

    expect(registry.acquire("hash", () => asset)).toBe(asset);
    expect(registry.acquire("hash")).toBe(asset);
    expect(getImageAssetReferenceCount(asset)).toBe(2);

    registry.forgetOwner(asset);
    releaseImageAsset(asset);
    expect(registry.has("hash")).toBe(true);
    registry.forgetOwner(asset);
    releaseImageAsset(asset);
    expect(registry.has("hash")).toBe(false);
  });
});
