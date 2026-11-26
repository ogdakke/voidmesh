import { afterEach, describe, expect, test, vi } from "vitest";
import { config } from "#config";
import { getGpuMemoryBudget, isMemoryConstrainedDevice } from "#renderer/gpu-memory-budget.ts";

describe("GPU memory budget", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("gives a constrained device smaller cache budgets", () => {
    expect(getGpuMemoryBudget(false)).toEqual({
      entityTextureBytes: config.rendering.entityTextureBudgetBytes,
      texturePoolBytes: config.rendering.texturePoolBudgetBytes,
      previewMaxSide: Infinity,
    });
    const constrained = getGpuMemoryBudget(true);
    expect(constrained.entityTextureBytes).toBeLessThan(config.rendering.entityTextureBudgetBytes);
    expect(constrained.texturePoolBytes).toBeLessThan(config.rendering.texturePoolBudgetBytes);
    expect(constrained.previewMaxSide).toBe(config.rendering.constrainedPreviewMaxSide);
  });

  test("recognises iOS WebKit and low reported device memory", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    expect(isMemoryConstrainedDevice()).toBe(false);

    vi.stubGlobal("navigator", { deviceMemory: 4 });
    expect(isMemoryConstrainedDevice()).toBe(true);
    vi.stubGlobal("navigator", { deviceMemory: 8 });
    expect(isMemoryConstrainedDevice()).toBe(false);

    vi.stubGlobal("window", { ongesturechange: null });
    expect(isMemoryConstrainedDevice()).toBe(true);
  });
});
