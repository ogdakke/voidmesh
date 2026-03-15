import { describe, expect, test } from "vite-plus/test";
import {
  ColorValueFormat,
  detectColorValueFormat,
  getAvailableColorValueFormats,
  normalizeColorValueForFormat,
} from "#components/ui/color-picker/color-value-formats.ts";

describe("color-value-formats", () => {
  test("returns only hex when P3 is unsupported", () => {
    expect(getAvailableColorValueFormats({ supportsP3: false }).map((format) => format.id)).toEqual(
      [ColorValueFormat.hex],
    );
  });

  test("returns P3 then hex when P3 is supported", () => {
    expect(getAvailableColorValueFormats({ supportsP3: true }).map((format) => format.id)).toEqual([
      ColorValueFormat.p3,
      ColorValueFormat.hex,
    ]);
  });

  test("detects hex and P3 syntax", () => {
    expect(detectColorValueFormat("#aabbcc", { supportsP3: true })).toBe(ColorValueFormat.hex);
    expect(detectColorValueFormat("color(display-p3 1 0.5 0 / 0.5)", { supportsP3: true })).toBe(
      ColorValueFormat.p3,
    );
  });

  test("treats bare hex as hex and normalizes it", () => {
    expect(detectColorValueFormat("abc123", { supportsP3: true })).toBe(ColorValueFormat.hex);
    expect(normalizeColorValueForFormat("abc123", ColorValueFormat.hex)).toBe("#abc123");
  });

  test("returns null for invalid input", () => {
    expect(detectColorValueFormat("rgb(255 0 0)", { supportsP3: true })).toBeNull();
    expect(normalizeColorValueForFormat("nope", ColorValueFormat.hex)).toBeNull();
    expect(normalizeColorValueForFormat("nope", ColorValueFormat.p3)).toBeNull();
  });
});
