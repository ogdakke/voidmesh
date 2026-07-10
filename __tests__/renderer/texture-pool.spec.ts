import { describe, expect, test, vi } from "vitest";
import { TexturePool } from "#renderer/texture-pool.ts";

describe("TexturePool byte budget", () => {
  test("evicts the least-recently-released texture when idle memory exceeds its budget", () => {
    const first = createTexture();
    const second = createTexture();
    const device = createDevice();
    const byteSize = 100 * 100 * 8;
    const pool = new TexturePool(device, "rgba16float", byteSize);

    pool.release(first, 100, 100, 1);
    pool.nextFrame();
    pool.release(second, 100, 100, 1);

    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.destroy).not.toHaveBeenCalled();
    expect(pool.getStats()).toEqual({
      budgetBytes: byteSize,
      residentBytes: byteSize,
      textureCount: 1,
    });

    expect(pool.acquire(100, 100, 1)).toBe(second);
    expect(pool.getStats()).toEqual({
      budgetBytes: byteSize,
      residentBytes: 0,
      textureCount: 0,
    });
  });

  test("destroys a texture that can never fit in the pool", () => {
    const texture = createTexture();
    const pool = new TexturePool(createDevice(), "rgba16float", 1024);

    pool.release(texture, 100, 100, 1);

    expect(texture.destroy).toHaveBeenCalledOnce();
    expect(pool.getStats()).toMatchObject({ residentBytes: 0, textureCount: 0 });
  });
});

function createTexture(): GPUTexture {
  return { destroy: vi.fn<() => void>() } as unknown as GPUTexture;
}

function createDevice(): GPUDevice {
  return {
    createTexture: vi.fn<GPUDevice["createTexture"]>(),
  } as unknown as GPUDevice;
}
