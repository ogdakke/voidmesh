// ---------------------------------------------------------------------------
// Canvas-Rendered Context Menu
// ---------------------------------------------------------------------------
//
// GPU-rendered context menu using Box/Text/Icon primitives from renderer/ui/.
// Mirrors the DOM-based canvas-context-menu.tsx structure and iconography as
// closely as the current canvas UI system allows.
//

import type { ContextMenuActions } from "../context-menu-actions.ts";
import type { ContextMenuState } from "../context-menu-controller.ts";
import { contextMenuController } from "../context-menu-controller.ts";
import type { SceneNode } from "../scene-node.ts";
import type { ColorPalette, ShaderCanvasEntity } from "#types/canvas.ts";
import {
  ASCII_KIND_OPTIONS,
  DITHERING_KIND_OPTIONS,
  GLASS_KIND_OPTIONS,
  GLITCH_KIND_OPTIONS,
  SHADER_TYPE_OPTIONS,
  SHAPE_OPTIONS,
  isAnimatedEntity,
} from "#types/canvas.ts";
import { IMAGE_FORMAT_OPTIONS } from "#renderer/export-formats.ts";
import { buildPaletteList } from "#components/palette-preset/palette-presets.ts";
import { Box } from "../primitives.tsx";
import { solid } from "../elements.ts";
import {
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuItem,
  MenuPanel,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenuTrigger,
} from "./menu-primitives.tsx";
import {
  Copy,
  Download,
  FloppyDiskArrowIn,
  Import,
  JpgFormat,
  MediaVideo,
  PasteClipboard,
  PngFormat,
  ScaleFrameEnlarge,
  Trash,
} from "iconoir-react";
import { MaterialSymbolsFlipToBackRounded } from "#components/icons/flip-to-back.tsx";
import { MaterialSymbolsFlipToFrontRounded } from "#components/icons/flip-to-front.tsx";
import { IonDuplicateOutline } from "#components/icons/duplicate.tsx";
import { MaterialSymbolsResetImage } from "#components/icons/reset-image.tsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SHOW_SAFE_POLYGON_DEBUG = false;

