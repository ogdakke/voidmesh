/**
 * Property-based tests for time-format utilities.
 *
 * Tests format consistency between formatMediaTime and formatMediaTimeParts,
 * monotonicity, and edge case handling.
 */
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { formatMediaTime, formatMediaTimeParts } from "#lib/time-format.ts";

// ── Arbitraries ─────────────────────────────────────────────────────

/** Non-negative finite seconds */
const validSeconds = () => fc.double({ min: 0, max: 100_000, noNaN: true });

/** Invalid time values */
const invalidSeconds = () =>
  fc.oneof(
    fc.constant(NaN),
    fc.constant(Infinity),
    fc.constant(-Infinity),
    fc.double({ min: -100_000, max: -0.01, noNaN: true }),
  );

// ── Properties ──────────────────────────────────────────────────────

describe("formatMediaTime (property-based)", () => {
  test("parts concatenation matches formatMediaTime", () => {
    fc.assert(
      fc.property(validSeconds(), (seconds) => {
        const formatted = formatMediaTime(seconds);
        const parts = formatMediaTimeParts(seconds);
        const reconstructed = `${parts.main}:${parts.ms}`;
        expect(reconstructed).toBe(formatted);
      }),
    );
  });

  test("invalid inputs always produce '0:00'", () => {
    fc.assert(
      fc.property(invalidSeconds(), (seconds) => {
        expect(formatMediaTime(seconds)).toBe("0:00");
      }),
    );
  });

  test("invalid inputs always produce { main: '0', ms: '00' }", () => {
    fc.assert(
      fc.property(invalidSeconds(), (seconds) => {
        expect(formatMediaTimeParts(seconds)).toEqual({ main: "0", ms: "00" });
      }),
    );
  });

  test("centiseconds part is always exactly 2 digits", () => {
    fc.assert(
      fc.property(validSeconds(), (seconds) => {
        const parts = formatMediaTimeParts(seconds);
        expect(parts.ms).toMatch(/^\d{2}$/);
      }),
    );
  });

  test("output matches expected format pattern", () => {
    fc.assert(
      fc.property(validSeconds(), (seconds) => {
        const formatted = formatMediaTime(seconds);
        // Either "SS:ms" or "M:SS:ms"
        expect(formatted).toMatch(/^\d+:\d{2}(:\d{2})?$/);
      }),
    );
  });

  test("monotonicity: larger input produces >= total centiseconds", () => {
    fc.assert(
      fc.property(validSeconds(), validSeconds(), (a, b) => {
        if (a > b) {
          const partsA = formatMediaTimeParts(a);
          const partsB = formatMediaTimeParts(b);
          const totalA = parseTotalCentiseconds(partsA.main, partsA.ms);
          const totalB = parseTotalCentiseconds(partsB.main, partsB.ms);
          expect(totalA).toBeGreaterThanOrEqual(totalB);
        }
      }),
    );
  });

  test("seconds >= 60 use M:SS format in main part", () => {
    fc.assert(
      fc.property(fc.double({ min: 60, max: 100_000, noNaN: true }), (seconds) => {
        const parts = formatMediaTimeParts(seconds);
        // Main part should contain a colon (M:SS format)
        expect(parts.main).toMatch(/^\d+:\d{2}$/);
      }),
    );
  });

  test("seconds < 60 use plain seconds in main part", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 59.994, noNaN: true }), (seconds) => {
        const parts = formatMediaTimeParts(seconds);
        // Main part should be just digits (no colon)
        expect(parts.main).toMatch(/^\d+$/);
      }),
    );
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

function parseTotalCentiseconds(main: string, ms: string): number {
  const csMs = parseInt(ms, 10);
  const parts = main.split(":");
  if (parts.length === 1) {
    // SS format
    return parseInt(parts[0]!, 10) * 100 + csMs;
  }
  // M:SS format
  const minutes = parseInt(parts[0]!, 10);
  const secs = parseInt(parts[1]!, 10);
  return (minutes * 60 + secs) * 100 + csMs;
}
