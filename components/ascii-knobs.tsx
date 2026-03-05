import { AsciiKind, ASCII_KIND_OPTIONS } from "#types/canvas.ts";
import { useCanvasActions, useParamValue } from "../hooks/use-canvas-actions.ts";
import { Select, SelectItem } from "./ui/select/index.tsx";
import { Toggle } from "./ui/toggle/index.tsx";
import { optionsWithNull } from "./ui/ui-util.ts";
import { config } from "#config";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Brightness, NavArrowRight, Circle, Check } from "iconoir-react";

// Desktop Sidebar version
export function AsciiKnobs() {
  const { handleAsciiKindChange, handleAsciiInvertChange } = useCanvasActions();

  const asciiKind = useParamValue("ascii.kind", config.defaults.shaderParams.ascii.kind);
  const asciiInvert = useParamValue("ascii.invert", config.defaults.shaderParams.ascii.invert);

  // Only show when ascii param is supported (i.e., all selected entities are ASCII shader)
  if (!asciiKind.isSupported) return null;

  return (
    <>
      <div className="sidebar-row ascii-kind-row">
        <Select
          label="Character Set"
          value={asciiKind.isMixed ? undefined : (asciiKind.value ?? AsciiKind.standard)}
          onValueChange={handleAsciiKindChange}
          formatValue={asciiKind.isMixed ? <span className="select-mixed">Mixed</span> : undefined}
          name="ascii-kind"
          items={optionsWithNull({ options: ASCII_KIND_OPTIONS })}
        >
          {ASCII_KIND_OPTIONS.map((kind) => (
            <SelectItem key={kind.value} value={kind.value}>
              {kind.label}
            </SelectItem>
          ))}
        </Select>
      </div>
      <div className="sidebar-row ascii-invert-row">
        <Toggle
          pressed={!!asciiInvert.value}
          onPressedChange={(pressed) => {
            const newValue = asciiInvert.isMixed ? true : pressed;
            handleAsciiInvertChange(newValue);
          }}
          title="Invert brightness"
        >
          <Brightness /> Invert
        </Toggle>
      </div>
    </>
  );
}

const SIDE_OFFSET = 4;

// desktop context menu version
export function AsciiMenuKnobs() {
  const { handleAsciiKindChange, handleAsciiInvertChange, selectionState } = useCanvasActions();
  const isMultiple = selectionState.isMultiple;

  const asciiKind = useParamValue("ascii.kind", config.defaults.shaderParams.ascii.kind);
  const asciiInvert = useParamValue("ascii.invert", config.defaults.shaderParams.ascii.invert);

  // Only show when ascii param is supported
  if (!asciiKind.isSupported) return null;

  const asciiInvertMixed = isMultiple && asciiInvert.isMixed;

  return (
    <>
      {/* Character Set Submenu */}
      <ContextMenu.SubmenuRoot>
        <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
          Character Set
          <NavArrowRight />
        </ContextMenu.SubmenuTrigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
            <ContextMenu.Popup className="menu-submenu-popup">
              {/* Show current selection's character sets when mixed */}
              {isMultiple && asciiKind.isMixed && (
                <ContextMenu.Group>
                  <ContextMenu.GroupLabel className="menu-group-label">
                    Selection character sets
                  </ContextMenu.GroupLabel>
                  {[...asciiKind.values].map((kind) => (
                    <ContextMenu.Item key={kind} className="menu-item" disabled>
                      {ASCII_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind}
                    </ContextMenu.Item>
                  ))}
                  <ContextMenu.Separator className="menu-separator" />
                </ContextMenu.Group>
              )}

              <ContextMenu.RadioGroup
                value={asciiKind.isMixed ? undefined : (asciiKind.value ?? AsciiKind.standard)}
              >
                {ASCII_KIND_OPTIONS.map((option) => (
                  <ContextMenu.RadioItem
                    key={option.value}
                    value={option.value}
                    className="menu-radio-item"
                    onClick={() => handleAsciiKindChange(option.value)}
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

      {/* Invert Brightness Checkbox */}
      <ContextMenu.CheckboxItem
        className="menu-checkbox-item"
        checked={asciiInvertMixed ? false : !!asciiInvert.value}
        data-mixed={asciiInvertMixed ? "" : undefined}
        onCheckedChange={(checked) => {
          const newValue = asciiInvertMixed ? true : checked;
          handleAsciiInvertChange(newValue);
        }}
      >
        <ContextMenu.CheckboxItemIndicator className="menu-checkbox-indicator">
          <Check />
        </ContextMenu.CheckboxItemIndicator>
        Invert Brightness{asciiInvertMixed && " (Mixed)"}
      </ContextMenu.CheckboxItem>
    </>
  );
}
