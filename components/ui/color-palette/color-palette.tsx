import { type ComponentProps } from "react";
import { ColorPicker } from "../color-picker/color-picker.tsx";
import { Button } from "../button/index.tsx";
import { Plus, Trash } from "iconoir-react";
import type { RGBA, ColorPalette as ColorPaletteType } from "#types/canvas.ts";
import { MAX_PALETTE_COLORS } from "#types/canvas.ts";
import { hexToNormalizedRGBA } from "#lib/color-utils.ts";
import { config } from "#config";
import { isUserPalette } from "#components/palette-preset/palette-presets.ts";
import { undo } from "#lib/undo.ts";
import clsx from "clsx";
import "./color-palette.css";
import "../form/form.css";

/**
 * Convert normalized RGBA [0-1] to 6-digit hex string with # prefix
 */
function rgbaToHex6(rgba: RGBA): string {
  const r = Math.round(rgba[0] * 255)
    .toString(16)
    .padStart(2, "0");
  const g = Math.round(rgba[1] * 255)
    .toString(16)
    .padStart(2, "0");
  const b = Math.round(rgba[2] * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${r}${g}${b}`;
}

interface ColorPaletteProps extends ComponentProps<"div"> {
  /** Current palette (controlled) */
  palette: ColorPaletteType | undefined;
  /** Callback when palette colors change */
  onValueChange: (palette: ColorPaletteType) => void;
  /** Callback to delete the entire palette (only for user-created palettes) */
  onDelete?: () => void;
  /** Whether the delete button should be shown (true for user-created palettes) */
  canDelete?: boolean;
}

/**
 * Color palette editor allows user to add, remove and update colors in a palette.
 * Minimum 2 colors, maximum 16 colors.
 */
export function ColorPalette({
  palette,
  onValueChange: onChange,
  onDelete,
  canDelete,
  ...props
}: ColorPaletteProps) {
  const colors = palette?.colors ?? [];
  const canRemove = colors.length > 2;
  const canAdd = colors.length < MAX_PALETTE_COLORS;

  const handleColorChange = (hex: string, index: number) => {
    const currentColors = palette?.colors ?? [];
    const newColors = [...currentColors];
    const rgba = hexToNormalizedRGBA(hex);
    // Preserve existing alpha from the palette color
    rgba[3] = currentColors[index]?.[3] ?? 1;
    newColors[index] = rgba;
    const preserveId = palette && isUserPalette(palette.id);
    onChange({
      ...palette,
      id: preserveId ? palette.id : config.customPaletteId,
      name: preserveId ? palette.name : "Custom",
      shortName: preserveId ? palette.shortName : "Custom",
      colors: newColors,
    });
  };

  const handleAddColor = () => {
    const currentColors = palette?.colors ?? [];
    if (currentColors.length >= MAX_PALETTE_COLORS) return;
    const newColors = [...currentColors, config.defaults.paletteDefaults.newPaletteColor];
    const preserveId = palette && isUserPalette(palette.id);
    onChange({
      ...palette,
      id: preserveId ? palette.id : config.customPaletteId,
      name: preserveId ? palette.name : "Custom",
      shortName: preserveId ? palette.shortName : "Custom",
      colors: newColors,
    });
  };

  const handleRemoveColor = (index: number) => {
    const currentColors = palette?.colors ?? [];
    if (currentColors.length <= 2) return;
    const newColors = [...currentColors];
    newColors.splice(index, 1);
    const preserveId = palette && isUserPalette(palette.id);
    onChange({
      ...palette,
      id: preserveId ? palette.id : config.customPaletteId,
      name: preserveId ? palette.name : "Custom",
      shortName: preserveId ? palette.shortName : "Custom",
      colors: newColors,
    });
  };

  if (colors.length === 0) {
    return (
      <div className="color-palette color-palette--empty">
        <span className="field-label color-palette__label">Custom Palette</span>
        <Button onClick={handleAddColor} className="color-palette__add-btn">
          <Plus />
        </Button>
      </div>
    );
  }

  return (
    <div {...props} className={clsx("color-palette", props.className)}>
      <span className="field-label color-palette__label">{palette?.name ?? "Palette"}</span>
      <span className="field-label color-palette__count">
        {colors.length}/{MAX_PALETTE_COLORS}
      </span>
      <div className="color-palette__colors fade-mask-x" style={{ "--box-padding": "40px" } as any}>
        {colors.map((rgba, i) => (
          <div key={i} className="color-palette__item">
            <ColorPicker
              value={rgbaToHex6(rgba)}
              onChange={(hex) => handleColorChange(hex, i)}
              onChangeStart={() => undo.beginTransaction()}
              onChangeEnd={() => undo.commitTransaction("Change palette color")}
              onRemove={canRemove ? () => handleRemoveColor(i) : undefined}
            />
          </div>
        ))}
      </div>
      <div className="color-palette__actions">
        {canAdd && (
          <Button onClick={handleAddColor} className="color-palette__add-btn" variant="primary">
            <Plus />
          </Button>
        )}
        {canDelete && onDelete && (
          <Button
            onClick={onDelete}
            className="color-palette__delete-btn"
            variant="destructive"
            aria-label="Delete palette"
          >
            <Trash />
          </Button>
        )}
      </div>
    </div>
  );
}
