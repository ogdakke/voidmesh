import { useCanvasCommands, useSelectionState } from "#context/use-canvas.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { Slider } from "./ui/slider/index.tsx";
import { undo } from "#lib/undo.ts";
import { config } from "#config";
import type { AdjustmentsParams } from "#types/canvas.ts";

const adjustDefaults = config.defaults.shaderParams.adjustments!;

type AdjustmentKey = keyof AdjustmentsParams;

export function AdjustmentsKnobs() {
  const { updateSelectedEntityParams } = useCanvasCommands();
  const selectionState = useSelectionState();

  const brightness = useParamValue("adjustments.brightness", adjustDefaults.brightness);
  const contrast = useParamValue("adjustments.contrast", adjustDefaults.contrast);
  const saturation = useParamValue("adjustments.saturation", adjustDefaults.saturation);
  const blur = useParamValue("adjustments.blur", adjustDefaults.blur);

  const handleAdjustmentChange = (key: AdjustmentKey, value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined) {
      // Deep merge handles preserving sibling values automatically
      updateSelectedEntityParams({
        adjustments: { [key]: val },
      });
    }
  };

  if (selectionState.isEmpty) return null;

  return (
    <>
      <div className="sidebar-row">
        <Slider
          name="brightness"
          label={brightness.isMixed ? "Brightness (Mixed)" : "Brightness"}
          min={config.adjustments.brightness.min}
          max={config.adjustments.brightness.max}
          step={config.adjustments.brightness.step}
          value={brightness.value}
          onValueChange={(v) => handleAdjustmentChange("brightness", v)}
          onInteractionStart={() => undo.beginTransaction()}
          onValueCommitted={() => undo.commitTransaction()}
          showValue={!brightness.isMixed}
        />
      </div>
      <div className="sidebar-row">
        <Slider
          name="contrast"
          label={contrast.isMixed ? "Contrast (Mixed)" : "Contrast"}
          min={config.adjustments.contrast.min}
          max={config.adjustments.contrast.max}
          step={config.adjustments.contrast.step}
          value={contrast.value}
          onValueChange={(v) => handleAdjustmentChange("contrast", v)}
          onInteractionStart={() => undo.beginTransaction()}
          onValueCommitted={() => undo.commitTransaction()}
          showValue={!contrast.isMixed}
        />
      </div>
      <div className="sidebar-row">
        <Slider
          name="saturation"
          label={saturation.isMixed ? "Saturation (Mixed)" : "Saturation"}
          min={config.adjustments.saturation.min}
          max={config.adjustments.saturation.max}
          step={config.adjustments.saturation.step}
          value={saturation.value}
          onValueChange={(v) => handleAdjustmentChange("saturation", v)}
          onInteractionStart={() => undo.beginTransaction()}
          onValueCommitted={() => undo.commitTransaction()}
          showValue={!saturation.isMixed}
        />
      </div>
      <div className="sidebar-row">
        <Slider
          name="blur"
          label={blur.isMixed ? "Blur (Mixed)" : "Blur"}
          min={config.adjustments.blur.min}
          max={config.adjustments.blur.max}
          step={config.adjustments.blur.step}
          value={blur.value}
          onValueChange={(v) => handleAdjustmentChange("blur", v)}
          onInteractionStart={() => undo.beginTransaction()}
          onValueCommitted={() => undo.commitTransaction()}
          showValue={!blur.isMixed}
        />
      </div>
    </>
  );
}
