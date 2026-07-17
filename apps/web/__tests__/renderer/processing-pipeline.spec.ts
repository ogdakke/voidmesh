import { describe, expect, test } from "vitest";
import { ProcessingPipeline } from "#renderer/processing-pipeline.ts";
import type { EffectRenderEntity } from "#renderer/effect-render-entity.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("ProcessingPipeline LOD parameters", () => {
  test("skips blur when its scaled radius is below one render-texture subpixel", () => {
    const pipeline = new ProcessingPipeline({} as GPUDevice, "rgba16float", false);
    const entity = createRenderEntity(1);
    const adjustments = entity.shaderParams.adjustments;
    if (!adjustments) throw new Error("Expected default adjustments");
    adjustments.blur = 0.002;

    expect(pipeline.needsBlur(entity)).toBe(true);

    entity.pixelScale = 0.25;
    expect(pipeline.needsBlur(entity)).toBe(false);
  });
});

function createRenderEntity(pixelScale: number): EffectRenderEntity {
  const entity = createTestEntity({ id: "lod-processing" });
  return {
    id: entity.id,
    originalSize: entity.originalSize,
    pixelScale,
    shaderType: entity.shaderType,
    shaderParams: entity.shaderParams,
  };
}
