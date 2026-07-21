import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostedViewportSync,
  type HostedViewportRemote,
} from "#application/canvas/hosted-viewport-sync.ts";
import type { Viewport } from "#types/canvas.ts";

afterEach(() => vi.useRealTimers());

describe("HostedViewportSync", () => {
  it("hydrates the user's camera and debounces later viewport changes", async () => {
    vi.useFakeTimers();
    let viewport: Viewport = { offset: { x: 0, y: 0 }, zoom: 1 };
    const listeners = new Set<() => void>();
    const save = vi.fn<HostedViewportRemote["save"]>().mockResolvedValue(undefined);
    const sync = new HostedViewportSync({
      onError: vi.fn<(error: unknown) => void>(),
      remote: {
        load: vi.fn<HostedViewportRemote["load"]>().mockResolvedValue({
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
    const save = vi.fn<HostedViewportRemote["save"]>().mockResolvedValue(undefined);
    const sync = new HostedViewportSync({
      onError: vi.fn<(error: unknown) => void>(),
      remote: {
        load: vi.fn<HostedViewportRemote["load"]>().mockResolvedValue({ viewState: null }),
        save,
      },
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

  it("persists the legal camera bounds instead of transient rubber-band values", async () => {
    let viewport: Viewport = {
      offset: { x: 150_000_000, y: -150_000_000 },
      zoom: 0.005,
    };
    const save = vi.fn<HostedViewportRemote["save"]>().mockResolvedValue(undefined);
    const sync = new HostedViewportSync({
      onError: vi.fn<(error: unknown) => void>(),
      remote: {
        load: vi.fn<HostedViewportRemote["load"]>().mockResolvedValue({ viewState: null }),
        save,
      },
      store: {
        getViewport: () => viewport,
        setViewport: (next) => {
          viewport = next;
        },
        subscribeViewport: () => () => {},
        whenViewportInitialized: () => Promise.resolve(),
      },
    });

    await sync.start();
    sync.flush();

    expect(save).toHaveBeenCalledWith(
      { offset: { x: 100_000_000, y: -100_000_000 }, zoom: 0.01 },
      false,
    );
    sync.destroy();
  });
});
