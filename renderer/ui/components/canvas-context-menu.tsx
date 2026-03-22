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
import type { ReactNode } from "react";
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
import { IMAGE_FORMAT_OPTIONS, type ImageExportFormat } from "#renderer/export-formats.ts";
import { buildPaletteList } from "#components/palette-preset/palette-presets.ts";
import { Box } from "../primitives.tsx";
import { solid } from "../elements.ts";
import {
  getSubmenuOffset,
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
  submenuGutter?: number;
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
        <MenuItem key={value} disabled>
          <MenuItem.Label>{value}</MenuItem.Label>
        </MenuItem>
      ))}
      <MenuSeparator />
    </>
  );
}

function SubmenuLayer({ gutter, children }: { gutter: number; children: ReactNode }) {
  return (
    <Box
      position="absolute"
      placement="right-start"
      offset={getSubmenuOffset(gutter)}
      contain="viewport"
      zIndex={10000}
    >
      <MenuPanel onLayout={syncSubmenuPanel}>{children}</MenuPanel>
    </Box>
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
  gutter,
  options,
  optionState,
  mixedLabel,
  onSelect,
}: {
  submenuId: string;
  title: string;
  activeSubmenuId: string | null;
  gutter: number;
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
      open={activeSubmenuId === submenuId}
      onHoverEnter={(node) => openSubmenu(submenuId, node)}
    >
      <MenuSubmenuTrigger.Label>{title}</MenuSubmenuTrigger.Label>
      {activeSubmenuId === submenuId && (
        <SubmenuLayer gutter={gutter}>
          <MixedValueGroup label={mixedLabel} values={mixedValues} />
          {options.map((option) => (
            <MenuRadioItem
              key={option.value}
              selected={!optionState.mixed && optionState.value === option.value}
              onClick={() => onSelect(option.value)}
            >
              <MenuRadioItem.Label>{option.label}</MenuRadioItem.Label>
            </MenuRadioItem>
          ))}
        </SubmenuLayer>
      )}
    </MenuSubmenuTrigger>
  );
}

function PaletteSubmenu({
  activeSubmenuId,
  gutter,
  currentPaletteId,
  paletteMixed,
  paletteValues,
  palettes,
  actions,
}: {
  activeSubmenuId: string | null;
  gutter: number;
  currentPaletteId: string | undefined;
  paletteMixed: boolean;
  paletteValues: ColorPalette[];
  palettes: ColorPalette[];
  actions: ContextMenuActions;
}) {
  return (
    <MenuSubmenuTrigger
      open={activeSubmenuId === "palette"}
      onHoverEnter={(node) => openSubmenu("palette", node)}
    >
      <MenuSubmenuTrigger.Label>Palette Preset</MenuSubmenuTrigger.Label>
      {activeSubmenuId === "palette" && (
        <SubmenuLayer gutter={gutter}>
          {paletteMixed && paletteValues.length > 0 ? (
            <>
              <MenuGroupLabel label="Selection palettes" />
              {paletteValues.map((palette) => (
                <MenuItem key={palette.id ?? palette.name} disabled>
                  <MenuItem.Label>{palette.name}</MenuItem.Label>
                </MenuItem>
              ))}
              <MenuSeparator />
            </>
          ) : null}
          {palettes.map((palette) => (
            <MenuRadioItem
              key={palette.id ?? palette.name}
              selected={!paletteMixed && currentPaletteId === palette.id}
              onClick={() => actions.changePalette(palette)}
            >
              <MenuRadioItem.Label>{palette.name}</MenuRadioItem.Label>
            </MenuRadioItem>
          ))}
        </SubmenuLayer>
      )}
    </MenuSubmenuTrigger>
  );
}

