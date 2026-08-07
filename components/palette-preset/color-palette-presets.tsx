import { Select as BaseSelect } from "@base-ui/react";
import { Check } from "iconoir-react";
import type { ColorPalette } from "#types/canvas.ts";
import "../ui/form/form.css";
import { Select } from "../ui/select/select.tsx";
import { optionsWithNull } from "../ui/ui-util.ts";
import { PaletteSwatches } from "./palette-preset.tsx";
import "./palette-preset.css";
import {
  buildPaletteList,
  findPaletteById,
  type PaletteListItem,
} from "#application/canvas/palettes.ts";

interface ColorPalettePresetsProps {
  /** ID of the currently selected palette preset */
  selectedPaletteId: string | null;
  /** Callback when a preset is selected */
  onSelectPalette: (palette: ColorPalette) => void;
  /** Original palette extracted from the current entity's image (if any) */
  originalPalette?: ColorPalette;
  /** User-created palettes (custom + extracted from uploads) */
  customPalettes?: ColorPalette[];
  /** Whether multiple entities have different palettes */
  isMixed?: boolean;
}

export function ColorPalettePresets({
  selectedPaletteId,
  onSelectPalette,
  originalPalette,
  customPalettes = [],
  isMixed = false,
}: ColorPalettePresetsProps) {
  // Build combined palette list using centralized function
  const paletteList = buildPaletteList(customPalettes, originalPalette);
  const groupedPaletteList = Object.groupBy(paletteList, (p) => p.type);
  const customPaletteList = groupedPaletteList.custom;
  const restPalettes = [
    ...(groupedPaletteList.extracted ?? []),
    ...(groupedPaletteList.original ?? []),
    ...(groupedPaletteList.preset ?? []),
  ];

  // Handler to convert value back to palette object
  const handleValueChange = (value: string | null) => {
    const item = findPaletteById(paletteList, value);
    if (item) {
      onSelectPalette(item.palette);
    }
  };

  const SelectItem = (item: PaletteListItem) => (
    <BaseSelect.Item key={item.id} value={item.id} className="select-item">
      <BaseSelect.ItemIndicator className="select-item_indicator">
        <Check className="select-item_indicator_icon" />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText className="select-item_text">
        <span className="select-item_label">{item.palette.name}</span>
        <span className="select-item_description">
          <PaletteSwatches colors={item.palette.colors} />
        </span>
      </BaseSelect.ItemText>
    </BaseSelect.Item>
  );

  return (
    <Select
      label="Palette Presets"
      value={selectedPaletteId ?? undefined}
      onValueChange={handleValueChange}
      name="palette-preset"
      items={optionsWithNull({
        options: paletteList.map((item) => ({ label: item.palette.name, value: item.id })),
        nullLabel: "Select Palette",
      })}
      formatValue={isMixed ? <span className="select-mixed">Mixed</span> : undefined}
    >
      {!!customPaletteList?.length && (
        <BaseSelect.Group>
          <BaseSelect.GroupLabel className="select-group-label">
            Custom Palettes
          </BaseSelect.GroupLabel>
          {customPaletteList.map((item) => SelectItem(item))}
        </BaseSelect.Group>
      )}
      <BaseSelect.Group>
        <BaseSelect.GroupLabel className="select-group-label">Palettes</BaseSelect.GroupLabel>
        {restPalettes.map((item) => SelectItem(item))}
      </BaseSelect.Group>
    </Select>
  );
}
