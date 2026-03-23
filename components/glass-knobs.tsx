import { GlassKind, GLASS_KIND_OPTIONS } from "#types/canvas.ts";
import { useCanvasCommands, useSelectionState } from "../context/use-canvas.ts";
import { useParamValue } from "../hooks/use-param-value.ts";
import { config } from "#config";
import { ContextMenu } from "@base-ui/react/context-menu";
import { NavArrowRight, Circle } from "iconoir-react";

const SIDE_OFFSET = 4;

// ============ CONTEXT MENU VERSION ============
export function GlassMenuKnobs() {
  const { changeGlassKind } = useCanvasCommands();
  const selectionState = useSelectionState();
  const isMultiple = selectionState.isMultiple;
  const glassKind = useParamValue("glass.kind", config.defaults.shaderParams.glass!.kind);

  if (!glassKind.isSupported) return null;

  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
        Glass Type
        <NavArrowRight />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
          <ContextMenu.Popup className="menu-submenu-popup">
            {/* Show current selection's glass kinds when mixed */}
            {isMultiple && glassKind.isMixed && (
              <ContextMenu.Group>
                <ContextMenu.GroupLabel className="menu-group-label">
                  Selection glass types
                </ContextMenu.GroupLabel>
                {[...glassKind.values].map((kind) => (
                  <ContextMenu.Item key={kind} className="menu-item" disabled>
                    {GLASS_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind}
                  </ContextMenu.Item>
                ))}
                <ContextMenu.Separator className="menu-separator" />
              </ContextMenu.Group>
            )}

            <ContextMenu.RadioGroup
              value={glassKind.isMixed ? undefined : (glassKind.value ?? GlassKind.frostedVoronoi)}
            >
              {GLASS_KIND_OPTIONS.map((option) => (
                <ContextMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  className="menu-radio-item"
                  onClick={() => changeGlassKind(option.value)}
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
