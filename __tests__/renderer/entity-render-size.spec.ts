import { describe, expect, test } from "vitest";
import {
  getContinuousOutputSize,
  getEntityRenderPixelScale,
  getEntityRenderSize,
} from "#renderer/entity-render-size.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("getEntityRenderSize", () => {
  test("selects a quantized tier from projected physical size", () => {
    const entity = createTestEntity({ size: { width: 100, height: 75 } });
    entity.originalSize = { width: 1600, height: 1200 };

    expect(getEntityRenderSize(entity, { offset: { x: 0, y: 0 }, zoom: 0.5 }, 2)).toEqual({
      width: 128,
      height: 96,
    });
  });

  test("keeps native resolution when projected near or above it", () => {
    const entity = createTestEntity({ size: { width: 1600, height: 1200 } });

    expect(getEntityRenderSize(entity, { offset: { x: 0, y: 0 }, zoom: 1 }, 1)).toEqual(
      entity.originalSize,
    );
  });

  test("applies projected output LOD to video entities", () => {
    const entity = createTestEntity({ mediaType: "video", size: { width: 320, height: 180 } });
    entity.originalSize = { width: 1920, height: 1080 };

    expect(getEntityRenderSize(entity, { offset: { x: 0, y: 0 }, zoom: 0.25 }, 1)).toEqual({
      width: 128,
      height: 72,
    });
  });

  test("reports the authored-pixel scale for a quantized render size", () => {
    const entity = createTestEntity();
    entity.originalSize = { width: 2048, height: 1536 };

    expect(getEntityRenderPixelScale(entity, 256, 192)).toBe(0.125);
  });
});

describe("getContinuousOutputSize", () => {
  const at = (zoom: number) => ({ offset: { x: 0, y: 0 }, zoom });

  test("follows the projection in steps, without the tier's zoom margin", () => {
    const entity = createTestEntity({ size: { width: 282, height: 282 } });
    entity.originalSize = { width: 1024, height: 1024 };

    // 564 device pixels: steps of 64 (an eighth of 512) give 576, where the tier is 1024.
    expect(getContinuousOutputSize(entity, at(1), 2)).toEqual({ width: 576, height: 576 });
    expect(getEntityRenderSize(entity, at(1), 2)).toEqual({ width: 1024, height: 1024 });
    // Small projections move in 32 px steps.
    expect(getContinuousOutputSize(entity, at(0.25), 1)).toEqual({ width: 96, height: 96 });
  });

  test("keeps the media's aspect and never exceeds its size", () => {
    const entity = createTestEntity({ size: { width: 998, height: 562 } });
    entity.originalSize = { width: 3840, height: 2160 };

    expect(getContinuousOutputSize(entity, at(1), 1)).toEqual({ width: 1024, height: 576 });
    expect(getContinuousOutputSize(entity, at(3), 1)).toEqual({ width: 3072, height: 1728 });
    expect(getContinuousOutputSize(entity, at(8), 1)).toEqual({ width: 3840, height: 2160 });
  });

  test("holds one size across a small zoom", () => {
    const entity = createTestEntity({ size: { width: 1000, height: 1000 } });
    entity.originalSize = { width: 4096, height: 4096 };

    expect(getContinuousOutputSize(entity, at(1.05), 1)).toEqual(
      getContinuousOutputSize(entity, at(1.12), 1),
    );
  });
});