function SaveAsSubmenu({
  activeSubmenuId,
  gutter,
  animatedEntities,
  actions,
  hasAnimated,
  hasMixed,
  isMultiple,
  selectionCount,
}: {
  activeSubmenuId: string | null;
  gutter: number;
  animatedEntities: ShaderCanvasEntity[];
  actions: ContextMenuActions;
  hasAnimated: boolean;
  hasMixed: boolean;
  isMultiple: boolean;
  selectionCount: number;
}) {
  return (
    <MenuSubmenuTrigger
      open={activeSubmenuId === "save-as"}
      onHoverEnter={(node) => openSubmenu("save-as", node)}
    >
      <MenuSubmenuTrigger.Label>Save as...</MenuSubmenuTrigger.Label>
      {activeSubmenuId === "save-as" && (
        <SubmenuLayer gutter={gutter}>
          {hasAnimated ? (
            <>
              {hasMixed ? (
                <MenuItem
                  onClick={() => {
                    actions.saveAll(animatedEntities);
                    actions.close();
                  }}
                >
                  <MenuItem.Icon>
                    <Download />
                  </MenuItem.Icon>
                  <MenuItem.Label>Save All</MenuItem.Label>
                </MenuItem>
              ) : null}
              {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => (
                <ImageFormatMenuItem
                  key={value}
                  format={value}
                  label={`Save ${isMultiple ? `${selectionCount} Frames` : "Frame"} (${label})`}
                  onClick={() => {
                    actions.saveAsFormat(value);
                    actions.close();
                  }}
                />
              ))}
              <MenuItem
                onClick={() => {
                  actions.exportAnimated(animatedEntities);
                  actions.close();
                }}
              >
                <MenuItem.Icon>
                  <MediaVideo />
                </MenuItem.Icon>
                <MenuItem.Label>
                  {`Export${isMultiple && animatedEntities.length > 1 ? ` ${animatedEntities.length}` : ""}`}
                </MenuItem.Label>
              </MenuItem>
            </>
          ) : (
            <>
              {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => (
                <ImageFormatMenuItem
                  key={value}
                  format={value}
                  label={label}
                  onClick={() => {
                    actions.saveAsFormat(value);
                    actions.close();
                  }}
                />
              ))}
            </>
          )}
        </SubmenuLayer>
      )}
    </MenuSubmenuTrigger>
  );
}

function WorkspaceSubmenu({
  activeSubmenuId,
  gutter,
  actions,
  hasEntities,
}: {
  activeSubmenuId: string | null;
  gutter: number;
  actions: ContextMenuActions;
  hasEntities: boolean;
}) {
  return (
    <MenuSubmenuTrigger
      open={activeSubmenuId === "workspace"}
      onHoverEnter={(node) => openSubmenu("workspace", node)}
    >
      <MenuSubmenuTrigger.Label>Save/Open workspace...</MenuSubmenuTrigger.Label>
      {activeSubmenuId === "workspace" && (
        <SubmenuLayer gutter={gutter}>
          {hasEntities ? (
            <>
              <MenuItem
                onClick={() => {
                  actions.saveWorkspace();
                  actions.close();
                }}
              >
                <MenuItem.Icon>
                  <FloppyDiskArrowIn />
                </MenuItem.Icon>
                <MenuItem.Label>Save</MenuItem.Label>
                <MenuItem.Shortcut id="save_studio" />
              </MenuItem>
              <MenuItem
                onClick={() => {
                  actions.saveAsWorkspace();
                  actions.close();
                }}
              >
                <MenuItem.Icon>
                  <FloppyDiskArrowIn />
                </MenuItem.Icon>
                <MenuItem.Label>Save as...</MenuItem.Label>
                <MenuItem.Shortcut id="save_as_studio" />
              </MenuItem>
            </>
          ) : null}
          <MenuItem
            onClick={() => {
              actions.openWorkspace();
              actions.close();
            }}
          >
            <MenuItem.Icon>
              <Import />
            </MenuItem.Icon>
            <MenuItem.Label>Open</MenuItem.Label>
            <MenuItem.Shortcut id="open_studio" />
          </MenuItem>
        </SubmenuLayer>
      )}
    </MenuSubmenuTrigger>
  );
}

function EffectsSubmenu({
  activeSubmenuId,
  gutter,
  actions,
  isMultiple,
}: {
  activeSubmenuId: string | null;
  gutter: number;
  actions: ContextMenuActions;
  isMultiple: boolean;
}) {
  return (
    <MenuSubmenuTrigger
      open={activeSubmenuId === "effects"}
      onHoverEnter={(node) => openSubmenu("effects", node)}
    >
      <MenuSubmenuTrigger.Label>Copy/Paste as...</MenuSubmenuTrigger.Label>
      {activeSubmenuId === "effects" && (
        <SubmenuLayer gutter={gutter}>
          <MenuItem
            disabled={isMultiple}
            onClick={() => {
              actions.copyEffects();
              actions.close();
            }}
          >
            <MenuItem.Icon>
              <Copy />
            </MenuItem.Icon>
            <MenuItem.Label>Copy Effects</MenuItem.Label>
            <MenuItem.Shortcut id="copy_effects" />
          </MenuItem>
          <MenuItem
            onClick={() => {
              actions.pasteEffects();
              actions.close();
            }}
          >
            <MenuItem.Icon>
              <PasteClipboard />
            </MenuItem.Icon>
            <MenuItem.Label>Paste Effects</MenuItem.Label>
            <MenuItem.Shortcut id="paste_selection" />
          </MenuItem>
        </SubmenuLayer>
      )}
    </MenuSubmenuTrigger>
  );
}

