import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedViewportSync } from "#application/canvas/hosted-viewport-sync.ts";
import type { Viewport } from "#types/canvas.ts";

afterEach(() => vi.useRealTimers());

describe("HostedViewportSync", () => {
  it("hydrates the user's camera and debounces later viewport changes", async () => {
    vi.useFakeTimers();
    let viewport: Viewport = { offset: { x: 0, y: 0 }, zoom: 1 };
    const listeners = new Set<() => void>();
    const save = vi.fn().mockResolvedValue(undefined);
    const sync = new HostedViewportSync({
      onError: vi.fn(),
      remote: {
        load: vi.fn().mockResolvedValue({
          viewState: { offset: { x: 12, y: -8 }, updatedAt: 1_000, zoom: 2.5 },
        }),
        save,
      },
      store: {
        getViewport: () => viewport,
        setViewport: (next) => {
          viewport = next;
        },
        subscribeViewport: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        whenViewportInitialized: () => Promise.resolve(),
      },
    });

    await sync.start();
    expect(viewport).toEqual({ offset: { x: 12, y: -8 }, zoom: 2.5 });
    viewport = { offset: { x: 40, y: 50 }, zoom: 0.75 };
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(599);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledWith({ offset: { x: 40, y: 50 }, zoom: 0.75 }, false);
    sync.destroy();
  });

  it("flushes a pending camera update when the workspace unloads", async () => {
    vi.useFakeTimers();
    let viewport: Viewport = { offset: { x: 1, y: 2 }, zoom: 1.25 };
    let listener = () => {};
    const save = vi.fn().mockResolvedValue(undefined);
    const sync = new HostedViewportSync({
      onError: vi.fn(),
      remote: { load: vi.fn().mockResolvedValue({ viewState: null }), save },
      store: {
        getViewport: () => viewport,
        setViewport: (next) => {
          viewport = next;
        },
        subscribeViewport: (next) => {
          listener = next;
          return () => {};
        },
        whenViewportInitialized: () => Promise.resolve(),
      },
    });

    await sync.start();
    listener();
    sync.flush(true);
    expect(save).toHaveBeenCalledWith({ offset: { x: 1, y: 2 }, zoom: 1.25 }, true);
    sync.destroy();
  });
});
