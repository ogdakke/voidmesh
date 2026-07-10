import { describe, expect, test } from "vitest";
import { getBloomMipLevelCount } from "#renderer/processing-pipeline.ts";

describe("screen-space processing LOD", () => {
  test.each([
    [64, 64, 2],
    [128, 72, 2],
    [256, 144, 3],
    [512, 288, 4],
    [1024, 576, 5],
  ])("uses %i×%i bloom dimensions with %i levels", (width, height, levels) => {
    expect(getBloomMipLevelCount(width, height)).toBe(levels);
  });
});
