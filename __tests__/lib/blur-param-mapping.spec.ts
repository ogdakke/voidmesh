import { blurParamToKawaseParams, MAX_BLUR_MIP_LEVELS } from "#config";
import { describe, expect, test } from "vitest";

describe("blurParamToKawaseParams", () => {
  test("returns 0 levels for blur value 0", () => {
    const result = blurParamToKawaseParams(0);
    expect(result.levelsLow).toBe(0);
    expect(result.levelsHigh).toBe(0);
    expect(result.blendFactor).toBe(0);
  });

  test("returns 0 levels for very small blur values", () => {
    const result = blurParamToKawaseParams(0.0001);
    expect(result.levelsLow).toBe(0);
  });

  test("returns 1 level for small blur values", () => {
    const result = blurParamToKawaseParams(0.1);
    expect(result.levelsLow).toBe(1);
    expect(result.offsetLow).toBeGreaterThanOrEqual(0);
    expect(result.offsetLow).toBeLessThanOrEqual(0.5);
  });

  test("levelsLow increases monotonically with blur value", () => {
    const values = [1, 4, 10, 20, 30, 42, 54];
    let prevLevels = 0;
    for (const v of values) {
      const { levelsLow } = blurParamToKawaseParams(v);
      expect(levelsLow).toBeGreaterThanOrEqual(prevLevels);
      prevLevels = levelsLow;
    }
  });

  test("maximum blur value uses high level count", () => {
    const result = blurParamToKawaseParams(60);
    expect(result.levelsLow).toBeLessThanOrEqual(MAX_BLUR_MIP_LEVELS);
    expect(result.levelsLow).toBeGreaterThanOrEqual(7);
  });

  test("offsets are within valid range for all values", () => {
    for (let v = 0.1; v <= 60; v += 1) {
      const { offsetLow, offsetHigh } = blurParamToKawaseParams(v);
      expect(offsetLow).toBeGreaterThanOrEqual(0);
      expect(offsetLow).toBeLessThanOrEqual(0.5);
      expect(offsetHigh).toBeGreaterThanOrEqual(0);
      expect(offsetHigh).toBeLessThanOrEqual(0.5);
    }
  });

  test("blendFactor is within 0-1 range for all values", () => {
    for (let v = 0.1; v <= 60; v += 0.5) {
      const { blendFactor } = blurParamToKawaseParams(v);
      expect(blendFactor).toBeGreaterThanOrEqual(0);
      expect(blendFactor).toBeLessThanOrEqual(1);
    }
  });

  test("levelsHigh - levelsLow is always 0 or 1", () => {
    for (let v = 0.1; v <= 60; v += 0.5) {
      const { levelsLow, levelsHigh } = blurParamToKawaseParams(v);
      const diff = levelsHigh - levelsLow;
      expect(diff).toBeGreaterThanOrEqual(0);
      expect(diff).toBeLessThanOrEqual(1);
    }
  });

  test("no level jumps greater than 1 between adjacent slider steps", () => {
    let prev = blurParamToKawaseParams(0.1);
    for (let v = 0.2; v <= 60; v += 0.1) {
      const curr = blurParamToKawaseParams(v);
      expect(curr.levelsLow - prev.levelsLow).toBeLessThanOrEqual(1);
      expect(curr.levelsHigh - prev.levelsHigh).toBeLessThanOrEqual(1);
      prev = curr;
    }
  });

  test("blend zone activates near breakpoint boundaries", () => {
    // Near the boundary between segments (e.g., just before value 2.0)
    const nearBoundary = blurParamToKawaseParams(1.9);
    expect(nearBoundary.blendFactor).toBeGreaterThan(0);
    expect(nearBoundary.levelsHigh).toBe(nearBoundary.levelsLow + 1);
  });

  test("no blending in the middle of a segment", () => {
    // Middle of the 6-14 segment (level 4)
    const mid = blurParamToKawaseParams(9);
    expect(mid.blendFactor).toBe(0);
    expect(mid.levelsLow).toBe(mid.levelsHigh);
  });

  test("continuity at breakpoint transitions", () => {
    const breakpoints = [0.3, 2, 6, 14, 24, 36, 48];
    for (const bp of breakpoints) {
      const before = blurParamToKawaseParams(bp - 0.001);
      const after = blurParamToKawaseParams(bp + 0.001);

      if (before.blendFactor > 0.5) {
        expect(before.levelsHigh).toBe(after.levelsLow);
      }
    }
  });
});
