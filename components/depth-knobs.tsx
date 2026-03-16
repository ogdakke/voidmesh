import { useState } from "react";
import { useCanvas } from "../context/use-canvas.ts";
import { useCanvasActions, useParamValue } from "../hooks/use-canvas-actions.ts";
import { Slider } from "./ui/slider/index.tsx";
import { Toggle } from "./ui/toggle/index.tsx";
import { Button } from "./ui/button/index.tsx";
import { undo } from "#lib/undo.ts";
import { config } from "#config";

const depthDefaults = config.defaults.shaderParams.depth!;

export function DepthKnobs() {
  const { estimateDepth, hasDepthMap, clearDepthMap, updateSelectedEntityParams } = useCanvas();
  const { selectedEntity, selectionState } = useCanvasActions();
  const depthInfluence = useParamValue("depth.influence", depthDefaults.influence);
  const depthInvert = useParamValue("depth.invert", depthDefaults.invert);
  const depthShowDepth = useParamValue("depth.showDepth", false);
  const [isEstimating, setIsEstimating] = useState(false);

  if (selectionState.isEmpty || !selectedEntity) return null;

  const entityId = selectedEntity.id;
  const hasDepth = hasDepthMap(entityId);

  const handleEstimateDepth = async () => {
    setIsEstimating(true);
    try {
      await estimateDepth(entityId);
    } finally {
      setIsEstimating(false);
    }
  };

  const handleClearDepth = () => {
    clearDepthMap(entityId);
  };

  const handleInfluenceChange = (value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined) {
      updateSelectedEntityParams({ depth: { influence: val } });
    }
  };

  const handleInvertChange = (pressed: boolean) => {
    updateSelectedEntityParams({ depth: { invert: pressed } });
  };

  const handleShowDepthChange = (pressed: boolean) => {
    updateSelectedEntityParams({ depth: { showDepth: pressed } });
  };

  return (
    <>
      <div className="sidebar-row">
        {!hasDepth ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={handleEstimateDepth}
            disabled={isEstimating}
          >
            {isEstimating ? "Estimating..." : "Generate Depth Map"}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={handleClearDepth}>
            Clear Depth Map
          </Button>
        )}
      </div>
      {hasDepth && (
        <>
          <div className="sidebar-row">
            <Slider
              name="depth-influence"
              label={depthInfluence.isMixed ? "Influence (Mixed)" : "Influence"}
              min={config.shaderParams.depthInfluence.min}
              max={config.shaderParams.depthInfluence.max}
              step={config.shaderParams.depthInfluence.step}
              value={depthInfluence.value}
              onValueChange={handleInfluenceChange}
              onInteractionStart={() => undo.beginTransaction()}
              onValueCommitted={() => undo.commitTransaction()}
              showValue={!depthInfluence.isMixed}
            />
          </div>
          <div className="sidebar-row palette-toggles">
            <Toggle
              pressed={!!depthInvert.value}
              onPressedChange={handleInvertChange}
              title="Invert depth mapping"
            >
              Invert
            </Toggle>
            <Toggle
              pressed={!!depthShowDepth.value}
              onPressedChange={handleShowDepthChange}
              title="Visualize depth map"
            >
              Visualize
            </Toggle>
          </div>
        </>
      )}
    </>
  );
}
