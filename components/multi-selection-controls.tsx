import { useEntityCount, useSelectedEntityIds } from "#context/use-canvas.ts";
import { canvasStore } from "#engine";
import { Button } from "./ui/button";

export function MultiSelectionControls() {
  const entityCount = useEntityCount();
  const selectedEntityIds = useSelectedEntityIds();
  const allSelected = entityCount > 0 && selectedEntityIds.size === entityCount;
  return (
    <div className="mobile-common-knobs pb-1">
      <div className="mobile-row">
        <Button
          variant="primary"
          disabled={entityCount === 0 || allSelected}
          onClick={() => {
            const allIds = [...canvasStore.getState().entities.keys()];
            if (allIds.length > 0) {
              canvasStore.replaceSelection(allIds);
            }
          }}
        >
          Select All
        </Button>
      </div>
    </div>
  );
}
