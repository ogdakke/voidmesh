// ---------------------------------------------------------------------------
// Canvas-Rendered Context Menu
// ---------------------------------------------------------------------------
//
// GPU-rendered context menu using Box/Text/Icon primitives from renderer/ui/.
// Mirrors the DOM-based canvas-context-menu.tsx item-for-item.
// Rendered as a fixed-position scene by the canvas renderer.
//

import type { ContextMenuActions } from "../context-menu-actions.ts";
import type { ContextMenuState } from "../context-menu-controller.ts";
import { contextMenuController } from "../context-menu-controller.ts";
import type { SceneNode } from "../scene-node.ts";
import type { ColorPalette } from "#types/canvas.ts";
import { SHADER_TYPE_OPTIONS, isAnimatedEntity } from "#types/canvas.ts";
import { IMAGE_FORMAT_OPTIONS } from "#renderer/export-formats.ts";
import { Box } from "../primitives.tsx";
import {
  MenuPanel,
  MenuItem,
  MenuSeparator,
  MenuGroupLabel,
  MenuCheckboxItem,
  MenuRadioItem,
  MenuSubmenuTrigger,
} from "./menu-primitives.tsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBMENU_WIDTH = 200;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CanvasContextMenuProps {
  state: ContextMenuState;
  actions: ContextMenuActions;
  // Live selection state for param values
  snapToGrid: boolean;
  showOriginal: boolean;
  preserveColors: boolean;
  reversePalette: boolean;
  // Shader/param support flags
  shaderType: string | undefined;
  shaderTypeMixed: boolean;
  paletteSupported: boolean;
  preserveColorsSupported: boolean;
  reversePaletteSupported: boolean;
  // Palette data
  palettes: ColorPalette[];
  currentPaletteId: string | undefined;
  paletteMixed: boolean;
  // Mixed states for multi-select
  showOriginalMixed: boolean;
  preserveColorsMixed: boolean;
  reversePaletteMixed: boolean;
  // Canvas state
  hasEntities: boolean;
  // Computed position (CSS pixels from viewport edge, unclamped — layout engine clamps)
  menuX: number;
  menuY: number;
  // Submenu state — passed as prop so React sees the change and re-renders
  activeSubmenuId: string | null;
}

// ---------------------------------------------------------------------------
// Submenu helpers
// ---------------------------------------------------------------------------

function openSubmenu(id: string, node: SceneNode) {
  const ctrl = contextMenuController;
  if (ctrl.activeSubmenuId === id) return;
  ctrl.activeSubmenuId = id;
  // SubmenuController handles open delay; layout engine handles positioning via placement+contain
  ctrl.submenu.open(
    node,
    { width: SUBMENU_WIDTH, height: 300 },
    { x: 0, y: 0, width: 1e6, height: 1e6 },
  );
}

function closeSubmenu() {
  contextMenuController.submenu.close();
  contextMenuController.activeSubmenuId = null;
}

// ---------------------------------------------------------------------------
// Submenu Content Components
// ---------------------------------------------------------------------------

function StyleSubmenu({
  shaderType,
  shaderTypeMixed,
  actions,
}: {
  shaderType: string | undefined;
  shaderTypeMixed: boolean;
  actions: ContextMenuActions;
}) {
  return (
    <MenuPanel width={SUBMENU_WIDTH}>
      {SHADER_TYPE_OPTIONS.map((option) => (
        <MenuRadioItem
          key={option.value}
          label={option.label}
          selected={!shaderTypeMixed && shaderType === option.value}
          onClick={() => {
            actions.changeShaderType(option.value);
            actions.close();
          }}
        />
      ))}
    </MenuPanel>
  );
}

function SaveAsSubmenu({
  isMultiple,
  selectionCount,
  hasAnimated,
  hasMixed,
  animatedEntities,
  actions,
}: {
  isMultiple: boolean;
  selectionCount: number;
  hasAnimated: boolean;
  hasMixed: boolean;
  animatedEntities: import("#types/canvas.ts").ShaderCanvasEntity[];
  actions: ContextMenuActions;
}) {
  return (
    <MenuPanel width={SUBMENU_WIDTH}>
      {hasAnimated ? (
        <>
          {hasMixed && (
            <MenuItem
              label="Save All"
              onClick={() => {
                actions.saveAsFormat("png");
                actions.exportAnimated(animatedEntities);
                actions.close();
              }}
            />
          )}
          {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => (
            <MenuItem
              key={value}
              label={`${isMultiple ? `${selectionCount} Frames` : "Frame"} (${label})`}
              onClick={() => {
                actions.saveAsFormat(value);
                actions.close();
              }}
            />
          ))}
          <MenuItem
            label={`Export${isMultiple && animatedEntities.length > 1 ? ` ${animatedEntities.length}` : ""}`}
            onClick={() => {
              actions.exportAnimated(animatedEntities);
              actions.close();
            }}
          />
        </>
      ) : (
        <>
          {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => (
            <MenuItem
              key={value}
              label={label}
              onClick={() => {
                actions.saveAsFormat(value);
                actions.close();
              }}
            />
          ))}
        </>
      )}
    </MenuPanel>
  );
}

