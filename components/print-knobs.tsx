import { PrintKind, PRINT_KIND_OPTIONS, type PrintParams } from "#types/canvas.ts";
import { useCanvasCommands, useSelectionState } from "#context/use-canvas.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { config } from "#config";
import { undo } from "#lib/undo.ts";
import { ContextMenu } from "@base-ui/react/context-menu";
import { NavArrowRight, Circle } from "iconoir-react";
import { Select, SelectItem } from "./ui/select/index.tsx";
import { Slider } from "./ui/slider/index.tsx";

const SIDE_OFFSET = 4;

type PrintKnob = Exclude<keyof PrintParams, "kind">;

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
  const param = useParamValue(`print.${knob.key}`, config.defaults.shaderParams.print[knob.key]);

  if (!param.isSupported) return null;

  return (
    <div className="sidebar-row">
      <Slider
        name={`print-${knob.key}`}
        label={param.isMixed ? `${knob.label} (Mixed)` : knob.label}
        min={knob.range.min}
        max={knob.range.max}
        step={knob.range.step}
        value={param.value}
        onValueChange={(value: number) =>
          updateSelectedEntityParams({ print: { [knob.key]: value } })
        }
        onInteractionStart={() => undo.beginTransaction()}
        onValueCommitted={() => undo.commitTransaction()}
        showValue={!param.isMixed}
      />
    </div>
  );
}

// ============ SIDEBAR VERSION ============
export function PrintParamsControl() {
  const { changePrintKind } = useCanvasCommands();
  const printKind = useParamValue("print.kind", config.defaults.shaderParams.print.kind);

  if (!printKind.isSupported) return null;

  return (
    <>
      <div className="sidebar-row">
        <Select
          name="print-kind"
          label="Print Type"
          value={printKind.isMixed ? "Mixed" : printKind.value}
          onValueChange={changePrintKind}
          items={PRINT_KIND_OPTIONS}
        >
          {PRINT_KIND_OPTIONS.map((option) => (
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
export function PrintMenuKnobs() {
  const { changePrintKind } = useCanvasCommands();
  const selectionState = useSelectionState();
  const isMultiple = selectionState.isMultiple;
  const printKind = useParamValue("print.kind", config.defaults.shaderParams.print.kind);

  if (!printKind.isSupported) return null;

  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger className="menu-submenu-trigger">
        Print Type
        <NavArrowRight />
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="menu-positioner" sideOffset={SIDE_OFFSET}>
          <ContextMenu.Popup className="menu-submenu-popup">
            {isMultiple && printKind.isMixed && (
              <ContextMenu.Group>
                <ContextMenu.GroupLabel className="menu-group-label">
                  Selection print types
                </ContextMenu.GroupLabel>
                {[...printKind.values].map((kind) => (
                  <ContextMenu.Item key={kind} className="menu-item" disabled>
                    {PRINT_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind}
                  </ContextMenu.Item>
                ))}
                <ContextMenu.Separator className="menu-separator" />
              </ContextMenu.Group>
            )}

            <ContextMenu.RadioGroup
              value={printKind.isMixed ? undefined : (printKind.value ?? PrintKind.cmyk)}
            >
              {PRINT_KIND_OPTIONS.map((option) => (
                <ContextMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  className="menu-radio-item"
                  onClick={() => changePrintKind(option.value)}
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
