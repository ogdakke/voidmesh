import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXED_ICON_RASTER_EDGE,
  getFixedIconRasterSize,
  UIIconCache,
} from "#renderer/ui/ui-icon-cache.ts";

const TEST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>`;

class MockImage {
  naturalWidth = 24;
  naturalHeight = 24;
  width = 24;
  height = 24;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

function createMockDevice() {
  const copyExternalImageToTexture = vi.fn<() => void>();
  const createTexture = vi.fn<(args: { size: [number, number] }) => object>(
    ({ size }: { size: [number, number] }) => ({
      width: size[0],
      height: size[1],
      destroy: vi.fn<() => void>(),
      createView: vi.fn<() => void>(),
    }),
  );

  return {
    device: {
      createTexture,
      queue: {
        copyExternalImageToTexture,
      },
    } as unknown as GPUDevice,
    createTexture,
    copyExternalImageToTexture,
  };
}

describe("getFixedIconRasterSize", () => {
  it("preserves aspect ratio while capping the longest edge", () => {
    expect(getFixedIconRasterSize(24, 24)).toEqual({
      width: FIXED_ICON_RASTER_EDGE,
      height: FIXED_ICON_RASTER_EDGE,
    });
    expect(getFixedIconRasterSize(48, 24)).toEqual({
      width: FIXED_ICON_RASTER_EDGE,
      height: FIXED_ICON_RASTER_EDGE / 2,
    });
  });

  it("falls back to the fixed edge for invalid source dimensions", () => {
    expect(getFixedIconRasterSize(0, 0)).toEqual({
      width: FIXED_ICON_RASTER_EDGE,
      height: FIXED_ICON_RASTER_EDGE,
    });
  });
});

describe("UIIconCache", () => {
  let createImageBitmapMock: ReturnType<typeof vi.fn>;
  let createObjectUrlSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectUrlSpy: ReturnType<typeof vi.spyOn>;
  let originalImage: typeof Image;

  beforeEach(() => {
    originalImage = globalThis.Image;
    createImageBitmapMock = vi.fn<
      (source: unknown, options?: ImageBitmapOptions) => Promise<object>
    >(async (_source, options?: ImageBitmapOptions) => ({
      width: options?.resizeWidth ?? FIXED_ICON_RASTER_EDGE,
      height: options?.resizeHeight ?? FIXED_ICON_RASTER_EDGE,
      close: vi.fn<() => void>(),
    }));

    vi.stubGlobal("Image", MockImage);
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    vi.stubGlobal("GPUTextureUsage", {
      TEXTURE_BINDING: 1,
      COPY_DST: 2,
      RENDER_ATTACHMENT: 4,
    });
    createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => "blob:mock-icon");
    revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    createObjectUrlSpy.mockRestore();
    revokeObjectUrlSpy.mockRestore();
    vi.unstubAllGlobals();
    globalThis.Image = originalImage;
    vi.restoreAllMocks();
  });

  it("creates one texture per SVG regardless of requested size or zoom", async () => {
    const { device, createTexture, copyExternalImageToTexture } = createMockDevice();
    const cache = new UIIconCache(device);

    const first = await cache.getTexture(TEST_SVG, 16, 16, 1);
    const second = await cache.getTexture(TEST_SVG, 16_000, 16_000, 1_000);

    expect(first).toBe(second);
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(copyExternalImageToTexture).toHaveBeenCalledTimes(1);
  });

  it("treats the cached icon as present for any later size request", async () => {
    const { device } = createMockDevice();
    const cache = new UIIconCache(device);

    await cache.getTexture(TEST_SVG, 12, 12, 1);

    expect(cache.has(TEST_SVG, 12, 12, 1)).toBe(true);
    expect(cache.has(TEST_SVG, 1_200, 1_200, 100)).toBe(true);
    expect(cache.get(TEST_SVG, 2, 2, 0.5)).not.toBeNull();
  });
});