function PaletteSubmenu({
  palettes,
  currentPaletteId,
  paletteMixed,
  actions,
}: {
  palettes: ColorPalette[];
  currentPaletteId: string | undefined;
  paletteMixed: boolean;
  actions: ContextMenuActions;
}) {
  return (
    <MenuPanel width={SUBMENU_WIDTH}>
      {palettes.map((palette) => (
        <MenuRadioItem
          key={palette.id}
          label={palette.name}
          selected={!paletteMixed && currentPaletteId === palette.id}
          onClick={() => {
            actions.changePalette(palette);
            actions.close();
          }}
        />
      ))}
      <MenuSeparator />
      <MenuItem
        label="Load Palette..."
        onClick={() => {
          actions.triggerPaletteUpload();
          actions.close();
        }}
      />
    </MenuPanel>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CanvasContextMenu({
  state,
  actions,
  snapToGrid,
  showOriginal,
  preserveColors,
  reversePalette,
  shaderType,
  shaderTypeMixed,
  paletteSupported,
  preserveColorsSupported,
  reversePaletteSupported,
  palettes,
  currentPaletteId,
  paletteMixed,
  showOriginalMixed,
  preserveColorsMixed,
  reversePaletteMixed,
  hasEntities,
  menuX,
  menuY,
  activeSubmenuId,
}: CanvasContextMenuProps) {
  const { frozenEntity, frozenSelection } = state;
  const isMultiple = frozenSelection?.isMultiple ?? false;
  const selectionCount = frozenSelection?.count ?? 0;

  const frozenEntities = frozenSelection?.entities ?? [];
  const animatedEntities = frozenEntities.filter(isAnimatedEntity);
  const staticCount = frozenEntities.filter((e) => !isAnimatedEntity(e)).length;
  const hasAnimated = animatedEntities.length > 0;
  const hasMixed = hasAnimated && staticCount > 0;

  // No entity selected — canvas background menu
  if (!frozenEntity) {
    return (
      <Box position="fixed" left={menuX} top={menuY} contain="viewport" zIndex={9999}>
        <MenuPanel width={220}>
          <MenuItem
            label="Paste"
            hint="⌘V"
            onClick={() => {
              actions.paste();
              actions.close();
            }}
          />
          <MenuSeparator />
          {hasEntities && (
            <>
              <MenuItem
                label="Save"
                hint="⌘S"
                onClick={() => {
                  actions.saveWorkspace();
                  actions.close();
                }}
              />
              <MenuItem
                label="Save as..."
                hint="⇧⌘S"
                onClick={() => {
                  actions.saveAsWorkspace();
                  actions.close();
                }}
              />
            </>
          )}
          <MenuItem
            label="Open"
            hint="⌘O"
            onClick={() => {
              actions.openWorkspace();
              actions.close();
            }}
          />
          <MenuSeparator />
          <MenuCheckboxItem
            label="Snap to Grid"
            checked={snapToGrid}
            onClick={() => {
              actions.toggleSnapToGrid(!snapToGrid);
              actions.close();
            }}
          />
        </MenuPanel>
      </Box>
    );
  }

  // Entity selected — full entity menu
  return (
    <Box position="fixed" left={menuX} top={menuY} contain="viewport" zIndex={9999}>
      <MenuPanel width={240}>
        {/* Selection count header */}
        {isMultiple && (
          <>
            <MenuGroupLabel label={`${selectionCount} items selected`} />
            <MenuSeparator />
          </>
        )}

        {/* Style submenu trigger */}
        <MenuSubmenuTrigger
          label="Style"
          onHoverEnter={(node) => openSubmenu("style", node)}
          onHoverLeave={() => closeSubmenu()}
        >
          {activeSubmenuId === "style" && (
            <Box position="absolute" placement="right-start" contain="viewport" zIndex={10000}>
              <StyleSubmenu
                shaderType={shaderType}
                shaderTypeMixed={shaderTypeMixed}
                actions={actions}
              />
            </Box>
          )}
        </MenuSubmenuTrigger>

        {/* Palette submenu trigger */}
        {paletteSupported && (
          <MenuSubmenuTrigger
            label="Palette"
            onHoverEnter={(node) => openSubmenu("palette", node)}
            onHoverLeave={() => closeSubmenu()}
          >
            {activeSubmenuId === "palette" && (
              <Box position="absolute" placement="right-start" contain="viewport" zIndex={10000}>
                <PaletteSubmenu
                  palettes={palettes}
                  currentPaletteId={currentPaletteId}
                  paletteMixed={paletteMixed}
                  actions={actions}
                />
              </Box>
            )}
          </MenuSubmenuTrigger>
        )}

        <MenuSeparator />

        {/* Show Original */}
        <MenuCheckboxItem
          label={`Show Original${showOriginalMixed ? " (Mixed)" : ""}`}
          checked={showOriginalMixed ? false : showOriginal}
          mixed={showOriginalMixed}
          hint="⌘⇧O"
          onClick={() => {
            const newValue = showOriginalMixed ? true : !showOriginal;
            actions.toggleShowOriginal(newValue);
            actions.close();
          }}
        />

        {/* Preserve Colors */}
        {preserveColorsSupported && (
          <MenuCheckboxItem
            label={`Preserve Colors${preserveColorsMixed ? " (Mixed)" : ""}`}
            checked={preserveColorsMixed ? false : preserveColors}
            mixed={preserveColorsMixed}
            onClick={() => {
              const newValue = preserveColorsMixed ? true : !preserveColors;
              actions.togglePreserveColors(newValue);
              actions.close();
            }}
          />
        )}

        {/* Reverse Palette */}
        {reversePaletteSupported && (
          <MenuCheckboxItem
            label={`Reverse Palette${reversePaletteMixed ? " (Mixed)" : ""}`}
            checked={reversePaletteMixed ? false : reversePalette}
            mixed={reversePaletteMixed}
            onClick={() => {
              const newValue = reversePaletteMixed ? true : !reversePalette;
              actions.toggleReversePalette(newValue);
              actions.close();
            }}
          />
        )}

        <MenuSeparator />

        {/* Copy — single selection only */}
        {!isMultiple && (
          <MenuItem
            label={frozenEntity && isAnimatedEntity(frozenEntity) ? "Copy Frame" : "Copy Image"}
            hint="⌘C"
            onClick={() => {
              actions.copyImage();
              actions.close();
            }}
          />
        )}

        {/* Save as submenu trigger */}
        <MenuSubmenuTrigger
          label="Save as..."
          onHoverEnter={(node) => openSubmenu("save-as", node)}
          onHoverLeave={() => closeSubmenu()}
        >
          {activeSubmenuId === "save-as" && (
            <Box position="absolute" placement="right-start" contain="viewport" zIndex={10000}>
              <SaveAsSubmenu
                isMultiple={isMultiple}
                selectionCount={selectionCount}
                hasAnimated={hasAnimated}
                hasMixed={hasMixed}
                animatedEntities={animatedEntities}
                actions={actions}
              />
            </Box>
          )}
        </MenuSubmenuTrigger>

        <MenuSeparator />

        {/* Copy/Paste Effects */}
        <MenuItem
          label="Copy Effects"
          disabled={isMultiple}
          onClick={() => {
            actions.copyEffects();
            actions.close();
          }}
        />
        <MenuItem
          label="Paste Effects"
          hint="⌘⇧V"
          onClick={() => {
            actions.pasteEffects();
            actions.close();
          }}
        />

        <MenuSeparator />

        {/* Ordering */}
        <MenuItem
          label={`Bring to Front${isMultiple ? ` (${selectionCount})` : ""}`}
          hint="⌘]"
          onClick={() => {
            actions.bringToFront();
            actions.close();
          }}
        />
        <MenuItem
          label={`Send to Back${isMultiple ? ` (${selectionCount})` : ""}`}
          hint="⌘["
          onClick={() => {
            actions.sendToBack();
            actions.close();
          }}
        />
        <MenuItem
          label={`Duplicate${isMultiple ? ` (${selectionCount})` : ""}`}
          hint="⌘D"
          onClick={() => {
            actions.duplicate();
            actions.close();
          }}
        />
        <MenuItem
          label={`Upscale 2×${isMultiple ? ` (${selectionCount})` : ""}`}
          onClick={() => {
            actions.upscale(frozenEntities.map((e) => e.id));
            actions.close();
          }}
        />

        <MenuSeparator />

        <MenuItem
          label={`Reset${isMultiple ? ` (${selectionCount})` : ""}`}
          onClick={() => {
            actions.reset();
            actions.close();
          }}
        />
        <MenuItem
          label={`Delete${isMultiple ? ` (${selectionCount})` : ""}`}
          destructive
          hint="⌫"
          onClick={() => {
            actions.deleteEntity();
            actions.close();
          }}
        />
      </MenuPanel>
    </Box>
  );
}