function ImageFormatMenuItem({
  format,
  label,
  onClick,
}: {
  format: ImageExportFormat;
  label: string;
  onClick: () => void;
}) {
  const FormatIcon = IMAGE_FORMAT_ICONS[format];

  return (
    <MenuItem onClick={onClick}>
      <MenuItem.Icon>
        <FormatIcon />
      </MenuItem.Icon>
      <MenuItem.Label>{label}</MenuItem.Label>
    </MenuItem>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CanvasContextMenu({
  state,
  actions,
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
  submenuGutter = 4,
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
            onClick={() => {
              actions.paste();
              actions.close();
            }}
          >
            <MenuItem.Icon>
              <PasteClipboard />
            </MenuItem.Icon>
            <MenuItem.Label>Paste</MenuItem.Label>
            <MenuItem.Shortcut id="paste_canvas" />
          </MenuItem>
          <MenuSeparator />
          <WorkspaceSubmenu
            activeSubmenuId={activeSubmenuId}
            gutter={submenuGutter}
            actions={actions}
            hasEntities={hasEntities}
          />
          <MenuSeparator />
          <MenuCheckboxItem
            checked={snapToGrid}
            onClick={() => {
              actions.toggleSnapToGrid(!snapToGrid);
            }}
          >
            <MenuCheckboxItem.Label>Snap to Grid</MenuCheckboxItem.Label>
            <MenuCheckboxItem.Shortcut id="toggle_snap_to_grid" />
          </MenuCheckboxItem>
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
          gutter={submenuGutter}
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
          gutter={submenuGutter}
          options={SHAPE_OPTIONS}
          optionState={shape}
          mixedLabel="Selection shapes"
          onSelect={actions.changeShape}
        />
        <OptionSubmenu
          submenuId="algorithm"
          title="Algorithm"
          activeSubmenuId={activeSubmenuId}
          gutter={submenuGutter}
          options={DITHERING_KIND_OPTIONS}
          optionState={ditheringKind}
          mixedLabel="Selection algorithms"
          onSelect={actions.changeDitheringKind}
        />
        <OptionSubmenu
          submenuId="character-set"
          title="Character Set"
          activeSubmenuId={activeSubmenuId}
          gutter={submenuGutter}
          options={ASCII_KIND_OPTIONS}
          optionState={asciiKind}
          mixedLabel="Selection character sets"
          onSelect={actions.changeAsciiKind}
        />
        {asciiInvert.supported ? (
          <MenuCheckboxItem
            checked={asciiInvert.mixed ? false : asciiInvert.value}
            mixed={asciiInvert.mixed}
            onClick={() => {
              const next = asciiInvert.mixed ? true : !asciiInvert.value;
              actions.toggleAsciiInvert(next);
            }}
          >
            <MenuCheckboxItem.Label>
              {`Invert Brightness${asciiInvert.mixed ? " (Mixed)" : ""}`}
            </MenuCheckboxItem.Label>
          </MenuCheckboxItem>
        ) : null}
        <OptionSubmenu
          submenuId="glass-type"
          title="Glass Type"
          activeSubmenuId={activeSubmenuId}
          gutter={submenuGutter}
          options={GLASS_KIND_OPTIONS}
          optionState={glassKind}
          mixedLabel="Selection glass types"
          onSelect={actions.changeGlassKind}
        />
        <OptionSubmenu
          submenuId="glitch-type"
          title="Glitch Type"
          activeSubmenuId={activeSubmenuId}
          gutter={submenuGutter}
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
              gutter={submenuGutter}
              currentPaletteId={currentPaletteId}
              paletteMixed={paletteMixed}
              paletteValues={paletteValues}
              palettes={palettes}
              actions={actions}
            />
            <MenuItem
              onClick={() => {
                actions.triggerPaletteUpload();
                actions.close();
              }}
            >
              <MenuItem.Label>Load Palette...</MenuItem.Label>
            </MenuItem>
          </>
        ) : null}

        <MenuSeparator />

        <MenuCheckboxItem
          checked={showOriginal.mixed ? false : showOriginal.value}
          mixed={showOriginal.mixed}
          onClick={() => {
            const next = showOriginal.mixed ? true : !showOriginal.value;
            actions.toggleShowOriginal(next);
          }}
        >
          <MenuCheckboxItem.Label>
            {`Show Original${showOriginal.mixed ? " (Mixed)" : ""}`}
          </MenuCheckboxItem.Label>
          <MenuCheckboxItem.Shortcut id="toggle_show_original" />
        </MenuCheckboxItem>

        {preserveColors.supported ? (
          <MenuCheckboxItem
            checked={preserveColors.mixed ? false : preserveColors.value}
            mixed={preserveColors.mixed}
            onClick={() => {
              const next = preserveColors.mixed ? true : !preserveColors.value;
              actions.togglePreserveColors(next);
            }}
          >
            <MenuCheckboxItem.Label>
              {`Preserve Colors${preserveColors.mixed ? " (Mixed)" : ""}`}
            </MenuCheckboxItem.Label>
            <MenuCheckboxItem.Shortcut id="toggle_preserve_colors" />
          </MenuCheckboxItem>
        ) : null}

        {reversePalette.supported ? (
          <MenuCheckboxItem
            checked={reversePalette.mixed ? false : reversePalette.value}
            mixed={reversePalette.mixed}
            onClick={() => {
              const next = reversePalette.mixed ? true : !reversePalette.value;
              actions.toggleReversePalette(next);
            }}
          >
            <MenuCheckboxItem.Label>
              {`Reverse Palette${reversePalette.mixed ? " (Mixed)" : ""}`}
            </MenuCheckboxItem.Label>
            <MenuCheckboxItem.Shortcut id="toggle_reverse_palette" />
          </MenuCheckboxItem>
        ) : null}

        <MenuSeparator />

        {!isMultiple ? (
          <MenuItem
            onClick={() => {
              actions.copyImage();
              actions.close();
            }}
          >
            <MenuItem.Icon>
              <Copy />
            </MenuItem.Icon>
            <MenuItem.Label>
              {frozenEntity && isAnimatedEntity(frozenEntity) ? "Copy Frame" : "Copy Image"}
            </MenuItem.Label>
            <MenuItem.Shortcut id="copy_selection" />
          </MenuItem>
        ) : null}

        <SaveAsSubmenu
          activeSubmenuId={activeSubmenuId}
          gutter={submenuGutter}
          animatedEntities={animatedEntities}
          actions={actions}
          hasAnimated={hasAnimated}
          hasMixed={hasMixed}
          isMultiple={isMultiple}
          selectionCount={selectionCount}
        />
        <EffectsSubmenu
          activeSubmenuId={activeSubmenuId}
          gutter={submenuGutter}
          actions={actions}
          isMultiple={isMultiple}
        />

        <MenuSeparator />

        <MenuItem
          onClick={() => {
            actions.bringToFront();
            actions.close();
          }}
        >
          <MenuItem.Icon>
            <MaterialSymbolsFlipToFrontRounded />
          </MenuItem.Icon>
          <MenuItem.Label>{withCount("Bring to Front", selectionCount, isMultiple)}</MenuItem.Label>
          <MenuItem.Shortcut id="bring_to_front" />
        </MenuItem>
        <MenuItem
          onClick={() => {
            actions.sendToBack();
            actions.close();
          }}
        >
          <MenuItem.Icon>
            <MaterialSymbolsFlipToBackRounded />
          </MenuItem.Icon>
          <MenuItem.Label>{withCount("Send to Back", selectionCount, isMultiple)}</MenuItem.Label>
          <MenuItem.Shortcut id="send_to_back" />
        </MenuItem>
        <MenuItem
          onClick={() => {
            actions.duplicate();
            actions.close();
          }}
        >
          <MenuItem.Icon>
            <IonDuplicateOutline />
          </MenuItem.Icon>
          <MenuItem.Label>{withCount("Duplicate", selectionCount, isMultiple)}</MenuItem.Label>
          <MenuItem.Shortcut id="duplicate_entity" />
        </MenuItem>
        <MenuItem
          onClick={() => {
            actions.upscale(frozenEntities.map((entity) => entity.id));
            actions.close();
          }}
        >
          <MenuItem.Icon>
            <ScaleFrameEnlarge />
          </MenuItem.Icon>
          <MenuItem.Label>{withCount("Upscale 2×", selectionCount, isMultiple)}</MenuItem.Label>
        </MenuItem>

        <MenuSeparator />

        <MenuItem
          onClick={() => {
            actions.reset();
            actions.close();
          }}
        >
          <MenuItem.Icon>
            <MaterialSymbolsResetImage />
          </MenuItem.Icon>
          <MenuItem.Label>{withCount("Reset", selectionCount, isMultiple)}</MenuItem.Label>
        </MenuItem>
        <MenuItem
          destructive
          onClick={() => {
            actions.deleteEntity();
            actions.close();
          }}
        >
          <MenuItem.Icon>
            <Trash />
          </MenuItem.Icon>
          <MenuItem.Label>{withCount("Delete", selectionCount, isMultiple)}</MenuItem.Label>
          <MenuItem.Shortcut id="delete_entity" />
        </MenuItem>
      </MenuPanel>
      {renderSafePolygonDebug(screenScale, debugTick)}
    </Box>
  );
}
