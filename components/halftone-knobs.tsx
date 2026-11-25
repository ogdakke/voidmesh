import { HalftoneKind, HALFTONE_KIND_OPTIONS, type HalftoneParams } from "#types/canvas.ts";
import { useCanvasCommands, useSelectionState } from "#context/use-canvas.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { config } from "#config";
import { undo } from "#lib/undo.ts";
import { ContextMenu } from "@base-ui/react/context-menu";
import { NavArrowRight, Circle } from "iconoir-react";
import { Select, SelectItem } from "./ui/select/index.tsx";
import { Slider } from "./ui/slider/index.tsx";

const SIDE_OFFSET = 4;

type PrintKnob = Exclude<keyof HalftoneParams, "kind">;

const PRINT_SLIDERS: {
  key: PrintKnob;
  label: string;
  range: { min: number; max: number; step: number };
}[] = [
  { key: "angle", label: "Screen Angle", range: config.shaderParams.angle },
  { key: "dotGain", label: "Dot Gain", range: config.shaderParams.dotGain },
  { key: "paper", label: "Paper", range: config.shaderParams.paper },
  { key: "misregistration", label: "Misregistration", range: config.shaderParams.misregistration },
];

function PrintSlider({ knob }: { knob: (typeof PRINT_SLIDERS)[number] }) {
  const { updateSelectedEntityParams } = useCanvasCommands();
  const param = useParamValue(
    `halftone.${knob.key}`,
    config.defaults.shaderParams.halftone[knob.key],
  );

  if (!param.isSupported) return null;

  return (
    <div className="sidebar-row">
      <Slider
        name={`halftone-${knob.key}`}
        label={param.isMixed ? `${knob.label} (Mixed)` : knob.label}
        min={knob.range.min}
        max={knob.range.max}
        step={knob.range.step}
        value={param.value}
        onValueChange={(value: number) =>
          updateSelectedEntityParams({ halftone: { [knob.key]: value } })
        }
        onInteractionStart={() => undo.beginTransaction()}
        onValueCommitted={() => undo.commitTransaction()}
        showValue={!param.isMixed}
      />
    </div>
  );
}

// ============ SIDEBAR VERSION ============
export function HalftoneParamsControl() {
  const { changeHalftoneKind } = useCanvasCommands();
  const halftoneKind = useParamValue("halftone.kind", config.defaults.shaderParams.halftone.kind);

  if (!halftoneKind.isSupported) return null;

  return (
    <>
      <div className="sidebar-row">
        <Select
          name="halftone-kind"
          label="Screen"
          value={halftoneKind.isMixed ? "Mixed" : halftoneKind.value}
          onValueChange={changeHalftoneKind}
          items={HALFTONE_KIND_OPTIONS}
        >
          {HALFTONE_KIND_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </Select>
      </div>
      {PRINT_SLIDERS.map((knob) => (
        <PrintSlider key={knob.key} knob={knob} />
      ))}
    </>
  );
}

// ============ CONTEXT MENU VERSION ============
export function HalftoneMenuKnobs() {
  const { changeHalftoneKind } = useCanvasCommands();
  const selectionState = useSelectionState();
  const isMultiple = selectionState.isMultiple;
  const halftoneKind = useParamValue("halftone.kind", config.defaults.shaderParams.halftone.kind);

  if (!halftoneKind.isSupported) return null;

  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
        Halftone Screen
        <NavArrowRight />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
          <ContextMenu.Popup className="menu-submenu-popup">
            {isMultiple && halftoneKind.isMixed && (
              <ContextMenu.Group>
                <ContextMenu.GroupLabel className="menu-group-label">
                  Selection screens
                </ContextMenu.GroupLabel>
                {[...halftoneKind.values].map((kind) => (
                  <ContextMenu.Item key={kind} className="menu-item" disabled>
                    {HALFTONE_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind}
                  </ContextMenu.Item>
                ))}
                <ContextMenu.Separator className="menu-separator" />
              </ContextMenu.Group>
            )}

            <ContextMenu.RadioGroup
              value={
                halftoneKind.isMixed ? undefined : (halftoneKind.value ?? HalftoneKind.classic)
              }
            >
              {HALFTONE_KIND_OPTIONS.map((option) => (
                <ContextMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  className="menu-radio-item"
                  onClick={() => changeHalftoneKind(option.value)}
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
