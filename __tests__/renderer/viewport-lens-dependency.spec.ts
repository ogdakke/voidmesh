import { describe, expect, test } from "vitest";
import { getViewportLensSourceDependencyRegion } from "#renderer/viewport-lens-dependency.ts";
import type { ViewportLensDistortionConfig } from "#types/canvas.ts";

const SUBTLE_LENS = {
  enabled: true,
  strength: 0.4,
  radius: 0.07,
  falloff: 1.8,
  dispersion: 0.25,
  scale: 1,
  reflectionIntensity: 0.23,
  reflectionFocus: 0.87,
  occlusion: 0.04,
  vignetteLight: 0.16,
  vignetteDark: 0.32,
} satisfies ViewportLensDistortionConfig;

describe("viewport lens source dependencies", () => {
  test("preserves the output region when lensing is disabled", () => {
    const region = { x: 0, y: 1436, width: 1179, height: 1120 };

    expect(
      getViewportLensSourceDependencyRegion(
        region,
        1179,
        2556,
        { ...SUBTLE_LENS, enabled: false },
        { x: 0, y: 0, width: 0, height: 0 },
      ),
    ).toEqual(region);
  });

  test("tightly maps the mobile Wlur band through subtle lens samples", () => {
    expect(
      getViewportLensSourceDependencyRegion(
        { x: 0, y: 1436, width: 1179, height: 1120 },
        1179,
        2556,
        SUBTLE_LENS,
        { x: 0, y: 0, width: 0, height: 0 },
      ),
    ).toEqual({ x: 0, y: 1397, width: 1179, height: 1126 });
  });
});
