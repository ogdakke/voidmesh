import { type ComponentProps, type KeyboardEvent, useRef, useState } from "react";
import { ColorPickerPreset } from "../color-picker/color-picker.tsx";
import { Button } from "../button/index.tsx";
import { EditPencil, Plus, Trash } from "iconoir-react";
import { Drawer } from "../drawer/index.tsx";
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
  /** Callback to rename the palette (only for user-created palettes) */
  onRename?: (name: string) => void;
  /** Whether the delete button should be shown (true for user-created palettes) */
  canDelete?: boolean;
  /** Whether the palette name can be edited */
  canRename?: boolean;
  /** Palette action style. Mobile uses the management drawer. */
  actionMode?: "delete" | "manage";
  /** Whether the inline label should render as an editable input */
  editableLabel?: boolean;
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
  onRename,
  canDelete,
  canRename,
  actionMode = "delete",
  editableLabel = true,
  colorSpace = ColorSpace.srgb,
  reversed = false,
  ...props
}: ColorPaletteProps) {
  const colors = palette?.colors ?? [];
  const displayColors = reversed ? [...colors].reverse() : colors;
  const canRemove = colors.length > 2;
  const canAdd = colors.length < MAX_PALETTE_COLORS;
  const isEditableUserPalette = !!palette?.id && isUserPalette(palette.id);
  const canEditName = editableLabel && !!canRename && !!onRename && isEditableUserPalette;
  const canManage = actionMode === "manage" && isEditableUserPalette && (!!onRename || !!onDelete);

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
      <PaletteNameLabel
        key={`${palette?.id ?? "palette"}:${palette?.name ?? "Palette"}`}
        name={palette?.name ?? "Palette"}
        canRename={canEditName}
        onRename={onRename}
      />
      <span className="field-label color-palette__count">
        {colors.length}/{MAX_PALETTE_COLORS}
      </span>
      <div className="color-palette__colors fade-mask-x">
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
        <Button
          onClick={handleAddColor}
          className="color-palette__add-btn"
          variant="primary"
          disabled={!canAdd}
          title="Add color"
          aria-label="Add color"
        >
          <Plus />
        </Button>

        {canManage && palette && (
          <PaletteManagementDrawer palette={palette} onRename={onRename} onDelete={onDelete} />
        )}

        {actionMode === "delete" && canDelete && onDelete && (
          <Button
            onClick={onDelete}
            className="color-palette__delete-btn"
            variant="destructive"
            aria-label="Delete palette"
            title="Delete palette"
          >
            <Trash />
          </Button>
        )}
      </div>
    </div>
  );
}

function PaletteNameLabel({
  name,
  canRename,
  onRename,
}: {
  name: string;
  canRename: boolean;
  onRename?: (name: string) => void;
}) {
  const [draftName, setDraftName] = useState(name);
  const skipBlurCommitRef = useRef(false);

  const commitName = () => {
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      setDraftName(name);
      return;
    }
    if (trimmedName !== name) onRename?.(trimmedName);
    setDraftName(trimmedName);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      skipBlurCommitRef.current = true;
      setDraftName(name);
      event.currentTarget.blur();
    }
  };

  if (!canRename) {
    return <span className="field-label color-palette__label">{name}</span>;
  }

  return (
    <input
      type="text"
      className="field-label color-palette__label color-palette__name-input"
      name="palette-name"
      value={draftName}
      maxLength={64}
      aria-label="Palette name"
      title="Rename palette"
      autoComplete="off"
      spellCheck={false}
      autoCorrect="off"
      placeholder="Name your palette"
      onChange={(event) => setDraftName(event.currentTarget.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (skipBlurCommitRef.current) {
          skipBlurCommitRef.current = false;
          return;
        }
        commitName();
      }}
    />
  );
}

function PaletteManagementDrawer({
  palette,
  onRename,
  onDelete,
}: {
  palette: ColorPaletteType;
  onRename?: (name: string) => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(palette.name);
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setDraftName(palette.name);
    setOpen(nextOpen);
  };

  const handleRename = () => {
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      setDraftName(palette.name);
      return;
    }
    if (trimmedName !== palette.name) onRename?.(trimmedName);
    setOpen(false);
  };

  const handleDelete = () => {
    setOpen(false);
    onDelete?.();
  };

  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange}>
      <Drawer.Trigger
        className="ui-button color-palette__manage-btn"
        data-variant="secondary"
        data-size="md"
        aria-label="Edit palette"
        title="Edit palette"
      >
        <EditPencil />
      </Drawer.Trigger>
      <Drawer.Popup className="color-palette-drawer">
        <Drawer.Title>Edit palette</Drawer.Title>
        <Drawer.Content className="color-palette-drawer__content">
          <label className="color-palette-drawer__field" id="palette-name">
            <span className="field-label">Palette name</span>
            <input
              aria-labelledby="palette-name"
              type="text"
              value={draftName}
              maxLength={64}
              autoComplete="off"
              name="palette-name"
              spellCheck={false}
              autoCorrect="off"
              placeholder="Name your palette"
              className="color-palette-drawer__input"
              onChange={(event) => setDraftName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleRename();
              }}
            />
          </label>
          <div className="color-palette-drawer__actions">
            {onRename && (
              <Button variant="primary" onClick={handleRename}>
                <span>Rename</span>
              </Button>
            )}
            {onDelete && (
              <Button variant="destructive" onClick={handleDelete}>
                <span>Delete</span>
              </Button>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Popup>
    </Drawer.Root>
  );
}
