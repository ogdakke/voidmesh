import { GlitchKind, GLITCH_KIND_OPTIONS } from "#types/canvas.ts";
import { useCanvasActions, useParamValue } from "../hooks/use-canvas-actions.ts";
import { config } from "#config";
import { ContextMenu } from "@base-ui/react/context-menu";
import { NavArrowRight, Circle } from "iconoir-react";

const SIDE_OFFSET = 4;

// ============ CONTEXT MENU VERSION ============
export function GlitchMenuKnobs() {
  const { handleGlitchKindChange, selectionState } = useCanvasActions();
  const isMultiple = selectionState.isMultiple;
  const glitchKind = useParamValue("glitch.kind", config.defaults.shaderParams.glitch!.kind);

  if (!glitchKind.isSupported) return null;

  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
        Glitch Type
        <NavArrowRight />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
          <ContextMenu.Popup className="menu-submenu-popup">
            {isMultiple && glitchKind.isMixed && (
              <ContextMenu.Group>
                <ContextMenu.GroupLabel className="menu-group-label">
                  Selection glitch types
                </ContextMenu.GroupLabel>
                {[...glitchKind.values].map((kind) => (
                  <ContextMenu.Item key={kind} className="menu-item" disabled>
                    {GLITCH_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind}
                  </ContextMenu.Item>
                ))}
                <ContextMenu.Separator className="menu-separator" />
              </ContextMenu.Group>
            )}

            <ContextMenu.RadioGroup
              value={glitchKind.isMixed ? undefined : (glitchKind.value ?? GlitchKind.channelShift)}
            >
              {GLITCH_KIND_OPTIONS.map((option) => (
                <ContextMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  className="menu-radio-item"
                  onClick={() => handleGlitchKindChange(option.value)}
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
