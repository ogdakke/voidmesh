import { type ComponentProps } from "react";
import { ColorPickerPreset } from "../color-picker/color-picker.tsx";
import { Button } from "../button/index.tsx";
import { Plus, Trash } from "iconoir-react";
import type { ColorPalette as ColorPaletteType } from "#types/canvas.ts";
import { MAX_PALETTE_COLORS } from "#types/canvas.ts";
import { cssColorToRGBAInColorSpace, rgbaToCss } from "#lib/color-utils.ts";
import { ColorSpace } from "#types/enums.ts";
import { config } from "#config";
import { isUserPalette } from "#components/palette-preset/palette-presets.ts";
import { undo } from "#lib/undo.ts";
import clsx from "clsx";
import "./color-palette.css";
import "../form/form.css";

interface ColorPaletteProps extends ComponentProps<"div"> {
  /** Current palette (controlled) */
  palette: ColorPaletteType | undefined;
  /** Callback when palette colors change */
  onValueChange: (palette: ColorPaletteType) => void;
  /** Callback to delete the entire palette (only for user-created palettes) */
  onDelete?: () => void;
  /** Whether the delete button should be shown (true for user-created palettes) */
  canDelete?: boolean;
  /** Color space for CSS output (default: srgb) */
  colorSpace?: ColorSpace;
  /** When true, display palette in reversed order (lightest first) */
  reversed?: boolean;
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
  colorSpace = ColorSpace.srgb,
  reversed = false,
  ...props
}: ColorPaletteProps) {
  const colors = palette?.colors ?? [];
  const displayColors = reversed ? [...colors].reverse() : colors;
  const canRemove = colors.length > 2;
  const canAdd = colors.length < MAX_PALETTE_COLORS;

  /** Map display index to storage index */
  const toStorageIndex = (displayIndex: number) =>
    reversed ? colors.length - 1 - displayIndex : displayIndex;

  const handleColorChange = (cssColor: string, displayIndex: number) => {
    const currentColors = palette?.colors ?? [];
    const storageIndex = toStorageIndex(displayIndex);
    const newColors = [...currentColors];
    newColors[storageIndex] = cssColorToRGBAInColorSpace(cssColor, colorSpace);
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

  const handleRemoveColor = (displayIndex: number) => {
    const currentColors = palette?.colors ?? [];
    if (currentColors.length <= 2) return;
    const storageIndex = toStorageIndex(displayIndex);
    const newColors = [...currentColors];
    newColors.splice(storageIndex, 1);
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
        {displayColors.map((rgba, i) => (
          <div key={i} className="color-palette__item">
            <ColorPickerPreset
              value={rgbaToCss(rgba, colorSpace)}
              onChange={(color) => handleColorChange(color, i)}
              onChangeStart={() => undo.beginTransaction()}
              onChangeEnd={() => undo.commitTransaction("Change palette color")}
              onRemove={canRemove ? () => handleRemoveColor(i) : undefined}
              colorSpace={colorSpace}
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
