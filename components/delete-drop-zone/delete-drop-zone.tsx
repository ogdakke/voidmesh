import { useEffect, useRef } from "react";
import { Xmark } from "iconoir-react";
import { useEntityDrag } from "#hooks/use-entity-drag.ts";
import { useActionLayer } from "#hooks/use-action-layer.ts";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";
import { haptic } from "#lib/haptic.ts";
import { canvasStore } from "#engine";
import "./delete-drop-zone.css";

/** Pixels around the drop zone that trigger proximity feedback */
const DELETE_ZONE_PROXIMITY_PX = 20;

export function DeleteDropZone() {
  const { entityDragActive } = useEntityDrag();
  const { active: actionLayerActive } = useActionLayer();
  const showZone = entityDragActive || actionLayerActive;
  const { deleteEntity } = useCanvasActions();
  const zoneRef = useRef<HTMLDivElement>(null);
  const isOverRef = useRef(false);

  useEffect(() => {
    if (!showZone) return;
    const zone = zoneRef.current;
    if (!zone) return;

    isOverRef.current = false;
    zone.removeAttribute("data-over");

    const handleTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;

      const rect = zone.getBoundingClientRect();
      const isOver =
        touch.clientY >= rect.top - DELETE_ZONE_PROXIMITY_PX &&
        touch.clientY <= rect.bottom + DELETE_ZONE_PROXIMITY_PX &&
        touch.clientX >= rect.left - DELETE_ZONE_PROXIMITY_PX &&
        touch.clientX <= rect.right + DELETE_ZONE_PROXIMITY_PX;

      if (isOver !== isOverRef.current) {
        isOverRef.current = isOver;
        if (isOver) {
          zone.setAttribute("data-over", "");
        } else {
          zone.removeAttribute("data-over");
        }
      }
    };

    const handleTouchEnd = () => {
      if (isOverRef.current) {
        haptic({ wantsHaptic: canvasStore.getState().haptics });
        deleteEntity(undefined, "drop_zone");
        isOverRef.current = false;
        zone.removeAttribute("data-over");
      }
    };

    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { capture: true });

    return () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd, { capture: true });
      zone.removeAttribute("data-over");
      isOverRef.current = false;
    };
  }, [showZone, deleteEntity]);

  return (
    <div
      ref={zoneRef}
      className="mobile-delete-drop-zone"
      data-drag-active={showZone || undefined}
      aria-label="Drop to delete"
    >
      <Xmark />
    </div>
  );
}
