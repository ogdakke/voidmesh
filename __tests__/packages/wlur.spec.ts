import {
  clampWlurParams,
  clampWlurQuality,
  getWlurScratchKey,
  getWlurWorkingDimensions,
  mapWlurFactorAtPoint,
} from "#wlur";
import { describe, expect, test } from "vitest";

describe("wlur helpers", () => {
  test("maps downward blur like Glur", () => {
    const params = {
      direction: "down" as const,
      offset: 0.75,
      interpolation: 0.25,
    };

    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.5 }, params)).toBe(0);
    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.875 }, params)).toBeCloseTo(0.5);
    expect(mapWlurFactorAtPoint({ x: 0.5, y: 1 }, params)).toBe(1);
  });

  test("maps upward and leftward blur using the upstream Glur formula", () => {
    const up = {
      direction: "up" as const,
      offset: 0.3,
      interpolation: 0.4,
    };
    const left = {
      direction: "left" as const,
      offset: 0.3,
      interpolation: 0.4,
    };

    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.3 }, up)).toBeCloseTo(0.5);
    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.1 }, up)).toBe(1);
    expect(mapWlurFactorAtPoint({ x: 0.5, y: 0.5 }, up)).toBe(0);
    expect(mapWlurFactorAtPoint({ x: 0.1, y: 0.5 }, left)).toBe(1);
    expect(mapWlurFactorAtPoint({ x: 0.3, y: 0.5 }, left)).toBeCloseTo(0.5);
  });

  test("clamps invalid params", () => {
    expect(
      clampWlurParams({
        radius: -1,
        offset: 4,
        interpolation: -3,
        noise: -2,
      }),
    ).toEqual({
      radius: 0,
      offset: 1,
      interpolation: 0,
      direction: "down",
      noise: 0,
    });
  });

  test("clamps tint color and amount", () => {
    expect(
      clampWlurParams({
        tint: {
          color: [-1, 0.5, 4],
          amount: -3,
        },
      }),
    ).toMatchObject({
      tint: {
        color: [0, 0.5, 1],
        amount: 0,
      },
    });
  });

  test("normalizes quality", () => {
    expect(clampWlurQuality({ kernelSize: 48, resolutionScale: 10 })).toEqual({
      kernelSize: 49,
      resolutionScale: 1,
    });
  });

  test("returns working dimensions and cache key for scaled passes", () => {
    expect(getWlurWorkingDimensions(1200, 800, 0.5)).toEqual({
      width: 600,
      height: 400,
      scale: 0.5,
    });
    expect(getWlurScratchKey(1200, 800, 0.5)).toBe("1200x800-600x400");
  });
});
