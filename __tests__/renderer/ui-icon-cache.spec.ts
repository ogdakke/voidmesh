import { describe, expect, it } from "vitest";
import { getIconRasterSize, pickClosestIconRasterSize } from "#renderer/ui/ui-icon-cache.ts";

describe("getIconRasterSize", () => {
  it("reuses the same raster bucket for small zoom deltas", () => {
    expect(getIconRasterSize(24, 24, 10)).toEqual({ width: 368, height: 368 });
    expect(getIconRasterSize(24, 24, 10.2)).toEqual({ width: 368, height: 368 });
  });

  it("scales each axis independently for non-square icons", () => {
    expect(getIconRasterSize(12, 24, 10)).toEqual({ width: 192, height: 368 });
  });

  it("clamps oversized requests to the configured texture edge", () => {
    expect(getIconRasterSize(200, 200, 10)).toEqual({ width: 512, height: 512 });
  });
});

describe("pickClosestIconRasterSize", () => {
  it("prefers the nearest larger variant to avoid blur while resizing down", () => {
    expect(
      pickClosestIconRasterSize({ width: 256, height: 256 }, [
        { width: 240, height: 240 },
        { width: 272, height: 272 },
        { width: 320, height: 320 },
      ]),
    ).toEqual({ width: 272, height: 272 });
  });

  it("falls back to the nearest smaller variant when no larger one exists", () => {
    expect(
      pickClosestIconRasterSize({ width: 256, height: 256 }, [
        { width: 192, height: 192 },
        { width: 240, height: 240 },
      ]),
    ).toEqual({ width: 240, height: 240 });
  });
});
