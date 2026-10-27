import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeOverlapBenchmarkMode,
  isOverlapBenchmarkModeOpen,
  openOverlapBenchmarkMode,
  subscribeOverlapBenchmarkMode,
} from "#lib/overlap-benchmark-mode.ts";

describe("overlap benchmark mode", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?workspace=test#settings");
  });

  test("opens without reloading or discarding existing query parameters", () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeOverlapBenchmarkMode(listener);

    openOverlapBenchmarkMode();

    expect(isOverlapBenchmarkModeOpen()).toBe(true);
    expect(new URLSearchParams(window.location.search).get("workspace")).toBe("test");
    expect(window.location.hash).toBe("");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  test("closes and removes the optional comparison label", () => {
    window.history.replaceState(null, "", "/?workspace=test&benchmark=overlap&benchLabel=branch");

    closeOverlapBenchmarkMode();

    const params = new URLSearchParams(window.location.search);
    expect(isOverlapBenchmarkModeOpen()).toBe(false);
    expect(params.get("benchLabel")).toBeNull();
    expect(params.get("workspace")).toBe("test");
  });
});
