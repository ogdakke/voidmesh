import { DitheringKind, DITHERING_KIND_OPTIONS } from "#types/canvas.ts";
import { useCanvasActions, useParamValue } from "../hooks/use-canvas-actions.ts";
import { Select, SelectItem } from "./ui/select/index.tsx";
import { optionsWithNull } from "./ui/ui-util.ts";
import { config } from "#config";
import { ContextMenu } from "@base-ui/react/context-menu";
import { NavArrowRight, Circle } from "iconoir-react";

const SIDE_OFFSET = 4;

// ============ SIDEBAR VERSION ============
export function DitheringKnobs() {
  const { handleDitheringKindChange } = useCanvasActions();
  const ditheringKind = useParamValue(
    "dithering.kind",
    config.defaults.shaderParams.dithering.kind,
  );

  if (!ditheringKind.isSupported) return null;

  return (
    <div className="sidebar-row dithering-kind-row">
      <Select
        label="Algorithm"
        value={ditheringKind.isMixed ? undefined : (ditheringKind.value ?? DitheringKind.bayer4x4)}
        onValueChange={handleDitheringKindChange}
        formatValue={
          ditheringKind.isMixed ? <span className="select-mixed">Mixed</span> : undefined
        }
        name="dithering-kind"
        items={optionsWithNull({ options: DITHERING_KIND_OPTIONS })}
      >
        {DITHERING_KIND_OPTIONS.map((kind) => (
          <SelectItem key={kind.value} value={kind.value}>
            {kind.label}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}

// ============ CONTEXT MENU VERSION ============
export function DitheringMenuKnobs() {
  const { handleDitheringKindChange, selectionState } = useCanvasActions();
  const isMultiple = selectionState.isMultiple;
  const ditheringKind = useParamValue(
    "dithering.kind",
    config.defaults.shaderParams.dithering.kind,
  );

  if (!ditheringKind.isSupported) return null;

  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
        Algorithm
        <NavArrowRight />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
          <ContextMenu.Popup className="menu-submenu-popup">
            {/* Show current selection's algorithms when mixed */}
            {isMultiple && ditheringKind.isMixed && (
              <ContextMenu.Group>
                <ContextMenu.GroupLabel className="menu-group-label">
                  Selection algorithms
                </ContextMenu.GroupLabel>
                {[...ditheringKind.values].map((kind) => (
                  <ContextMenu.Item key={kind} className="menu-item" disabled>
                    {DITHERING_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind}
                  </ContextMenu.Item>
                ))}
                <ContextMenu.Separator className="menu-separator" />
              </ContextMenu.Group>
            )}

            <ContextMenu.RadioGroup
              value={
                ditheringKind.isMixed ? undefined : (ditheringKind.value ?? DitheringKind.bayer4x4)
              }
            >
              {DITHERING_KIND_OPTIONS.map((option) => (
                <ContextMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  className="menu-radio-item"
                  onClick={() => handleDitheringKindChange(option.value)}
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
  );
}
