import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DropletHalf, Plus, QuestionMark } from "iconoir-react";
import {
  useCanvasCommands,
  useCanvasRendererService,
  useSelectedEntity,
} from "#context/use-canvas.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { config } from "#config";
import { undo } from "#lib/undo.ts";
import {
  isUserPalette,
  buildPaletteList,
  type PaletteListItem,
} from "#components/palette-preset/palette-presets.ts";
import type { ColorPalette as ColorPaletteType } from "#types/canvas.ts";
import { usePaletteStore } from "#lib/palette-store.ts";
import {
  SliderPicker,
  SliderPickerItem,
  SliderPickerMixedItem,
  SliderPickerOptions,
  SliderPickerWindow,
} from "#ui/slider-picker/index.ts";
import { ColorPalette } from "#ui/color-palette/color-palette.tsx";
import { PaletteUpload } from "../palette-upload/index.ts";
import { ColorPaletteThumbnail } from "../color-palette-thumbnail/index.ts";
import "./knobs.css";
import "./mobile-color-knobs.css";

// Special IDs for non-palette items
const PRESERVE_COLORS_ID = "__preserve_colors__";
const REVERSE_PALETTE_ID = "__reverse_palette__";
const UPLOAD_MODE_ID = "__upload__";

/** Mobile-specific palette list item with label and nullable palette for upload/toggle buttons */
interface MobilePaletteItem {
  id: string;
  palette: ColorPaletteType | null;
  /** extract is when user uploads an image where we then extract a palette from it */
  type: PaletteListItem["type"] | "extract" | "preserveColors" | "reversePalette";
  label: string;
  shortLabel: string;
  toggleable?: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  };
}

