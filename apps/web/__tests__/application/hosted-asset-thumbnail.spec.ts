import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedAssetThumbnail } from "#application/canvas/hosted-asset-thumbnail.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";

describe("createHostedAssetThumbnail", () => {
  afterEach(() => vi.restoreAllMocks());

  it("captures a video element instead of its static placeholder bitmap", async () => {
    const video = document.createElement("video");
    const drawImage = vi.fn<CanvasRenderingContext2D["drawImage"]>();
    const canvas = {
      getContext: () => ({ drawImage }),
      height: 0,
      toBlob(callback: BlobCallback) {
        callback(new Blob(["preview"], { type: "image/webp" }));
      },
      width: 0,
    } as unknown as HTMLCanvasElement;
    vi.spyOn(document, "createElement").mockReturnValue(canvas);
    const entity = {
      imageBitmap: {} as ImageBitmap,
      mediaSource: { type: "video", videoElement: video },
      originalSize: { height: 720, width: 1280 },
    } as ShaderCanvasEntity;

    await expect(createHostedAssetThumbnail(entity)).resolves.toBeInstanceOf(Blob);

    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
  });
});
