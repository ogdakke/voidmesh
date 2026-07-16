import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ViewportUniforms } from "#renderer/viewport-uniforms.ts";

describe("ViewportUniforms", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("uploads only when viewport projection inputs change", () => {
    const buffer = { destroy: vi.fn<GPUBuffer["destroy"]>() } as unknown as GPUBuffer;
    const writeBuffer = vi.fn<GPUQueue["writeBuffer"]>();
    const device = {
      createBuffer: vi.fn<GPUDevice["createBuffer"]>(() => buffer),
      queue: { writeBuffer },
    } as unknown as GPUDevice;
    const uniforms = new ViewportUniforms(device);
    const viewport = { offset: { x: 10, y: 20 }, zoom: 0.5 };

    expect(uniforms.update(viewport, 1920, 1080)).toBe(true);
    expect(uniforms.update(viewport, 1920, 1080)).toBe(false);
    expect(writeBuffer).toHaveBeenCalledOnce();

    viewport.offset.x = 11;
    expect(uniforms.update(viewport, 1920, 1080)).toBe(true);
    expect(uniforms.update(viewport, 1921, 1080)).toBe(true);
    expect(writeBuffer).toHaveBeenCalledTimes(3);

    uniforms.destroy();
    expect(buffer.destroy).toHaveBeenCalledOnce();
  });
});
