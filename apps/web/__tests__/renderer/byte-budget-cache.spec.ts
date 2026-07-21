import { describe, expect, test, vi } from "vitest";
import { ByteBudgetCache } from "#renderer/byte-budget-cache.ts";

describe("ByteBudgetCache", () => {
  test("pins current-frame entries and evicts the least-recently-used older entry", () => {
    const destroyFirst = vi.fn<() => void>();
    const destroySecond = vi.fn<() => void>();
    const cache = new ByteBudgetCache(100);

    cache.register("first", 80, destroyFirst);
    cache.endFrame();
    expect(cache.getStats().residentBytes).toBe(80);

    cache.register("second", 80, destroySecond);
    cache.endFrame();

    expect(destroyFirst).toHaveBeenCalledOnce();
    expect(destroySecond).not.toHaveBeenCalled();
    expect(cache.getStats()).toEqual({
      budgetBytes: 100,
      residentBytes: 80,
      entryCount: 1,
      evictions: 1,
    });
  });

  test("destroys every tracked entry during teardown", () => {
    const destroy = vi.fn<() => void>();
    const cache = new ByteBudgetCache(100);
    cache.register("entry", 80, destroy);

    cache.destroy();

    expect(destroy).toHaveBeenCalledOnce();
    expect(cache.getStats()).toMatchObject({ residentBytes: 0, entryCount: 0 });
  });
});
