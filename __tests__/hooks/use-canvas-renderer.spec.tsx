import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GpuDeviceLostError, WebGpuUnavailableError } from "#renderer/gpu-device-recovery.ts";

const instances: FakeRenderer[] = [];
let nextInitialize: () => Promise<void> = () => Promise.resolve();

class FakeRenderer {
  onDeviceLost?: (error: GpuDeviceLostError) => void;
  destroyed = false;
  readonly canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    instances.push(this);
  }
  initialize() {
    return nextInitialize();
  }
  get isReady() {
    return !this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
  loseDevice() {
    this.onDeviceLost?.(new GpuDeviceLostError("unknown", "GPU process crashed"));
  }
}

vi.mock("#renderer/canvas-renderer.ts", () => ({ InfiniteCanvasRenderer: FakeRenderer }));

const { CanvasRendererStatus, useCanvasRenderer } = await import("#hooks/use-canvas-renderer.ts");

const originalGpu = Object.getOwnPropertyDescriptor(navigator, "gpu");

function renderRendererHook() {
  const canvasRef = { current: document.createElement("canvas") };
  return renderHook(() => useCanvasRenderer(canvasRef));
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  instances.length = 0;
  nextInitialize = () => Promise.resolve();
  Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalGpu) Object.defineProperty(navigator, "gpu", originalGpu);
  else Reflect.deleteProperty(navigator, "gpu");
});

describe("useCanvasRenderer", () => {
  test("reports a missing WebGPU adapter on first start as unsupported", async () => {
    nextInitialize = () => Promise.reject(new WebGpuUnavailableError());
    const { result } = renderRendererHook();
    await flush();
    expect(result.current.status).toBe(CanvasRendererStatus.unsupported);
    expect(result.current.isSupported).toBe(false);
  });

  test("replaces the renderer after a device loss and keeps the canvas mounted", async () => {
    const { result } = renderRendererHook();
    await flush();
    expect(result.current.status).toBe(CanvasRendererStatus.ready);
    const first = result.current.renderer as unknown as FakeRenderer;

    act(() => first.loseDevice());
    expect(result.current.status).toBe(CanvasRendererStatus.recovering);
    expect(result.current.isSupported).toBe(true);
    expect(result.current.renderer).toBeNull();

    await flush(250);
    expect(first.destroyed).toBe(true);
    expect(result.current.status).toBe(CanvasRendererStatus.ready);
    expect(result.current.renderer).not.toBe(first);
    expect(result.current.renderer).toBe(instances.at(-1));
  });

  test("an unavailable adapter after a crash is retried, not reported as unsupported", async () => {
    const { result } = renderRendererHook();
    await flush();
    nextInitialize = () => Promise.reject(new WebGpuUnavailableError());
    act(() => (result.current.renderer as unknown as FakeRenderer).loseDevice());
    await flush(250);
    expect(result.current.status).toBe(CanvasRendererStatus.recovering);
  });

  test("gives up after repeated crashes and recovers on manual retry", async () => {
    const { result } = renderRendererHook();
    await flush();
    nextInitialize = () => Promise.reject(new Error("requestDevice failed"));
    act(() => (result.current.renderer as unknown as FakeRenderer).loseDevice());
    await flush(250);
    await flush(1_000);
    await flush(3_000);
    expect(result.current.status).toBe(CanvasRendererStatus.crashed);
    expect(result.current.isSupported).toBe(false);
    expect(result.current.error?.message).toBe("requestDevice failed");

    nextInitialize = () => Promise.resolve();
    act(() => result.current.retry());
    await flush();
    expect(result.current.status).toBe(CanvasRendererStatus.ready);
  });

  test("waits for the page to become visible before recreating the device", async () => {
    const { result } = renderRendererHook();
    await flush();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const count = instances.length;
    act(() => (result.current.renderer as unknown as FakeRenderer).loseDevice());
    await flush(5_000);
    expect(instances.length).toBe(count);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(result.current.status).toBe(CanvasRendererStatus.ready);
    visibility.mockRestore();
  });
});
