/**
 * Property-based tests for Floyd-Steinberg dithering.
 *
 * Tests output invariants: all pixels snap to palette colors,
 * alpha is preserved, and dimensions are correct.
 */
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { floydSteinbergDither } from "#lib/floyd-steinberg.ts";

// ── Arbitraries ─────────────────────────────────────────────────────

/** A small image dimension (keep small for performance) */
const dimension = () => fc.integer({ min: 1, max: 16 });

/** A palette color [r, g, b] with values 0-255 */
const paletteColor = (): fc.Arbitrary<[number, number, number]> =>
  fc.tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  );

/** A palette of 2-8 colors */
const palette = () => fc.array(paletteColor(), { minLength: 2, maxLength: 8 });

/** Generate random RGBA pixel data for given dimensions */
const pixelData = (width: number, height: number) =>
  fc.uint8Array({ minLength: width * height * 4, maxLength: width * height * 4 });

// ── Properties ──────────────────────────────────────────────────────

describe("floydSteinbergDither (property-based)", () => {
  test("every pixel RGB matches a palette color after dithering", () => {
    fc.assert(
      fc.property(dimension(), dimension(), palette(), (width, height, pal) => {
        const data = new Uint8ClampedArray(width * height * 4);
        // Fill with random-ish data
        for (let i = 0; i < data.length; i++) {
          data[i] = Math.floor(Math.random() * 256);
        }

        floydSteinbergDither(data, width, height, pal);

        // Every pixel's RGB should match one of the palette colors
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const r = data[i]!;
            const g = data[i + 1]!;
            const b = data[i + 2]!;

            const matchesPalette = pal.some(([pr, pg, pb]) => pr === r && pg === g && pb === b);
            expect(matchesPalette).toBe(true);
          }
        }
      }),
      { numRuns: 50 }, // Fewer runs since dithering is O(width * height)
    );
  });

  test("alpha channel is preserved", () => {
    fc.assert(
      fc.property(dimension(), dimension(), palette(), (width, height, pal) => {
        const data = new Uint8ClampedArray(width * height * 4);
        const alphas: number[] = [];

        // Fill with data, recording alpha values
        for (let i = 0; i < width * height; i++) {
          data[i * 4] = Math.floor(Math.random() * 256);
          data[i * 4 + 1] = Math.floor(Math.random() * 256);
          data[i * 4 + 2] = Math.floor(Math.random() * 256);
          data[i * 4 + 3] = Math.floor(Math.random() * 256);
          alphas.push(data[i * 4 + 3]!);
        }

        floydSteinbergDither(data, width, height, pal);

        // Alpha channels should be unchanged
        for (let i = 0; i < width * height; i++) {
          expect(data[i * 4 + 3]).toBe(alphas[i]);
        }
      }),
      { numRuns: 50 },
    );
  });

  test("single-color palette snaps all pixels to that color", () => {
    fc.assert(
      fc.property(dimension(), dimension(), paletteColor(), (width, height, color) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < data.length; i++) {
          data[i] = Math.floor(Math.random() * 256);
        }

        // Use a single-color "palette" (wrap in array with duplicate to meet minLength)
        floydSteinbergDither(data, width, height, [color, color]);

        for (let i = 0; i < width * height; i++) {
          expect(data[i * 4]).toBe(color[0]);
          expect(data[i * 4 + 1]).toBe(color[1]);
          expect(data[i * 4 + 2]).toBe(color[2]);
        }
      }),
      { numRuns: 50 },
    );
  });

  test("data already matching palette is unchanged", () => {
    fc.assert(
      fc.property(dimension(), dimension(), palette(), (width, height, pal) => {
        const data = new Uint8ClampedArray(width * height * 4);

        // Fill each pixel with a random palette color
        for (let i = 0; i < width * height; i++) {
          const color = pal[Math.floor(Math.random() * pal.length)]!;
          data[i * 4] = color[0];
          data[i * 4 + 1] = color[1];
          data[i * 4 + 2] = color[2];
          data[i * 4 + 3] = 255;
        }

        const original = new Uint8ClampedArray(data);
        floydSteinbergDither(data, width, height, pal);

        // When input is already quantized, error is 0 → no change
        for (let i = 0; i < data.length; i++) {
          expect(data[i]).toBe(original[i]);
        }
      }),
      { numRuns: 50 },
    );
  });

  test("output pixel values are within valid byte range [0, 255]", () => {
    fc.assert(
      fc.property(dimension(), dimension(), palette(), (width, height, pal) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < data.length; i++) {
          data[i] = Math.floor(Math.random() * 256);
        }

        floydSteinbergDither(data, width, height, pal);

        for (let i = 0; i < data.length; i++) {
          expect(data[i]).toBeGreaterThanOrEqual(0);
          expect(data[i]).toBeLessThanOrEqual(255);
        }
      }),
      { numRuns: 50 },
    );
  });
});
