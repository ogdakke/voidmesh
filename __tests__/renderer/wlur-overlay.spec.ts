import {
  createDefaultWlurOverlayConfig,
  resolveWlurOverlayRuntimeConfig,
} from "#renderer/wlur-overlay.ts";
import { describe, expect, test } from "vitest";

describe("wlur overlay config", () => {
  test("resolves the mobile preset against the visible viewport height", () => {
    const config = createDefaultWlurOverlayConfig({
      isMobile: true,
      bottomInsetCssPx: 200,
      tintColor: [1, 1, 1],
    });

    const resolved = resolveWlurOverlayRuntimeConfig(config, 1000, 1);
    expect(resolved).not.toBeNull();
    expect(resolved?.params.offset).toBeCloseTo(0.6);
    expect(resolved?.params.interpolation).toBeCloseTo(0.4);
    expect(resolved?.params.direction).toBe("down");
    expect(resolved?.params.tint).toEqual({
      color: [1, 1, 1],
      amount: 0.18,
    });
    expect(resolved?.quality.resolutionScale).toBe(0.5);
  });

  test("uses the desktop preset when no mobile layout is provided", () => {
    const resolved = resolveWlurOverlayRuntimeConfig(createDefaultWlurOverlayConfig(), 1000, 1);

    expect(resolved).not.toBeNull();
    expect(resolved?.params.offset).toBeCloseTo(0.9);
    expect(resolved?.params.interpolation).toBeCloseTo(0.1);
    expect(resolved?.quality.resolutionScale).toBe(0.75);
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