export function MobileColorKnobs() {
  const { changePalette, renamePalette, uploadPalette, deletePalette, updateSelectedEntityParams } =
    useCanvasCommands();
  const selectedEntity = useSelectedEntity();
  const customPalettes = usePaletteStore();
  const { colorSpace } = useCanvasRendererService();
  const paletteParam = useParamValue("palette", config.defaults.shaderParams.palette);
  const preserveColors = useParamValue(
    "preserveColors",
    config.defaults.shaderParams.preserveColors,
  );
  const reversePalette = useParamValue(
    "reversePalette",
    config.defaults.shaderParams.reversePalette,
  );

  // Track selected item ID
  const [selectedId, setSelectedId] = useState<string>(() => {
    // Default to current palette ID or first preset (skip upload button)
    return paletteParam.value?.id ?? Object.keys(config.palettes)[0]!;
  });

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(
      () => setFloatingLabel(null),
      config.ui.floatingParamLabelHideTimeoutMs,
    );
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    },
    [],
  );

  // Track previous palette ID to detect external changes (undo/redo, new palette created)
  const [prevPaletteId, setPrevPaletteId] = useState(paletteParam.value?.id);
  if (paletteParam.value?.id !== prevPaletteId) {
    setPrevPaletteId(paletteParam.value?.id);
    if (paletteParam.value?.id) {
      setSelectedId(paletteParam.value.id);
    }
  }

  // Toggle handler for preserveColors (mixed-aware: clicking when mixed sets all to true)
  const handlePreserveColorsChange = (checked: boolean) => {
    const value = preserveColors.isMixed ? true : checked;
    updateSelectedEntityParams({ preserveColors: value });
  };

  const handleReversePaletteChange = (checked: boolean) => {
    const value = reversePalette.isMixed ? true : checked;
    updateSelectedEntityParams({ reversePalette: value });
  };

  // Build the palette list using centralized function + mobile-specific buttons
  const paletteList: MobilePaletteItem[] = (() => {
    const items = buildPaletteList(customPalettes, selectedEntity?.originalPalette);

    // Prepend preserveColors toggle and upload button (mobile-only), then add labels
    return [
      {
        id: PRESERVE_COLORS_ID,
        palette: null,
        type: "preserveColors" as const,
        label: "Preserve Colors",
        shortLabel: "Preserve",
        toggleable: {
          checked: preserveColors.isMixed ? false : !!preserveColors.value,
          onCheckedChange: handlePreserveColorsChange,
        },
      },
      ...(reversePalette.isSupported
        ? [
            {
              id: REVERSE_PALETTE_ID,
              palette: null,
              type: "reversePalette" as const,
              label: "Reverse Palette",
              shortLabel: "Reverse",
              toggleable: {
                checked: reversePalette.isMixed ? false : !!reversePalette.value,
                onCheckedChange: handleReversePaletteChange,
              },
            },
          ]
        : []),
      {
        id: UPLOAD_MODE_ID,
        palette: null,
        type: "extract" as const,
        label: "Extract Palette",
        shortLabel: "Extract",
      },
      ...items.map((item) => ({
        id: item.id,
        palette: item.palette,
        type: item.type,
        label: item.palette.name,
        shortLabel: item.palette.shortName,
      })),
    ];
  })();

  // Determine current mode
  const isUploadMode = selectedId === UPLOAD_MODE_ID;
  const selectedItem = paletteList.find((item) => item.id === selectedId);
  const isPreserveColorsSelected = selectedId === PRESERVE_COLORS_ID;
  const isReversePaletteSelected = selectedId === REVERSE_PALETTE_ID;

  // Handle palette selection
  const handleValueChange = (id: string) => {
    setSelectedId(id);

    const item = paletteList.find((p) => p.id === id);
    if (item?.palette) {
      changePalette(item.palette);
      showFloatingLabel(item.label);
    } else if (id === UPLOAD_MODE_ID) {
      showFloatingLabel("Extract palette");
    } else if (id === PRESERVE_COLORS_ID) {
      showFloatingLabel("Preserve Colors");
    } else if (id === REVERSE_PALETTE_ID) {
      showFloatingLabel("Reverse Palette");
    } else if (id === "") {
      showFloatingLabel("Mixed Palettes");
    }
  };

  // Show floating label on interaction start + begin undo transaction
  const handleInteractionStart = () => {
    showFloatingLabel(selectedItem?.label ?? "Extract");
    undo.beginTransaction();
  };

  // Hide floating label after timeout + commit undo transaction
  const handleValueCommit = () => {
    undo.commitTransaction();
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
  };

  // Hide entire palette UI for shaders that don't support palettes (e.g. glass)
  if (!paletteParam.isSupported) return null;

  return (
    <>
      {/* Floating label - rendered via portal */}
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      {/* Slider picker for palette selection */}
      <SliderPicker
        value={paletteParam.isMixed ? "" : selectedId}
        onValueChange={handleValueChange}
        onInteractionStart={handleInteractionStart}
        onValueCommit={handleValueCommit}
        className="mobile-style-knobs mobile-color-knobs__picker"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="Color palette selection"
          >
            {paletteParam.isMixed && (
              <SliderPickerMixedItem className="mobile-style-knobs__item">
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
                  <QuestionMark />
                </button>
                <span className="mobile-style-knobs__label">Mixed</span>
              </SliderPickerMixedItem>
            )}
            {paletteList.map((item) => (
              <SliderPickerItem
                key={item.id}
                value={item.id}
                className="mobile-style-knobs__item mobile-color-knobs__item"
                data-type={item.type}
                {...(item.toggleable
                  ? {
                      checked: item.toggleable.checked,
                      onCheckedChange: item.toggleable.onCheckedChange,
                    }
                  : {})}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  className="ui-button"
                  data-variant={
                    item.type === "extract" || item.type === "reversePalette"
                      ? "secondary"
                      : "quiet"
                  }
                  aria-labelledby={item.id}
                  {...(item.toggleable
                    ? {
                        "aria-checked": item.toggleable.checked,
                        role: "switch",
                      }
                    : {})}
                >
                  {item.type === "extract" ? <Plus /> : null}
                  {item.palette ? <ColorPaletteThumbnail palette={item.palette} /> : null}
                  {item.type === "reversePalette" ? <DropletHalf /> : null}
                </button>
                <span id={item.id} className="mobile-style-knobs__label">
                  {item.shortLabel}
                </span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>

      {/* Conditional content: Upload, toggle picker, or ColorPalette editor */}
      {isUploadMode ? (
        <PaletteUpload onUpload={uploadPalette} variant="mobile" />
      ) : isPreserveColorsSelected ? (
        <BooleanSliderPicker
          value={!!preserveColors.value}
          isMixed={preserveColors.isMixed}
          onValueChange={(v) => updateSelectedEntityParams({ preserveColors: v })}
          ariaLabel="Preserve colors"
        />
      ) : isReversePaletteSelected ? (
        <BooleanSliderPicker
          value={!!reversePalette.value}
          isMixed={reversePalette.isMixed}
          onValueChange={(v) => updateSelectedEntityParams({ reversePalette: v })}
          ariaLabel="Reverse palette"
        />
      ) : // show nothing if mixed
      paletteParam.isMixed ? null : (
        <ColorPalette
          palette={paletteParam.value ?? undefined}
          onValueChange={changePalette}
          colorSpace={colorSpace}
          reversed={!!reversePalette.value}
          onRename={
            paletteParam.value?.id && isUserPalette(paletteParam.value.id)
              ? (name) => renamePalette(paletteParam.value!.id!, name)
              : undefined
          }
          onDelete={
            paletteParam.value?.id && isUserPalette(paletteParam.value.id)
              ? () => deletePalette(paletteParam.value!.id!)
              : undefined
          }
          canRename={!!paletteParam.value?.id && isUserPalette(paletteParam.value.id)}
          canDelete={!!paletteParam.value?.id && isUserPalette(paletteParam.value.id)}
          actionMode="manage"
          editableLabel={false}
          className="mobile-color__palette"
        />
      )}
    </>
  );
}

function BooleanSliderPicker({
  value,
  isMixed,
  onValueChange,
  ariaLabel,
}: {
  value: boolean;
  isMixed: boolean;
  onValueChange: (value: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <SliderPicker
      value={isMixed ? "" : value ? "on" : "off"}
      onValueChange={(v) => {
        if (v === "on") onValueChange(true);
        else if (v === "off") onValueChange(false);
      }}
      onInteractionStart={() => undo.beginTransaction()}
      onValueCommit={() => undo.commitTransaction()}
      className="mobile-style-knobs mobile-color-knobs__toggle-picker"
    >
      <SliderPickerWindow className="mobile-style-knobs__window">
        <SliderPickerOptions className="mobile-style-knobs__options" aria-label={ariaLabel}>
          {isMixed && (
            <SliderPickerMixedItem className="mobile-style-knobs__item">
              <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
                <QuestionMark />
              </button>
              <span className="mobile-style-knobs__label">Mixed</span>
            </SliderPickerMixedItem>
          )}
          <SliderPickerItem value="on" className="mobile-style-knobs__item">
            <button type="button" tabIndex={-1} className="ui-button" data-variant="primary">
              On
            </button>
            <span className="mobile-style-knobs__label">On</span>
          </SliderPickerItem>
          <SliderPickerItem value="off" className="mobile-style-knobs__item">
            <button type="button" tabIndex={-1} className="ui-button" data-variant="primary">
              Off
            </button>
            <span className="mobile-style-knobs__label">Off</span>
          </SliderPickerItem>
        </SliderPickerOptions>
        <div className="mobile-style-knobs__highlight" aria-hidden="true" />
      </SliderPickerWindow>
    </SliderPicker>
  );
}
