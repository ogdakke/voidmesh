import { afterEach, describe, expect, test, vi } from "vitest";
import { decodeGif } from "#lib/gif-decoder.ts";

describe("decodeGif", () => {
  const originalImageDecoder = globalThis.ImageDecoder;
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  afterEach(() => {
    globalThis.ImageDecoder = originalImageDecoder;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    vi.restoreAllMocks();
  });

  test("closes decoded frames and the decoder when a later bitmap conversion fails", async () => {
    const firstFrameClose = vi.fn<() => void>();
    const secondFrameClose = vi.fn<() => void>();
    const firstBitmapClose = vi.fn<() => void>();
    const decoderClose = vi.fn<() => void>();
    const frames = [
      { duration: 100_000, close: firstFrameClose },
      { duration: 100_000, close: secondFrameClose },
    ];

    class MockImageDecoder {
      completed = Promise.resolve();
      tracks = { selectedTrack: { frameCount: frames.length } };
      close = decoderClose;
      async decode({ frameIndex }: { frameIndex: number }) {
        return { image: frames[frameIndex]! };
      }
    }
    globalThis.ImageDecoder = MockImageDecoder as unknown as typeof ImageDecoder;
    globalThis.createImageBitmap = vi
      .fn<(source: ImageBitmapSource) => Promise<ImageBitmap>>()
      .mockResolvedValueOnce({ width: 10, height: 10, close: firstBitmapClose } as ImageBitmap)
      .mockRejectedValueOnce(new Error("bitmap conversion failed")) as typeof createImageBitmap;

    await expect(decodeGif(new Blob([], { type: "image/gif" }))).rejects.toThrow(
      "bitmap conversion failed",
    );

    expect(firstFrameClose).toHaveBeenCalledOnce();
    expect(secondFrameClose).toHaveBeenCalledOnce();
    expect(firstBitmapClose).toHaveBeenCalledOnce();
    expect(decoderClose).toHaveBeenCalledOnce();
  });
});
