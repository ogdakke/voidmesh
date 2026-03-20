import type { ColorPalette } from "#types/canvas.ts";
import { describe, expect, test } from "vitest";
import {
  buildPaletteList,
  findPaletteById,
  generatePaletteId,
  generatePaletteName,
  isExtractedPalette,
  isUserPalette,
} from "./palette-presets.ts";

describe("palette-presets utilities", () => {
  describe("isUserPalette", () => {
    test("returns true for custom palette IDs (new format)", () => {
      expect(isUserPalette("cstm_a1b2c3d")).toBe(true);
      expect(isUserPalette("cstm_xyz789a")).toBe(true);
    });

    test("returns true for extracted palette IDs (new format)", () => {
      expect(isUserPalette("ext_a1b2c3d")).toBe(true);
      expect(isUserPalette("ext_xyz789a")).toBe(true);
    });

    test("returns false for preset IDs", () => {
      expect(isUserPalette("blackAndWhite")).toBe(false);
      expect(isUserPalette("gameboy")).toBe(false);
      expect(isUserPalette("grayscale4")).toBe(false);
    });

    test("returns false for the temp 'custom' ID", () => {
      expect(isUserPalette("custom")).toBe(false);
    });

    test("returns false for null/undefined", () => {
      expect(isUserPalette(null)).toBe(false);
      expect(isUserPalette(undefined)).toBe(false);
    });

    test("returns false for empty string", () => {
      expect(isUserPalette("")).toBe(false);
    });
  });

  describe("isExtractedPalette", () => {
    test("returns true for extracted palette IDs", () => {
      expect(isExtractedPalette("ext_a1b2c3d")).toBe(true);
      expect(isExtractedPalette("ext_xyz789a")).toBe(true);
    });

    test("returns false for custom palette IDs", () => {
      expect(isExtractedPalette("cstm_a1b2c3d")).toBe(false);
    });

    test("returns false for preset IDs", () => {
      expect(isExtractedPalette("blackAndWhite")).toBe(false);
    });

    test("returns false for null/undefined", () => {
      expect(isExtractedPalette(null)).toBe(false);
      expect(isExtractedPalette(undefined)).toBe(false);
    });
  });

  describe("generatePaletteId", () => {
    test("generates custom IDs with cstm_ prefix", () => {
      const id = generatePaletteId("custom");
      expect(id).toMatch(/^cstm_/);
      expect(isUserPalette(id)).toBe(true);
    });

    test("generates extracted IDs with ext_ prefix", () => {
      const id = generatePaletteId("extracted");
      expect(id).toMatch(/^ext_/);
      expect(isUserPalette(id)).toBe(true);
      expect(isExtractedPalette(id)).toBe(true);
    });

    test("generates unique IDs on consecutive calls", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        ids.add(generatePaletteId("custom"));
      }
      // Most IDs should be unique (random component ensures this)
      expect(ids.size).toBeGreaterThan(5);
    });

    test("generates short IDs (under 15 characters)", () => {
      const id = generatePaletteId("custom");
      expect(id.length).toBeLessThan(15);
    });
  });

  describe("generatePaletteName", () => {
    test("generates 'Custom 1' for empty list", () => {
      expect(generatePaletteName("custom", [])).toBe("Custom 1");
    });

    test("generates sequential custom names", () => {
      const palettes: ColorPalette[] = [{ name: "Custom 1", shortName: "Custom 1", colors: [] }];
      expect(generatePaletteName("custom", palettes)).toBe("Custom 2");
    });

    test("generates 'Extracted 1' for empty list", () => {
      expect(generatePaletteName("extracted", [])).toBe("Extracted 1");
    });

    test("generates sequential extracted names", () => {
      const palettes: ColorPalette[] = [
        { name: "Extracted 1", shortName: "Extracted 1", colors: [] },
        { name: "Extracted 2", shortName: "Extracted 2", colors: [] },
      ];
      expect(generatePaletteName("extracted", palettes)).toBe("Extracted 3");
    });

    test("ignores palettes with different prefix", () => {
      const palettes: ColorPalette[] = [
        { name: "Extracted 1", shortName: "Extracted 1", colors: [] },
        { name: "Custom 1", shortName: "Custom 1", colors: [] },
      ];
      expect(generatePaletteName("custom", palettes)).toBe("Custom 2");
      expect(generatePaletteName("extracted", palettes)).toBe("Extracted 2");
    });
  });

  describe("buildPaletteList", () => {
    const customPalette: ColorPalette = {
      id: "cstm_abc123",
      name: "My Custom",
      shortName: "My Custom",
      colors: [[1, 0, 0, 1]],
    };

    const extractedPalette: ColorPalette = {
      id: "ext_xyz789",
      name: "Extracted 1",
      shortName: "Extracted 1",
      colors: [[0, 0, 1, 1]],
    };

    const originalPalette: ColorPalette = {
      id: "original",
      name: "Original",
      shortName: "Original",
      colors: [[0, 1, 0, 1]],
    };

    test("returns presets when no custom/original palettes", () => {
      const list = buildPaletteList();
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((item) => item.type === "preset")).toBe(true);
    });

    test("includes all static presets", () => {
      const list = buildPaletteList();
      const ids = list.map((item) => item.id);
      expect(ids).toContain("blackAndWhite");
      expect(ids).toContain("gameboy");
    });

    test("puts custom palettes first", () => {
      const list = buildPaletteList([customPalette]);
      expect(list[0]!.id).toBe("cstm_abc123");
      expect(list[0]!.type).toBe("custom");
    });

    test("identifies extracted palettes correctly", () => {
      const list = buildPaletteList([extractedPalette]);
      expect(list[0]!.id).toBe("ext_xyz789");
      expect(list[0]!.type).toBe("extracted");
    });

    test("puts original palette last", () => {
      const list = buildPaletteList([], originalPalette);
      const last = list[list.length - 1]!;
      expect(last.type).toBe("original");
    });

    test("includes original palette when provided", () => {
      const list = buildPaletteList([], originalPalette);
      const originals = list.filter((item) => item.type === "original");
      expect(originals).toHaveLength(1);
    });

    test("maintains correct order: custom, presets, original", () => {
      const list = buildPaletteList([customPalette], originalPalette);
      const types = list.map((item) => item.type);
      const customIdx = types.indexOf("custom");
      const presetIdx = types.indexOf("preset");
      const originalIdx = types.lastIndexOf("original");

      expect(customIdx).toBeLessThan(presetIdx);
      expect(presetIdx).toBeLessThan(originalIdx);
    });

    test("all items have required properties", () => {
      const list = buildPaletteList([customPalette], originalPalette);
      for (const item of list) {
        expect(item.id).toBeDefined();
        expect(typeof item.id).toBe("string");
        expect(item.palette).toBeDefined();
        expect(item.palette.colors).toBeDefined();
        expect(["custom", "extracted", "preset", "original"]).toContain(item.type);
      }
    });
  });

  describe("findPaletteById", () => {
    test("finds palette by ID", () => {
      const list = buildPaletteList();
      const first = list[0]!;
      const found = findPaletteById(list, first.id);
      expect(found).toBe(first);
    });

    test("finds custom palette by ID", () => {
      const customPalette: ColorPalette = {
        id: "cstm_test123",
        name: "Test Custom",
        shortName: "TC",
        colors: [[1, 1, 0, 1]],
      };
      const list = buildPaletteList([customPalette]);
      const found = findPaletteById(list, "cstm_test123");
      expect(found?.palette).toBe(customPalette);
    });

    test("returns undefined for unknown ID", () => {
      const list = buildPaletteList();
      expect(findPaletteById(list, "unknown-id")).toBeUndefined();
    });

    test("returns undefined for null", () => {
      const list = buildPaletteList();
      expect(findPaletteById(list, null)).toBeUndefined();
    });

    test("returns undefined for undefined", () => {
      const list = buildPaletteList();
      expect(findPaletteById(list, undefined)).toBeUndefined();
    });

    test("returns undefined for empty string", () => {
      const list = buildPaletteList();
      expect(findPaletteById(list, "")).toBeUndefined();
    });
  });
});
