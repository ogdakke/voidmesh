import { useCanvasInteraction, useEntityCount, useSelectedEntityIds } from "#context/use-canvas.ts";
import { Button } from "./ui/button";

export function MultiSelectionControls() {
  const entityCount = useEntityCount();
  const selectedEntityIds = useSelectedEntityIds();
  const interaction = useCanvasInteraction();
  const allSelected = entityCount > 0 && selectedEntityIds.size === entityCount;
  return (
    <div className="mobile-common-knobs pb-1">
      <div className="mobile-row">
        <Button
          variant="primary"
          disabled={entityCount === 0 || allSelected}
          onClick={interaction.selectAll}
        >
          Select All
        </Button>
      </div>
    </div>
  );
}
