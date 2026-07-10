import { describe, expect, test } from "vitest";
import { getEntityRenderSize, shouldUseLiveVideo } from "#renderer/entity-render-size.ts";
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

  test("freezes video previews that are too small to show meaningful motion", () => {
    const entity = createTestEntity({ mediaType: "video", size: { width: 420, height: 236 } });
    const viewport = { offset: { x: 0, y: 0 }, zoom: 0.14 };

    expect(shouldUseLiveVideo(entity, viewport, 1)).toBe(false);
    expect(shouldUseLiveVideo(entity, { ...viewport, zoom: 1 }, 1)).toBe(true);
  });
});
