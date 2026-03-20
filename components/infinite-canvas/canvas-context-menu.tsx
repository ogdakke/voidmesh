import { canvasStore } from "#engine";
import { useImageInput } from "#hooks/use-image-input.ts";
import { useCanvasActions, useParamValue } from "#hooks/use-canvas-actions.ts";
import { useExportQueue } from "#context/use-export-queue.ts";
import { useUpscaleQueue } from "#context/use-upscale-queue.ts";
import { type ShaderCanvasEntity, SHADER_TYPE_OPTIONS, isAnimatedEntity } from "#types/canvas.ts";
import {
  NavArrowRight,
  Check,
  Circle,
  Trash,
  Copy,
  Download,
  MediaVideo,
  Minus,
  PasteClipboard,
  PngFormat,
  JpgFormat,
  Import,
  FloppyDiskArrowIn,
  ScaleFrameEnlarge,
} from "iconoir-react";
import { type RefObject, type PropsWithChildren, useRef, useState } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import "../ui/menu/menu.css";
import { Keybind } from "../keyboard-shortcuts/keybind.tsx";
import { useCanvas } from "#context/use-canvas.ts";
import { MaterialSymbolsFlipToFrontRounded } from "../icons/flip-to-front.tsx";
import { MaterialSymbolsFlipToBackRounded } from "../icons/flip-to-back.tsx";
import { IonDuplicateOutline } from "../icons/duplicate.tsx";
import { config } from "#config";
import { logger } from "#lib/client.logger.ts";
import { AsciiMenuKnobs } from "../ascii-knobs.tsx";
import { DitheringMenuKnobs } from "../dithering-knobs.tsx";
import { GlassMenuKnobs } from "../glass-knobs.tsx";
import { GlitchMenuKnobs } from "../glitch-knobs.tsx";
import { ShapeMenuKnobs } from "../shape-knobs.tsx";
import { buildPaletteList } from "../palette-preset/palette-presets.ts";
import { usePaletteStore } from "#lib/palette-store.ts";
import { MaterialSymbolsResetImage } from "../icons/reset-image.tsx";
import { useStudioFile } from "#hooks/use-studio-file.ts";
import {
  type ImageExportFormat,
  IMAGE_FORMAT_OPTIONS,
  imageExportOptionsForFormat,
} from "#renderer/export-formats.ts";

const IMAGE_FORMAT_ICONS: Record<ImageExportFormat, typeof PngFormat> = {
  png: PngFormat,
  jpeg: JpgFormat,
};

/** Frozen selection state captured when context menu opens */
interface FrozenSelectionState {
  entities: ShaderCanvasEntity[];
  count: number;
  isMultiple: boolean;
}

export interface CanvasContextMenuProps {
  onOpenChange: (open: boolean) => void;
  containerRef: RefObject<HTMLDivElement | null>;
}

const SIDE_OFFSET = 4;

export default function CanvasContextMenu({
  children,
  onOpenChange,
  containerRef,
}: PropsWithChildren<CanvasContextMenuProps>) {
  const { handlePaletteUpload } = useCanvasActions();
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const [frozenEntity, setFrozenEntity] = useState<ShaderCanvasEntity | undefined>(undefined);
  const [frozenSelection, setFrozenSelection] = useState<FrozenSelectionState | null>(null);

  const handleOpenChange = (open: boolean) => {
    onOpenChange(open);

    if (open) {
      // Freeze entity value at open time - read from store synchronously
      // to prevent flickering
      const state = canvasStore.getState();
      const entityId = state.contextOpenEntityId;

      if (!entityId) {
        setFrozenEntity(undefined);
      } else {
        const entity = state.entities.get(entityId);
        setFrozenEntity(entity);
      }

      // Freeze selection state for multi-select support
      const selectedEntities = canvasStore.getSelectedEntities();
      setFrozenSelection({
        entities: selectedEntities,
        count: selectedEntities.length,
        isMultiple: selectedEntities.length > 1,
      });
    }
  };

  const handleOpenChangeComplete = (open: boolean) => {
    // Clear frozen state only after close animation completes
    if (!open) {
      setFrozenEntity(undefined);
      setFrozenSelection(null);
    }
  };

  const handlePaletteInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handlePaletteUpload(e.target.files);
    // Reset input to allow selecting the same file again
    e.target.value = "";
  };

  return (
    <>
      {/* Hidden file input - persists outside context menu to survive menu close */}
      <input
        ref={paletteInputRef}
        type="file"
        accept="image/*"
        onChange={handlePaletteInputChange}
        style={{ display: "none" }}
      />
      <ContextMenu.Root
        onOpenChange={handleOpenChange}
        onOpenChangeComplete={handleOpenChangeComplete}
      >
        <ContextMenu.Trigger className="canvas-menu-trigger">{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="menu-positioner">
            <ContextMenu.Popup className="menu-popup">
              <CanvasContextMenuItems
                contextOpenEntity={frozenEntity}
                frozenSelection={frozenSelection}
                containerRef={containerRef}
                paletteInputRef={paletteInputRef}
              />
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </>
  );
}

