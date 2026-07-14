import { Shape, SHAPE_OPTIONS } from "#types/canvas.ts";
import { useCanvasCommands, useSelectionState } from "#context/use-canvas.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { Select, SelectItem } from "./ui/select/index.tsx";
import { optionsWithNull } from "./ui/ui-util.ts";
import { config } from "#config";
import { ContextMenu } from "@base-ui/react/context-menu";
import { NavArrowRight, Circle } from "iconoir-react";

const SIDE_OFFSET = 4;

// ============ SIDEBAR VERSION ============
export function ShapeKnobs() {
  const { updateSelectedEntityParams } = useCanvasCommands();
  const shape = useParamValue("shape", config.defaults.shaderParams.shape);

  if (!shape.isSupported) return null;

  return (
    <div className="sidebar-row shape-row">
      <Select
        label="Shape"
        value={shape.value}
        onValueChange={(value: Shape | null) => {
          if (value) updateSelectedEntityParams({ shape: value });
        }}
        name="shape"
        items={optionsWithNull({ options: SHAPE_OPTIONS })}
        formatValue={shape.isMixed ? <span className="select-mixed">Mixed</span> : undefined}
      >
        {SHAPE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}

// ============ CONTEXT MENU VERSION ============
export function ShapeMenuKnobs() {
  const { updateSelectedEntityParams } = useCanvasCommands();
  const selectionState = useSelectionState();
  const shape = useParamValue("shape", config.defaults.shaderParams.shape);
  const isMultiple = selectionState.isMultiple;

  if (!shape.isSupported) return null;

  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
        Shape
        <NavArrowRight />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
          <ContextMenu.Popup className="menu-submenu-popup">
            {/* Show current selection's shapes when mixed */}
            {isMultiple && shape.isMixed && (
              <ContextMenu.Group>
                <ContextMenu.GroupLabel className="menu-group-label">
                  Selection shapes
                </ContextMenu.GroupLabel>
                {shape.values.values().map((s) => (
                  <ContextMenu.Item key={s} className="menu-item" disabled>
                    {SHAPE_OPTIONS.find((o) => o.value === s)?.label ?? s}
                  </ContextMenu.Item>
                ))}
                <ContextMenu.Separator className="menu-separator" />
              </ContextMenu.Group>
            )}

            <ContextMenu.RadioGroup value={shape.isMixed ? undefined : shape.value}>
              {SHAPE_OPTIONS.map((option) => (
                <ContextMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  className="menu-radio-item"
                  onClick={() => updateSelectedEntityParams({ shape: option.value })}
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
