import { config } from "#config";
import type { ColorPalette } from "#types/canvas.ts";

export function getPalettePreset(id: string): ColorPalette | undefined {
  return config.palettes[id as keyof typeof config.palettes];
}

export function getPresetIds(): string[] {
  return Object.keys(config.palettes);
}

export function isAsyncPalette(presetId: string | null | undefined): boolean {
  return presetId != null && config.asyncPalettes.includes(presetId as never);
}

export function isUserPalette(paletteId: string | null | undefined): boolean {
  if (!paletteId) return false;
  const { custom, extracted } = config.paletteIdPrefix;
  return paletteId.startsWith(custom) || paletteId.startsWith(extracted);
}

export function isExtractedPalette(paletteId: string | null | undefined): boolean {
  return !!paletteId?.startsWith(config.paletteIdPrefix.extracted);
}

function generateShortHash(): string {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 0xffffff);
  return ((timestamp << 8) ^ random).toString(36).slice(-7);
}

export function generatePaletteId(type: "custom" | "extracted"): string {
  return `${config.paletteIdPrefix[type]}${generateShortHash()}`;
}

export function generatePaletteName(
  type: "custom" | "extracted",
  existingPalettes: ColorPalette[],
): string {
  const prefix = type === "custom" ? "Custom" : "Extracted";
  return `${prefix} ${existingPalettes.filter((palette) => palette.name.startsWith(prefix)).length + 1}`;
}

export function generatePaletteShortName(
  type: "custom" | "extracted",
  existingPalettes: ColorPalette[],
): string {
  const prefix = type === "custom" ? "Custom" : "Extr.";
  return `${prefix} ${existingPalettes.filter((palette) => palette.shortName.startsWith(prefix)).length + 1}`;
}

export interface PaletteListItem {
  id: string;
  palette: ColorPalette;
  type: "custom" | "extracted" | "preset" | "original";
}

export function buildPaletteList(
  customPalettes: ColorPalette[] = [],
  originalPalette?: ColorPalette,
): PaletteListItem[] {
  const items: PaletteListItem[] = customPalettes.map((palette) => ({
    id: palette.id!,
    palette,
    type: isExtractedPalette(palette.id) ? "extracted" : "custom",
  }));

  for (const preset of Object.values(config.palettes)) {
    items.push({ id: preset.id!, palette: preset, type: "preset" });
  }
  if (originalPalette) {
    items.push({ id: config.asyncPalettes[0], palette: originalPalette, type: "original" });
  }
  return items;
}

export function findPaletteById(
  items: PaletteListItem[],
  id: string | null | undefined,
): PaletteListItem | undefined {
  return id ? items.find((item) => item.id === id) : undefined;
}