const IMAGE_FORMAT_ICONS = {
  png: PngFormat,
  jpeg: JpgFormat,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MenuHints {
  bringToFront?: string;
  copySelection?: string;
  deleteEntity?: string;
  duplicateEntity?: string;
  openStudio?: string;
  pasteCanvas?: string;
  pasteSelection?: string;
  saveAsStudio?: string;
  saveStudio?: string;
  sendToBack?: string;
  togglePreserveColors?: string;
  toggleReversePalette?: string;
  toggleShowOriginal?: string;
  toggleSnapToGrid?: string;
}

interface StringOptionState {
  supported: boolean;
  value: string | undefined;
  mixed: boolean;
  values: string[];
}

interface BooleanOptionState {
  supported: boolean;
  value: boolean;
  mixed: boolean;
}

export interface CanvasContextMenuProps {
  state: ContextMenuState;
  actions: ContextMenuActions;
  hints: MenuHints;
  customPalettes: ColorPalette[];
  snapToGrid: boolean;
  showOriginal: BooleanOptionState;
  preserveColors: BooleanOptionState;
  reversePalette: BooleanOptionState;
  asciiInvert: BooleanOptionState;
  shaderType: StringOptionState & { values: string[] };
  shape: StringOptionState;
  ditheringKind: StringOptionState;
  asciiKind: StringOptionState;
  glassKind: StringOptionState;
  glitchKind: StringOptionState;
  currentPaletteId: string | undefined;
  paletteMixed: boolean;
  paletteValues: ColorPalette[];
  hasEntities: boolean;
  menuX: number;
  menuY: number;
  activeSubmenuId: string | null;
  screenScale: number;
  /** Monotonic counter that changes every frame when debug overlay is active. Breaks Compiler cache for debug-only reads from mutable singletons. */
  debugTick: number;
}

interface OptionDefinition {
  value: string;
  label: string;
}

function openSubmenu(id: string, node: SceneNode) {
  const ctrl = contextMenuController;
  if (ctrl.activeSubmenuId === id) return;
  ctrl.activeSubmenuId = id;
  ctrl.submenu.open(node);
}

function syncSubmenuPanel(node: SceneNode) {
  contextMenuController.submenu.syncSubmenuNode(node);
}

function closeSubmenu() {
  contextMenuController.submenu.close();
  contextMenuController.activeSubmenuId = null;
}

function withCount(label: string, count: number, isMultiple: boolean): string {
  return isMultiple ? `${label} (${count})` : label;
}

function getOptionLabel(options: OptionDefinition[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function MixedValueGroup({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;

  return (
    <>
      <MenuGroupLabel label={label} />
      {values.map((value) => (
        <MenuItem key={value} label={value} disabled />
      ))}
      <MenuSeparator />
    </>
  );
}

function renderSafePolygonDebug(screenScale: number, _debugTick: number) {
  if (!SHOW_SAFE_POLYGON_DEBUG) return null;

  const debug = contextMenuController.submenu.getDebugState(screenScale);
  if (!debug.triggerRect || !debug.submenuRect) return null;

  return (
    <Box position="absolute" left={0} top={0} zIndex={20000}>
      <Box
        position="absolute"
        left={debug.triggerRect.x}
        top={debug.triggerRect.y}
        width={debug.triggerRect.width}
        height={debug.triggerRect.height}
        background={solid("rgba(255, 193, 7, 0.12)")}
        borderWidth={2}
        borderColor="rgba(255, 193, 7, 0.8)"
      />
      <Box
        position="absolute"
        left={debug.submenuRect.x}
        top={debug.submenuRect.y}
        width={debug.submenuRect.width}
        height={debug.submenuRect.height}
        background={solid("rgba(33, 150, 243, 0.12)")}
        borderWidth={2}
        borderColor="rgba(33, 150, 243, 0.85)"
      />
      {debug.troughRect ? (
        <Box
          position="absolute"
          left={debug.troughRect.x}
          top={debug.troughRect.y}
          width={debug.troughRect.width}
          height={debug.troughRect.height}
          background={solid("rgba(76, 175, 80, 0.18)")}
          borderWidth={2}
          borderColor="rgba(76, 175, 80, 0.85)"
        />
      ) : null}
      {debug.exitPoint ? (
        <Box
          position="absolute"
          left={debug.exitPoint.x - 3}
          top={debug.exitPoint.y - 3}
          width={6}
          height={6}
          background={solid("rgba(244, 67, 54, 0.95)")}
          borderRadius={999}
        />
      ) : null}
      {debug.polygon.map((point, index) => (
        <Box
          key={`safe-poly-point-${index}`}
          position="absolute"
          left={point.x - 3}
          top={point.y - 3}
          width={6}
          height={6}
          background={solid("rgba(233, 30, 99, 0.95)")}
          borderRadius={999}
        />
      ))}
    </Box>
  );
}

function OptionSubmenu({
  submenuId,
  title,
  activeSubmenuId,
  options,
  optionState,
  mixedLabel,
  onSelect,
}: {
  submenuId: string;
  title: string;
  activeSubmenuId: string | null;
  options: OptionDefinition[];
  optionState: StringOptionState;
  mixedLabel: string;
  onSelect: (value: string) => void;
}) {
  if (!optionState.supported) return null;

  const mixedValues = optionState.mixed
    ? optionState.values.map((value) => getOptionLabel(options, value))
    : [];

  return (
    <MenuSubmenuTrigger
      label={title}
      open={activeSubmenuId === submenuId}
      onHoverEnter={(node) => openSubmenu(submenuId, node)}
    >
      {activeSubmenuId === submenuId && (
        <Box position="absolute" placement="right-start" contain="viewport" zIndex={10000}>
          <MenuPanel onLayout={syncSubmenuPanel}>
            <MixedValueGroup label={mixedLabel} values={mixedValues} />
            {options.map((option) => (
              <MenuRadioItem
                key={option.value}
                label={option.label}
                selected={!optionState.mixed && optionState.value === option.value}
                onClick={() => {
                  onSelect(option.value);
                  closeSubmenu();
                }}
              />
            ))}
          </MenuPanel>
        </Box>
      )}
    </MenuSubmenuTrigger>
  );
}

function PaletteSubmenu({
  activeSubmenuId,
  currentPaletteId,
  paletteMixed,
  paletteValues,
  palettes,
  actions,
}: {
  activeSubmenuId: string | null;
  currentPaletteId: string | undefined;
  paletteMixed: boolean;
  paletteValues: ColorPalette[];
  palettes: ColorPalette[];
  actions: ContextMenuActions;
}) {
  return (
    <MenuSubmenuTrigger
      label="Palette Preset"
      open={activeSubmenuId === "palette"}
      onHoverEnter={(node) => openSubmenu("palette", node)}
    >
      {activeSubmenuId === "palette" && (
        <Box position="absolute" placement="right-start" contain="viewport" zIndex={10000}>
          <MenuPanel onLayout={syncSubmenuPanel}>
            {paletteMixed && paletteValues.length > 0 ? (
              <>
                <MenuGroupLabel label="Selection palettes" />
                {paletteValues.map((palette) => (
                  <MenuItem key={palette.id ?? palette.name} label={palette.name} disabled />
                ))}
                <MenuSeparator />
              </>
            ) : null}
            {palettes.map((palette) => (
              <MenuRadioItem
                key={palette.id ?? palette.name}
                label={palette.name}
                selected={!paletteMixed && currentPaletteId === palette.id}
                onClick={() => {
                  actions.changePalette(palette);
                  closeSubmenu();
                }}
              />
            ))}
          </MenuPanel>
        </Box>
      )}
    </MenuSubmenuTrigger>
  );
}

function SaveAsSubmenu({
  activeSubmenuId,
  animatedEntities,
  actions,
  hasAnimated,
  hasMixed,
  isMultiple,
  selectionCount,
}: {
  activeSubmenuId: string | null;
  animatedEntities: ShaderCanvasEntity[];
  actions: ContextMenuActions;
  hasAnimated: boolean;
  hasMixed: boolean;
  isMultiple: boolean;
  selectionCount: number;
}) {
  return (
    <MenuSubmenuTrigger
      label="Save as..."
      open={activeSubmenuId === "save-as"}
      onHoverEnter={(node) => openSubmenu("save-as", node)}
    >
      {activeSubmenuId === "save-as" && (
        <Box position="absolute" placement="right-start" contain="viewport" zIndex={10000}>
          <MenuPanel onLayout={syncSubmenuPanel}>
            {hasAnimated ? (
              <>
                {hasMixed ? (
                  <MenuItem
                    label="Save All"
                    icon={Download}
                    onClick={() => {
                      actions.saveAll(animatedEntities);
                      closeSubmenu();
                    }}
                  />
                ) : null}
                {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => (
                  <MenuItem
                    key={value}
                    label={`Save ${isMultiple ? `${selectionCount} Frames` : "Frame"} (${label})`}
                    icon={IMAGE_FORMAT_ICONS[value]}
                    onClick={() => {
                      actions.saveAsFormat(value);
                      closeSubmenu();
                    }}
                  />
                ))}
                <MenuItem
                  label={`Export${isMultiple && animatedEntities.length > 1 ? ` ${animatedEntities.length}` : ""}`}
                  icon={MediaVideo}
                  onClick={() => {
                    actions.exportAnimated(animatedEntities);
                    closeSubmenu();
                  }}
                />
              </>
            ) : (
              <>
                {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => (
                  <MenuItem
                    key={value}
                    label={label}
                    icon={IMAGE_FORMAT_ICONS[value]}
                    onClick={() => {
                      actions.saveAsFormat(value);
                      closeSubmenu();
                    }}
                  />
                ))}
              </>
            )}
          </MenuPanel>
        </Box>
      )}
    </MenuSubmenuTrigger>
  );
}

function WorkspaceSubmenu({
  activeSubmenuId,
  actions,
  hasEntities,
  hints,
}: {
  activeSubmenuId: string | null;
  actions: ContextMenuActions;
  hasEntities: boolean;
  hints: MenuHints;
}) {
  return (
    <MenuSubmenuTrigger
      label="Save/Open workspace..."
      open={activeSubmenuId === "workspace"}
      onHoverEnter={(node) => openSubmenu("workspace", node)}
    >
      {activeSubmenuId === "workspace" && (
        <Box position="absolute" placement="right-start" contain="viewport" zIndex={10000}>
          <MenuPanel onLayout={syncSubmenuPanel}>
            {hasEntities ? (
              <>
                <MenuItem
                  label="Save"
                  icon={FloppyDiskArrowIn}
                  hint={hints.saveStudio}
                  onClick={() => {
                    actions.saveWorkspace();
                    actions.close();
                  }}
                />
                <MenuItem
                  label="Save as..."
                  icon={FloppyDiskArrowIn}
                  hint={hints.saveAsStudio}
                  onClick={() => {
                    actions.saveAsWorkspace();
                    actions.close();
                  }}
                />
              </>
            ) : null}
            <MenuItem
              label="Open"
              icon={Import}
              hint={hints.openStudio}
              onClick={() => {
                actions.openWorkspace();
                actions.close();
              }}
            />
          </MenuPanel>
        </Box>
      )}
    </MenuSubmenuTrigger>
  );
}

function EffectsSubmenu({
  activeSubmenuId,
  actions,
  hints,
  isMultiple,
}: {
  activeSubmenuId: string | null;
  actions: ContextMenuActions;
  hints: MenuHints;
  isMultiple: boolean;
}) {
  return (
    <MenuSubmenuTrigger
      label="Copy/Paste as..."
      open={activeSubmenuId === "effects"}
      onHoverEnter={(node) => openSubmenu("effects", node)}
    >
      {activeSubmenuId === "effects" && (
        <Box position="absolute" placement="right-start" contain="viewport" zIndex={10000}>
          <MenuPanel onLayout={syncSubmenuPanel}>
            <MenuItem
              label="Copy Effects"
              icon={Copy}
              disabled={isMultiple}
              onClick={() => {
                actions.copyEffects();
                actions.close();
              }}
            />
            <MenuItem
              label="Paste Effects"
              icon={PasteClipboard}
              hint={hints.pasteSelection}
              onClick={() => {
                actions.pasteEffects();
                actions.close();
              }}
            />
          </MenuPanel>
        </Box>
      )}
    </MenuSubmenuTrigger>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CanvasContextMenu({
  state,
  actions,
  hints,
  customPalettes,
  snapToGrid,
  showOriginal,
  preserveColors,
  reversePalette,
  asciiInvert,
  shaderType,
  shape,
  ditheringKind,
  asciiKind,
  glassKind,
  glitchKind,
  currentPaletteId,
  paletteMixed,
  paletteValues,
  hasEntities,
  menuX,
  menuY,
  activeSubmenuId,
  screenScale,
  debugTick,
}: CanvasContextMenuProps) {
  const { frozenEntity, frozenSelection } = state;
  const isMultiple = frozenSelection?.isMultiple ?? false;
  const selectionCount = frozenSelection?.count ?? 0;
  const frozenEntities = frozenSelection?.entities ?? [];
  const animatedEntities = frozenEntities.filter(isAnimatedEntity);
  const staticCount = frozenEntities.filter((entity) => !isAnimatedEntity(entity)).length;
  const hasAnimated = animatedEntities.length > 0;
  const hasMixed = hasAnimated && staticCount > 0;
  const palettes = buildPaletteList(customPalettes, frozenEntity?.originalPalette).map(
    (item) => item.palette,
  );

  if (!frozenEntity) {
    return (
      <Box position="fixed" left={menuX} top={menuY} contain="viewport" zIndex={9999}>
        <MenuPanel>
          <MenuItem
            label="Paste"
            icon={PasteClipboard}
            hint={hints.pasteCanvas}
            onClick={() => {
              actions.paste();
              actions.close();
            }}
          />
          <MenuSeparator />
          <WorkspaceSubmenu
            activeSubmenuId={activeSubmenuId}
            actions={actions}
            hasEntities={hasEntities}
            hints={hints}
          />
          <MenuSeparator />
          <MenuCheckboxItem
            label="Snap to Grid"
            checked={snapToGrid}
            hint={hints.toggleSnapToGrid}
            onClick={() => {
              actions.toggleSnapToGrid(!snapToGrid);
              actions.close();
            }}
          />
        </MenuPanel>
        {renderSafePolygonDebug(screenScale, debugTick)}
      </Box>
    );
  }

  return (
    <Box position="fixed" left={menuX} top={menuY} contain="viewport" zIndex={9999}>
      <MenuPanel>
        {isMultiple ? (
          <>
            <MenuGroupLabel label={`${selectionCount} items selected`} />
            <MenuSeparator />
          </>
        ) : null}

        <OptionSubmenu
          submenuId="style"
          title="Style"
          activeSubmenuId={activeSubmenuId}
          options={SHADER_TYPE_OPTIONS}
          optionState={shaderType}
          mixedLabel="Selection styles"
          onSelect={actions.changeShaderType}
        />

        <MenuSeparator />

        <OptionSubmenu
          submenuId="shape"
          title="Shape"
          activeSubmenuId={activeSubmenuId}
          options={SHAPE_OPTIONS}
          optionState={shape}
          mixedLabel="Selection shapes"
          onSelect={actions.changeShape}
        />
        <OptionSubmenu
          submenuId="algorithm"
          title="Algorithm"
          activeSubmenuId={activeSubmenuId}
          options={DITHERING_KIND_OPTIONS}
          optionState={ditheringKind}
          mixedLabel="Selection algorithms"
          onSelect={actions.changeDitheringKind}
        />
        <OptionSubmenu
          submenuId="character-set"
          title="Character Set"
          activeSubmenuId={activeSubmenuId}
          options={ASCII_KIND_OPTIONS}
          optionState={asciiKind}
          mixedLabel="Selection character sets"
          onSelect={actions.changeAsciiKind}
        />
        {asciiInvert.supported ? (
          <MenuCheckboxItem
            label={`Invert Brightness${asciiInvert.mixed ? " (Mixed)" : ""}`}
            checked={asciiInvert.mixed ? false : asciiInvert.value}
            mixed={asciiInvert.mixed}
            onClick={() => {
              const next = asciiInvert.mixed ? true : !asciiInvert.value;
              actions.toggleAsciiInvert(next);
              actions.close();
            }}
          />
        ) : null}
        <OptionSubmenu
          submenuId="glass-type"
          title="Glass Type"
          activeSubmenuId={activeSubmenuId}
          options={GLASS_KIND_OPTIONS}
          optionState={glassKind}
          mixedLabel="Selection glass types"
          onSelect={actions.changeGlassKind}
        />
        <OptionSubmenu
          submenuId="glitch-type"
          title="Glitch Type"
          activeSubmenuId={activeSubmenuId}
          options={GLITCH_KIND_OPTIONS}
          optionState={glitchKind}
          mixedLabel="Selection glitch types"
          onSelect={actions.changeGlitchKind}
        />

        {currentPaletteId !== undefined || paletteMixed || paletteValues.length > 0 ? (
          <>
            <MenuSeparator />
            <PaletteSubmenu
              activeSubmenuId={activeSubmenuId}
              currentPaletteId={currentPaletteId}
              paletteMixed={paletteMixed}
              paletteValues={paletteValues}
              palettes={palettes}
              actions={actions}
            />
            <MenuItem
              label="Load Palette..."
              onClick={() => {
                actions.triggerPaletteUpload();
                actions.close();
              }}
            />
          </>
        ) : null}

        <MenuSeparator />

        <MenuCheckboxItem
          label={`Show Original${showOriginal.mixed ? " (Mixed)" : ""}`}
          checked={showOriginal.mixed ? false : showOriginal.value}
          mixed={showOriginal.mixed}
          hint={hints.toggleShowOriginal}
          onClick={() => {
            const next = showOriginal.mixed ? true : !showOriginal.value;
            actions.toggleShowOriginal(next);
            actions.close();
          }}
        />

        {preserveColors.supported ? (
          <MenuCheckboxItem
            label={`Preserve Colors${preserveColors.mixed ? " (Mixed)" : ""}`}
            checked={preserveColors.mixed ? false : preserveColors.value}
            mixed={preserveColors.mixed}
            hint={hints.togglePreserveColors}
            onClick={() => {
              const next = preserveColors.mixed ? true : !preserveColors.value;
              actions.togglePreserveColors(next);
              actions.close();
            }}
          />
        ) : null}

        {reversePalette.supported ? (
          <MenuCheckboxItem
            label={`Reverse Palette${reversePalette.mixed ? " (Mixed)" : ""}`}
            checked={reversePalette.mixed ? false : reversePalette.value}
            mixed={reversePalette.mixed}
            hint={hints.toggleReversePalette}
            onClick={() => {
              const next = reversePalette.mixed ? true : !reversePalette.value;
              actions.toggleReversePalette(next);
              actions.close();
            }}
          />
        ) : null}

        <MenuSeparator />

        {!isMultiple ? (
          <MenuItem
            label={frozenEntity && isAnimatedEntity(frozenEntity) ? "Copy Frame" : "Copy Image"}
            icon={Copy}
            hint={hints.copySelection}
            onClick={() => {
              actions.copyImage();
              actions.close();
            }}
          />
        ) : null}

        <SaveAsSubmenu
          activeSubmenuId={activeSubmenuId}
          animatedEntities={animatedEntities}
          actions={actions}
          hasAnimated={hasAnimated}
          hasMixed={hasMixed}
          isMultiple={isMultiple}
          selectionCount={selectionCount}
        />
        <EffectsSubmenu
          activeSubmenuId={activeSubmenuId}
          actions={actions}
          hints={hints}
          isMultiple={isMultiple}
        />

        <MenuSeparator />

        <MenuItem
          label={withCount("Bring to Front", selectionCount, isMultiple)}
          icon={MaterialSymbolsFlipToFrontRounded}
          hint={hints.bringToFront}
          onClick={() => {
            actions.bringToFront();
            actions.close();
          }}
        />
        <MenuItem
          label={withCount("Send to Back", selectionCount, isMultiple)}
          icon={MaterialSymbolsFlipToBackRounded}
          hint={hints.sendToBack}
          onClick={() => {
            actions.sendToBack();
            actions.close();
          }}
        />
        <MenuItem
          label={withCount("Duplicate", selectionCount, isMultiple)}
          icon={IonDuplicateOutline}
          hint={hints.duplicateEntity}
          onClick={() => {
            actions.duplicate();
            actions.close();
          }}
        />
        <MenuItem
          label={withCount("Upscale 2×", selectionCount, isMultiple)}
          icon={ScaleFrameEnlarge}
          onClick={() => {
            actions.upscale(frozenEntities.map((entity) => entity.id));
            actions.close();
          }}
        />

        <MenuSeparator />

        <MenuItem
          label={withCount("Reset", selectionCount, isMultiple)}
          icon={MaterialSymbolsResetImage}
          onClick={() => {
            actions.reset();
            actions.close();
          }}
        />
        <MenuItem
          label={withCount("Delete", selectionCount, isMultiple)}
          icon={Trash}
          destructive
          hint={hints.deleteEntity}
          onClick={() => {
            actions.deleteEntity();
            actions.close();
          }}
        />
      </MenuPanel>
      {renderSafePolygonDebug(screenScale, debugTick)}
    </Box>
  );
}