interface FilePickerButtonProps {
  onClick: () => void;
  children: React.ReactNode;
}

function FilePickerButton({ onClick, children }: FilePickerButtonProps) {
  return (
    <ContextMenu.Item className="menu-item" onClick={onClick}>
      {children}
    </ContextMenu.Item>
  );
}

interface CanvasContextMenuItemsProps {
  contextOpenEntity: ShaderCanvasEntity | undefined;
  frozenSelection: FrozenSelectionState | null;
  containerRef: RefObject<HTMLDivElement | null>;
  paletteInputRef: RefObject<HTMLInputElement | null>;
}

function CanvasContextMenuItems({
  contextOpenEntity,
  frozenSelection,
  containerRef,
  paletteInputRef,
}: CanvasContextMenuItemsProps) {
  const { handlePastedItems } = useImageInput({ containerRef });

  // Use shared canvas actions hook
  const {
    showOriginal,
    preserveColors,
    selectionState,
    handleShaderTypeChange,
    handlePaletteChange,
    handleShowOriginalChange,
    handlePreserveColorsChange,
    handleReversePaletteChange,
    deleteEntity,
    copyEntity,
    copyEntityParams,
    pasteEntityParams,
    handleBringToFront,
    handleSendToBack,
    duplicateEntities,
    resetEntityToDefaults,
    snapToGrid,
    handleSnapToGridChange,
  } = useCanvasActions();

  const { saveSelectedEntityToFile, renderer, entities } = useCanvas();
  const { addToQueue } = useExportQueue();
  const { addToUpscaleQueue } = useUpscaleQueue();
  const { exportStudioFile, saveAsStudioFile, importStudioFile } = useStudioFile();

  // Single selected entity for display (undefined if multi-selected)
  const selectedEntity = (() => {
    if (selectionState.isEmpty || selectionState.isMultiple) return undefined;
    const entities = canvasStore.getSelectedEntities();
    return entities.length === 1 ? entities[0] : undefined;
  })();
  const customPalettes = usePaletteStore();

  // Use frozen selection for display, live state for actions
  const isMultiple = frozenSelection?.isMultiple ?? false;
  const selectionCount = frozenSelection?.count ?? 0;

  // Compute selection composition from frozen selection
  const frozenEntities = frozenSelection?.entities ?? [];
  const animatedEntities = frozenEntities.filter(isAnimatedEntity);
  const staticCount = frozenEntities.filter((e) => !isAnimatedEntity(e)).length;
  const animatedCount = animatedEntities.length;
  const hasAnimated = animatedCount > 0;
  const hasMixed = hasAnimated && staticCount > 0;

  // Export animated entities - queues all animated in selection or single context entity
  const handleAnimatedExport = () => {
    if (!renderer) return;
    if (isMultiple) {
      for (const entity of animatedEntities) {
        addToQueue(entity, renderer);
      }
    } else if (contextOpenEntity && isAnimatedEntity(contextOpenEntity)) {
      addToQueue(contextOpenEntity, renderer);
    }
  };

  // Upscale selected entities
  const handleUpscale = () => {
    const entityIds = isMultiple
      ? frozenEntities.map((e) => e.id)
      : contextOpenEntity
        ? [contextOpenEntity.id]
        : [];
    if (entityIds.length > 0) {
      addToUpscaleQueue(entityIds);
    }
  };

  // Save all: save static entities as images + queue animated entities for export
  const handleSaveAll = async () => {
    if (!renderer) return;
    // Save static images via the existing save mechanism
    await saveSelectedEntityToFile();
    // Queue animated entities for export
    for (const entity of animatedEntities) {
      addToQueue(entity, renderer);
    }
  };

  // Get palette info with multi-select support
  const paletteParam = useParamValue("palette", null);
  const preserveColorsParam = useParamValue("preserveColors", null);
  const reversePaletteParam = useParamValue("reversePalette", null);

  const triggerPaletteUpload = () => {
    paletteInputRef.current?.click();
  };

  const pasteMenuHandler = async () => {
    const items = await navigator.clipboard.read().catch((e) => {
      logger.error("Error reading clipboard:", e);
      return [];
    });
    const collected: string[] = [];
    for (const item of items) {
      for (const type of item.types) {
        if (type === "text/plain") {
          const blob = await item.getType(type);
          const url = await blob.text();
          if (URL.canParse(url)) {
            collected.push(url);
          }
        }

        if (type.startsWith("image/") || config.supports.video.includes(type)) {
          const blob = await item.getType(type);
          const url = URL.createObjectURL(blob);
          collected.push(url);
        }
      }
    }
    if (collected.length > 0) {
      await handlePastedItems(collected);
    }
  };

  // No entity selected - show paste menu, studio file actions, and canvas settings
  if (!contextOpenEntity) {
    const hasEntities = entities.length > 0;
    return (
      <>
        <ContextMenu.Item
          className="menu-item menu-item--icon-left menu-item--icon-right"
          onClick={pasteMenuHandler}
        >
          <PasteClipboard className="menu-icon-left" />
          Paste
          <Keybind keybindId="paste_canvas" />
        </ContextMenu.Item>
        <ContextMenu.Separator className="menu-separator" />
        <ContextMenu.SubmenuRoot>
          <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
            Save/Open workspace...
            <NavArrowRight />
          </ContextMenu.SubmenuTrigger>
          <ContextMenu.Portal>
            <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
              <ContextMenu.Popup className="menu-submenu-popup">
                {hasEntities && (
                  <>
                    <ContextMenu.Item
                      className="menu-item menu-item--icon-left menu-item--icon-right"
                      onClick={exportStudioFile}
                    >
                      <FloppyDiskArrowIn className="menu-icon-left" />
                      Save
                      <Keybind keybindId="save_studio" />
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className="menu-item menu-item--icon-left menu-item--icon-right"
                      onClick={saveAsStudioFile}
                    >
                      <FloppyDiskArrowIn className="menu-icon-left" />
                      Save as...
                      <Keybind keybindId="save_as_studio" />
                    </ContextMenu.Item>
                  </>
                )}
                <ContextMenu.Item
                  className="menu-item menu-item--icon-left menu-item--icon-right"
                  onClick={() => importStudioFile()}
                >
                  <Import className="menu-icon-left" />
                  Open
                  <Keybind keybindId="open_studio" />
                </ContextMenu.Item>
              </ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.SubmenuRoot>
        <ContextMenu.Separator className="menu-separator" />
        <ContextMenu.CheckboxItem
          className="menu-checkbox-item menu-item--icon-right"
          checked={snapToGrid}
          onCheckedChange={handleSnapToGridChange}
        >
          <ContextMenu.CheckboxItemIndicator className="menu-checkbox-indicator">
            <Check />
          </ContextMenu.CheckboxItemIndicator>
          Snap to Grid
          <Keybind keybindId="toggle_snap_to_grid" />
        </ContextMenu.CheckboxItem>
      </>
    );
  }

  // Build palette list using shared palette store + entity's original palettes
  const paletteList = buildPaletteList(customPalettes, contextOpenEntity?.originalPalette);

  // Map to the expected format for radio items
  const presets = paletteList.map((item) => item.palette);

  // Compute mixed state for checkboxes
  const showOriginalMixed = isMultiple && !selectionState.paramValues.showOriginal?.isUniform;
  const preserveColorsMixed = isMultiple && !selectionState.paramValues.preserveColors?.isUniform;
  const reversePaletteMixed = isMultiple && !selectionState.paramValues.reversePalette?.isUniform;

  return (
    <>
      {/* Selection count header when multiple entities selected */}
      {isMultiple && (
        <>
          <ContextMenu.Group>
            <ContextMenu.GroupLabel className="menu-group-label">
              {selectionCount} items selected
            </ContextMenu.GroupLabel>
          </ContextMenu.Group>
          <ContextMenu.Separator className="menu-separator" />
        </>
      )}

      {/* Shader Type Submenu */}
      <ContextMenu.SubmenuRoot>
        <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
          Style
          <NavArrowRight />
        </ContextMenu.SubmenuTrigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
            <ContextMenu.Popup className="menu-submenu-popup">
              {/* Show current selection's shader types when mixed */}
              {isMultiple && selectionState.shaderTypes.size > 1 && (
                <ContextMenu.Group>
                  <ContextMenu.GroupLabel className="menu-group-label">
                    Selection styles
                  </ContextMenu.GroupLabel>
                  {[...selectionState.shaderTypes].map((type) => (
                    <ContextMenu.Item key={type} className="menu-item" disabled>
                      {SHADER_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type}
                    </ContextMenu.Item>
                  ))}
                  <ContextMenu.Separator className="menu-separator" />
                </ContextMenu.Group>
              )}

              {/* Radio group - no selection when mixed, derive from selectionState for multi-select */}
              <ContextMenu.RadioGroup
                value={
                  selectionState.hasUniformShader ? [...selectionState.shaderTypes][0] : undefined
                }
              >
                {SHADER_TYPE_OPTIONS.map((option) => (
                  <ContextMenu.RadioItem
                    key={option.value}
                    value={option.value}
                    className="menu-radio-item"
                    onClick={() => handleShaderTypeChange(option.value)}
                  >
                    <ContextMenu.RadioItemIndicator className="menu-radio-indicator">
                      <Circle fill="currentColor" />
                    </ContextMenu.RadioItemIndicator>
                    {option.label}
                  </ContextMenu.RadioItem>
                ))}
              </ContextMenu.RadioGroup>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.SubmenuRoot>

      <ContextMenu.Separator className="menu-separator" />

      {/* Shape (only for halftone/melt/blobs - auto-hides via isSupported) */}
      <ShapeMenuKnobs />

      {/* Algorithm (only for dithering - auto-hides via isSupported) */}
      <DitheringMenuKnobs />

      {/* ASCII Character Set (only for ascii - auto-hides via isSupported) */}
      <AsciiMenuKnobs />

      {/* Glass Type (only for glass - auto-hides via isSupported) */}
      <GlassMenuKnobs />

      {/* Glitch Type (only for glitch - auto-hides via isSupported) */}
      <GlitchMenuKnobs />

      {/* Palette section - only for shaders that support palettes */}
      {paletteParam.isSupported && (
        <>
          <ContextMenu.Separator className="menu-separator" />

          {/* Apply Preset Submenu */}
          <ContextMenu.SubmenuRoot>
            <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
              Palette Preset
              <NavArrowRight />
            </ContextMenu.SubmenuTrigger>
            <ContextMenu.Portal>
              <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
                <ContextMenu.Popup className="menu-submenu-popup">
                  {/* Show current selection's palettes when mixed */}
                  {isMultiple && paletteParam.isMixed && (
                    <ContextMenu.Group>
                      <ContextMenu.GroupLabel className="menu-group-label">
                        Selection palettes
                      </ContextMenu.GroupLabel>
                      {[...paletteParam.values].map((p) => (
                        <ContextMenu.Item key={p.id} className="menu-item" disabled>
                          {p.name}
                        </ContextMenu.Item>
                      ))}
                      <ContextMenu.Separator className="menu-separator" />
                    </ContextMenu.Group>
                  )}

                  <ContextMenu.RadioGroup
                    value={paletteParam.isMixed ? undefined : paletteParam.value?.id}
                  >
                    {presets.map((preset) => (
                      <ContextMenu.RadioItem
                        key={preset.id}
                        value={preset.id}
                        className="menu-radio-item"
                        onClick={() => handlePaletteChange(preset)}
                      >
                        <ContextMenu.RadioItemIndicator className="menu-radio-indicator">
                          <Circle fill="currentColor" />
                        </ContextMenu.RadioItemIndicator>
                        {preset.name}
                      </ContextMenu.RadioItem>
                    ))}
                  </ContextMenu.RadioGroup>
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          </ContextMenu.SubmenuRoot>

          {/* Load Palette... */}
          <FilePickerButton onClick={triggerPaletteUpload}>Load Palette...</FilePickerButton>
        </>
      )}

      <ContextMenu.Separator className="menu-separator" />

      {/* Show Original Checkbox - with mixed state visual indicator */}
      <ContextMenu.CheckboxItem
        className="menu-checkbox-item menu-item--icon-right"
        checked={
          showOriginalMixed
            ? false
            : ((selectionState.paramValues.showOriginal?.value as boolean) ?? showOriginal)
        }
        data-mixed={showOriginalMixed ? "" : undefined}
        onCheckedChange={(checked) => {
          // When mixed, clicking sets ALL to true; when uniform, toggle as normal
          const newValue = showOriginalMixed ? true : checked;
          handleShowOriginalChange(newValue);
        }}
      >
        <ContextMenu.CheckboxItemIndicator className="menu-checkbox-indicator">
          {showOriginalMixed ? <Minus /> : <Check />}
        </ContextMenu.CheckboxItemIndicator>
        Show Original{showOriginalMixed && " (Mixed)"}
        <Keybind keybindId={"toggle_show_original"} />
      </ContextMenu.CheckboxItem>

      {/* Preserve Colors Checkbox - with mixed state visual indicator */}
      {preserveColorsParam.isSupported && (
        <ContextMenu.CheckboxItem
          className="menu-checkbox-item menu-item--icon-right"
          checked={
            preserveColorsMixed
              ? false
              : ((selectionState.paramValues.preserveColors?.value as boolean) ?? preserveColors)
          }
          data-mixed={preserveColorsMixed ? "" : undefined}
          onCheckedChange={(checked) => {
            // When mixed, clicking sets ALL to true; when uniform, toggle as normal
            const newValue = preserveColorsMixed ? true : checked;
            handlePreserveColorsChange(newValue);
          }}
        >
          <ContextMenu.CheckboxItemIndicator className="menu-checkbox-indicator">
            {preserveColorsMixed ? <Minus /> : <Check />}
          </ContextMenu.CheckboxItemIndicator>
          Preserve Colors{preserveColorsMixed && " (Mixed)"}
          <Keybind keybindId={"toggle_preserve_colors"} />
        </ContextMenu.CheckboxItem>
      )}

      {/* Reverse Palette Checkbox - with mixed state visual indicator */}
      {reversePaletteParam.isSupported && (
        <ContextMenu.CheckboxItem
          className="menu-checkbox-item menu-item--icon-right"
          checked={
            reversePaletteMixed
              ? false
              : ((selectionState.paramValues.reversePalette?.value as boolean) ?? false)
          }
          data-mixed={reversePaletteMixed ? "" : undefined}
          onCheckedChange={(checked) => {
            const newValue = reversePaletteMixed ? true : checked;
            handleReversePaletteChange(newValue);
          }}
        >
          <ContextMenu.CheckboxItemIndicator className="menu-checkbox-indicator">
            {reversePaletteMixed ? <Minus /> : <Check />}
          </ContextMenu.CheckboxItemIndicator>
          Reverse Palette{reversePaletteMixed && " (Mixed)"}
          <Keybind keybindId={"toggle_reverse_palette"} />
        </ContextMenu.CheckboxItem>
      )}

      {/* Entity Actions */}
      <ContextMenu.Separator className="menu-separator" />

      {/* Copy - only works for single selection */}
      {!isMultiple && (
        <ContextMenu.Item
          className="menu-item menu-item--icon-left menu-item--icon-right"
          onClick={() => copyEntity()}
        >
          <Copy className="menu-icon-left" />
          Copy {selectedEntity && isAnimatedEntity(selectedEntity) ? "Frame" : "Image"}
          <Keybind keybindId={"copy_selection"} />
        </ContextMenu.Item>
      )}

      {/* Save section - branched by selection composition */}
      {hasAnimated ? (
        <ContextMenu.SubmenuRoot>
          <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
            Save as...
            <NavArrowRight />
          </ContextMenu.SubmenuTrigger>

          <ContextMenu.Portal>
            <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
              <ContextMenu.Popup className="menu-submenu-popup">
                {/* Mixed selection: Save All (images + queue animated) */}
                {hasMixed && (
                  <ContextMenu.Item
                    className="menu-item menu-item--icon-left"
                    onClick={handleSaveAll}
                  >
                    <Download className="menu-icon-left" />
                    Save All
                  </ContextMenu.Item>
                )}
                {/* Save frames as images - per format */}
                {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => {
                  const Icon = IMAGE_FORMAT_ICONS[value];
                  return (
                    <ContextMenu.Item
                      key={value}
                      className="menu-item menu-item--icon-left"
                      onClick={() => saveSelectedEntityToFile(imageExportOptionsForFormat(value))}
                    >
                      <Icon className="menu-icon-left" />
                      Save {isMultiple ? `${selectionCount} Frames` : "Frame"} ({label})
                    </ContextMenu.Item>
                  );
                })}
                {/* Export animated entities */}
                <ContextMenu.Item
                  className="menu-item menu-item--icon-left"
                  onClick={handleAnimatedExport}
                >
                  <MediaVideo className="menu-icon-left" />
                  Export{isMultiple && animatedCount > 1 ? ` ${animatedCount}` : ""}
                </ContextMenu.Item>
              </ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.SubmenuRoot>
      ) : (
        <ContextMenu.SubmenuRoot>
          <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
            Save as...
            <NavArrowRight />
          </ContextMenu.SubmenuTrigger>
          <ContextMenu.Portal>
            <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
              <ContextMenu.Popup className="menu-submenu-popup">
                {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => {
                  const Icon = IMAGE_FORMAT_ICONS[value];
                  return (
                    <ContextMenu.Item
                      key={value}
                      className="menu-item menu-item--icon-left"
                      onClick={() => saveSelectedEntityToFile(imageExportOptionsForFormat(value))}
                    >
                      <Icon className="menu-icon-left" />
                      {label}
                    </ContextMenu.Item>
                  );
                })}
              </ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.SubmenuRoot>
      )}
      <ContextMenu.SubmenuRoot>
        <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
          Copy/Paste as...
          <NavArrowRight />
        </ContextMenu.SubmenuTrigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
            <ContextMenu.Popup className="menu-submenu-popup">
              <ContextMenu.Item
                className="menu-item menu-item--icon-left"
                onClick={() => copyEntityParams()}
                disabled={isMultiple}
              >
                <Copy className="menu-icon-left" />
                Copy Effects
              </ContextMenu.Item>
              <ContextMenu.Item
                className="menu-item menu-item--icon-left menu-item--icon-right"
                onClick={() => pasteEntityParams()}
              >
                <PasteClipboard className="menu-icon-left" />
                Paste Effects
                <Keybind keybindId={"paste_selection"} />
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.SubmenuRoot>
      <ContextMenu.Separator className="menu-separator" />
      <ContextMenu.Item
        className="menu-item menu-item--icon-left menu-item--icon-right"
        onClick={handleBringToFront}
      >
        <MaterialSymbolsFlipToFrontRounded className="menu-icon-left" />
        Bring to Front{isMultiple && ` (${selectionCount})`}
        <Keybind keybindId="bring_to_front" />
      </ContextMenu.Item>
      <ContextMenu.Item
        className="menu-item menu-item--icon-left menu-item--icon-right"
        onClick={handleSendToBack}
      >
        <MaterialSymbolsFlipToBackRounded className="menu-icon-left" />
        Send to Back{isMultiple && ` (${selectionCount})`}
        <Keybind keybindId="send_to_back" />
      </ContextMenu.Item>
      <ContextMenu.Item
        className="menu-item menu-item--icon-left menu-item--icon-right"
        onClick={() => duplicateEntities()}
      >
        <IonDuplicateOutline className="menu-icon-left" />
        Duplicate{isMultiple && ` (${selectionCount})`}
        <Keybind keybindId="duplicate_entity" />
      </ContextMenu.Item>
      <ContextMenu.Item className="menu-item menu-item--icon-left" onClick={handleUpscale}>
        <ScaleFrameEnlarge className="menu-icon-left" />
        Upscale 2×{isMultiple && ` (${selectionCount})`}
      </ContextMenu.Item>
      <ContextMenu.Separator className="menu-separator" />
      <ContextMenu.Item
        className="menu-item menu-item--icon-left"
        onClick={() => resetEntityToDefaults()}
      >
        <MaterialSymbolsResetImage className="menu-icon-left" />
        Reset{isMultiple && ` (${selectionCount})`}
      </ContextMenu.Item>
      <ContextMenu.Item
        className="menu-item menu-item--icon-left"
        onClick={() => deleteEntity(undefined, "context_menu")}
        data-variant="destructive"
      >
        <Trash className="menu-icon-left" />
        Delete{isMultiple && ` (${selectionCount})`}
        <Keybind keybindId={"delete_entity"} className="menu-icon-right" />
      </ContextMenu.Item>
    </>
  );
}
