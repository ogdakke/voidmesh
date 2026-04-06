import {
  createDefaultWlurOverlayConfig,
  resolveWlurOverlayRuntimeConfig,
} from "#renderer/wlur-overlay.ts";
import { describe, expect, test } from "vitest";

describe("wlur overlay config", () => {
  test("scales the mobile preset against the visible viewport height", () => {
    const fullHeight = resolveWlurOverlayRuntimeConfig(
      createDefaultWlurOverlayConfig({
        isMobile: true,
        tintColor: [1, 1, 1],
      }),
      1000,
      1,
    );
    const occluded = resolveWlurOverlayRuntimeConfig(
      createDefaultWlurOverlayConfig({
        isMobile: true,
        bottomInsetCssPx: 200,
        tintColor: [1, 1, 1],
      }),
      1000,
      1,
    );

    expect(fullHeight).not.toBeNull();
    expect(occluded).not.toBeNull();
    expect(occluded!.params.offset).toBeLessThan(fullHeight!.params.offset);
    expect(occluded!.params.interpolation).toBeLessThan(fullHeight!.params.interpolation);
    expect(occluded?.params.direction).toBe(fullHeight?.params.direction);
    expect(occluded?.params.tint?.color).toEqual([1, 1, 1]);
    expect(occluded!.params.tint!.amount).toBeGreaterThanOrEqual(0);
    expect(occluded!.params.tint!.amount).toBeLessThanOrEqual(1);
  });

  test("creates a valid desktop default config without pinning tuneable constants", () => {
    const resolved = resolveWlurOverlayRuntimeConfig(createDefaultWlurOverlayConfig(), 1000, 1);

    expect(resolved).not.toBeNull();
    expect(resolved?.cache).toBe(true);
    expect(resolved!.params.radius).toBeGreaterThan(0);
    expect(resolved!.params.offset).toBeGreaterThanOrEqual(0);
    expect(resolved!.params.offset).toBeLessThanOrEqual(1);
    expect(resolved!.params.interpolation).toBeGreaterThanOrEqual(0);
    expect(resolved!.params.interpolation).toBeLessThanOrEqual(1);
    expect(resolved!.quality.kernelSize % 2).toBe(1);
    expect(resolved!.quality.resolutionScale).toBeGreaterThan(0);
    expect(resolved!.quality.resolutionScale).toBeLessThanOrEqual(1);
  });

  test("preserves tint color on mobile presets", () => {
    const resolved = resolveWlurOverlayRuntimeConfig(
      createDefaultWlurOverlayConfig({
        isMobile: true,
        tintColor: [1, 1, 1],
      }),
      1000,
      1,
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.params.tint?.color).toEqual([1, 1, 1]);
  });

  test("preserves explicit overrides after the preset is resolved", () => {
    const resolved = resolveWlurOverlayRuntimeConfig(
      {
        ...createDefaultWlurOverlayConfig({ isMobile: true, bottomInsetCssPx: 100 }),
        params: {
          radius: 16,
          offset: 0.2,
        },
        quality: {
          kernelSize: 48,
        },
      },
      1000,
      2,
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.params.radius).toBe(16);
    expect(resolved?.params.offset).toBe(0.2);
    expect(resolved?.quality.kernelSize).toBe(49);
  });

  test("returns null when the overlay is disabled", () => {
    expect(
      resolveWlurOverlayRuntimeConfig(
        {
          enabled: false,
        },
        1000,
        1,
      ),
    ).toBeNull();
  });
});
