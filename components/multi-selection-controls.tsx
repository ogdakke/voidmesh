import { useCanvas } from "#context/use-canvas.ts";
import { canvasStore } from "#engine";
import { Button } from "./ui/button";

export function MultiSelectionControls() {
  const { entities, selectedEntityIds } = useCanvas();
  const allSelected = entities.length > 0 && selectedEntityIds.size === entities.length;
  return (
    <div className="mobile-common-knobs pb-1">
      <div className="mobile-row">
        <Button
          variant="primary"
          disabled={entities.length === 0 || allSelected}
          onClick={() => {
            const allIds = entities.map((e) => e.id);
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
