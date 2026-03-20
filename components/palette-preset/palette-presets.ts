import type { ColorPalette } from "#types/canvas.ts";
import { config } from "#lib/config/index.js";

/**
 * Get a palette preset by ID
 */
export function getPalettePreset(id: string): ColorPalette | undefined {
  return config.palettes[id as keyof typeof config.palettes];
}

/**
 * Get all preset IDs
 */
export function getPresetIds(): string[] {
  return Object.keys(config.palettes);
}

/**
 * Check if a preset ID refers to an async palette (extracted from entity)
 */
export function isAsyncPalette(presetId: string | null | undefined): boolean {
  return presetId != null && config.asyncPalettes.includes(presetId as any);
}

/**
 * Check if a palette is a user-created palette (custom or extracted from upload)
 */
export function isUserPalette(paletteId: string | null | undefined): boolean {
  if (!paletteId) return false;
  const { custom, extracted } = config.paletteIdPrefix;
  return paletteId.startsWith(custom) || paletteId.startsWith(extracted);
}

/**
 * Check if a palette ID is an extracted palette (from image upload)
 */
export function isExtractedPalette(paletteId: string | null | undefined): boolean {
  if (!paletteId) return false;
  return paletteId.startsWith(config.paletteIdPrefix.extracted);
}

/**
 * Generate a short hash from timestamp (7 characters, base36)
 */
function generateShortHash(): string {
  // Use timestamp + random component for uniqueness
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 0xffffff);
  // Combine and convert to base36, take last 7 chars
  return ((timestamp << 8) ^ random).toString(36).slice(-7);
}

/**
 * Generate a unique palette ID with short hash format
 * @example "cstm_a1b2c3d" or "ext_x7y8z9a"
 */
export function generatePaletteId(type: "custom" | "extracted"): string {
  const prefix = config.paletteIdPrefix[type];
  return `${prefix}${generateShortHash()}`;
}

/**
 * Generate next palette name based on type and existing palettes
 */
export function generatePaletteName(
  type: "custom" | "extracted",
  existingPalettes: ColorPalette[],
): string {
  const prefix = type === "custom" ? "Custom" : "Extracted";
  const existing = existingPalettes.filter((p) => p.name.startsWith(prefix));
  return `${prefix} ${existing.length + 1}`;
}

export function generatePaletteShortName(
  type: "custom" | "extracted",
  existingPalettes: ColorPalette[],
): string {
  const prefix = type === "custom" ? "Custom" : "Extr.";
  const existing = existingPalettes.filter((p) => p.shortName.startsWith(prefix));
  return `${prefix} ${existing.length + 1}`;
}

/** Palette list item with type information for UI rendering */
export interface PaletteListItem {
  id: string;
  palette: ColorPalette;
  /** Type of palette for styling/categorization */
  type: "custom" | "extracted" | "preset" | "original";
}

/**
 * Build the complete list of available palettes for selection UI.
 * Order: [User palettes...] [Presets...] [Original extracted from image]
 */
export function buildPaletteList(
  customPalettes: ColorPalette[] = [],
  originalPalette?: ColorPalette,
): PaletteListItem[] {
  const items: PaletteListItem[] = [];

  // 1. User-created palettes (custom + extracted from uploads)
  for (const palette of customPalettes) {
    items.push({
      id: palette.id!,
      palette,
      type: isExtractedPalette(palette.id) ? "extracted" : "custom",
    });
  }

  // 2. Static presets
  for (const preset of Object.values(config.palettes)) {
    items.push({
      id: preset.id!,
      palette: preset,
      type: "preset",
    });
  }

  // 3. Original palette extracted from source image
  if (originalPalette) {
    items.push({
      id: config.asyncPalettes[0],
      palette: originalPalette,
      type: "original",
    });
  }

  return items;
}

/**
 * Find a palette by ID from the palette list
 */
export function findPaletteById(
  items: PaletteListItem[],
  id: string | null | undefined,
): PaletteListItem | undefined {
  return id ? items.find((item) => item.id === id) : undefined;
}
