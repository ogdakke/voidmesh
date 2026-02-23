import { luminance, sortPaletteByLuminance } from "#lib/color-utils.ts";
import { describe, expect, test } from "vitest";

describe("luminance", () => {
  test("returns 0 for black", () => {
    expect(luminance(0, 0, 0)).toBe(0);
  });

  test("returns 1 for white", () => {
    expect(luminance(1, 1, 1)).toBeCloseTo(1, 5);
  });

  test("uses ITU-R BT.601 coefficients", () => {
    // Pure red: 0.299
    expect(luminance(1, 0, 0)).toBeCloseTo(0.299, 5);
    // Pure green: 0.587
    expect(luminance(0, 1, 0)).toBeCloseTo(0.587, 5);
    // Pure blue: 0.114
    expect(luminance(0, 0, 1)).toBeCloseTo(0.114, 5);
  });

  test("calculates mid-gray correctly", () => {
    // 50% gray should have ~0.5 luminance
    expect(luminance(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 5);
  });
});

describe("sortPaletteByLuminance", () => {
  test("returns empty array for empty input", () => {
    expect(sortPaletteByLuminance([])).toEqual([]);
  });

  test("returns single color unchanged", () => {
    const colors: [number, number, number, number][] = [[1, 0, 0, 1]];
    expect(sortPaletteByLuminance(colors)).toEqual([[1, 0, 0, 1]]);
  });

  test("sorts black and white correctly", () => {
    const colors: [number, number, number, number][] = [
      [1, 1, 1, 1], // white
      [0, 0, 0, 1], // black
    ];
    const sorted = sortPaletteByLuminance(colors);
    expect(sorted[0]).toEqual([0, 0, 0, 1]); // black first (darkest)
    expect(sorted[1]).toEqual([1, 1, 1, 1]); // white last (brightest)
  });

  test("sorts RGB colors by luminance", () => {
    const colors: [number, number, number, number][] = [
      [0, 1, 0, 1], // green - luminance 0.587
      [0, 0, 1, 1], // blue - luminance 0.114
      [1, 0, 0, 1], // red - luminance 0.299
    ];
    const sorted = sortPaletteByLuminance(colors);
    // Expected order: blue (0.114), red (0.299), green (0.587)
    expect(sorted[0]).toEqual([0, 0, 1, 1]); // blue (darkest)
    expect(sorted[1]).toEqual([1, 0, 0, 1]); // red
    expect(sorted[2]).toEqual([0, 1, 0, 1]); // green (brightest)
  });

  test("handles grayscale palette", () => {
    const colors: [number, number, number, number][] = [
      [0.5, 0.5, 0.5, 1], // 50% gray
      [0.25, 0.25, 0.25, 1], // 25% gray
      [0.75, 0.75, 0.75, 1], // 75% gray
      [0, 0, 0, 1], // black
      [1, 1, 1, 1], // white
    ];
    const sorted = sortPaletteByLuminance(colors);
    expect(sorted[0]).toEqual([0, 0, 0, 1]); // black
    expect(sorted[1]).toEqual([0.25, 0.25, 0.25, 1]); // 25% gray
    expect(sorted[2]).toEqual([0.5, 0.5, 0.5, 1]); // 50% gray
    expect(sorted[3]).toEqual([0.75, 0.75, 0.75, 1]); // 75% gray
    expect(sorted[4]).toEqual([1, 1, 1, 1]); // white
  });

  test("preserves alpha values", () => {
    const colors: [number, number, number, number][] = [
      [1, 1, 1, 0.5], // semi-transparent white
      [0, 0, 0, 0.8], // mostly opaque black
    ];
    const sorted = sortPaletteByLuminance(colors);
    expect(sorted[0]![3]).toBe(0.8); // black's alpha preserved
    expect(sorted[1]![3]).toBe(0.5); // white's alpha preserved
  });

  test("does not mutate original array", () => {
    const colors: [number, number, number, number][] = [
      [1, 1, 1, 1],
      [0, 0, 0, 1],
    ];
    const original = [...colors];
    sortPaletteByLuminance(colors);
    expect(colors).toEqual(original);
  });

  test("handles colors with similar luminance (stable sort)", () => {
    // Two colors with identical luminance should maintain relative order
    const colors: [number, number, number, number][] = [
      [0.5, 0.5, 0.5, 1], // gray A - inserted first
      [0.5, 0.5, 0.5, 0.9], // gray B - different alpha, same RGB
    ];
    const sorted = sortPaletteByLuminance(colors);
    // Should maintain original order since luminances are equal
    expect(sorted[0]![3]).toBe(1); // gray A first
    expect(sorted[1]![3]).toBe(0.9); // gray B second
  });

  test("correctly sorts a typical palette", () => {
    // Simulating a user-provided palette in random order
    const colors: [number, number, number, number][] = [
      [0.9, 0.8, 0.7, 1], // light beige
      [0.1, 0.1, 0.2, 1], // dark blue-gray
      [0.5, 0.3, 0.2, 1], // brown
      [0.95, 0.95, 0.9, 1], // cream (almost white)
    ];
    const sorted = sortPaletteByLuminance(colors);

    // Verify sorted by luminance
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      const lumPrev = luminance(prev[0], prev[1], prev[2]);
      const lumCurr = luminance(curr[0], curr[1], curr[2]);
      expect(lumCurr).toBeGreaterThanOrEqual(lumPrev);
    }
  });
});
