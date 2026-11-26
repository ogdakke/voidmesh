import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DeferredGpuDestroy } from "#renderer/deferred-gpu-destroy.ts";

function createDevice() {
  const settle: Array<() => void> = [];
  const textureDestroy = vi.fn<() => void>();
  const bufferDestroy = vi.fn<() => void>();
  const device = {
    queue: {
      onSubmittedWorkDone: () =>
        new Promise<undefined>((resolve) => settle.push(() => resolve(undefined))),
    },
    createTexture: () => ({ destroy: textureDestroy }),
    createBuffer: () => ({ destroy: bufferDestroy }),
  } as unknown as GPUDevice;
  return { device, settle, textureDestroy, bufferDestroy };
}

describe("DeferredGpuDestroy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("destroys only after the work submitted before it is done", async () => {
    const { device, settle, textureDestroy, bufferDestroy } = createDevice();
    const deferred = new DeferredGpuDestroy(device);
    const texture = device.createTexture({} as GPUTextureDescriptor);
    const buffer = device.createBuffer({} as GPUBufferDescriptor);

    texture.destroy();
    buffer.destroy();
    expect(textureDestroy).not.toHaveBeenCalled();

    deferred.afterSubmit();
    expect(textureDestroy).not.toHaveBeenCalled();

    // A destroy after that submission waits for the next one.
    const later = device.createTexture({} as GPUTextureDescriptor);
    later.destroy();
    settle[0]!();
    await Promise.resolve();
    expect(textureDestroy).toHaveBeenCalledOnce();
    expect(bufferDestroy).toHaveBeenCalledOnce();

    deferred.afterSubmit();
    settle[1]!();
    await Promise.resolve();
    expect(textureDestroy).toHaveBeenCalledTimes(2);
  });

  test("releases what was destroyed while no frame follows", async () => {
    const { device, settle, textureDestroy } = createDevice();
    new DeferredGpuDestroy(device);
    device.createTexture({} as GPUTextureDescriptor).destroy();

    vi.advanceTimersByTime(250);
    settle[0]!();
    await Promise.resolve();
    expect(textureDestroy).toHaveBeenCalledOnce();
  });

  test("destroys at once after disposal", () => {
    const { device, textureDestroy } = createDevice();
    const deferred = new DeferredGpuDestroy(device);
    const texture = device.createTexture({} as GPUTextureDescriptor);
    deferred.dispose();
    texture.destroy();
    expect(textureDestroy).toHaveBeenCalledOnce();
  });
});
