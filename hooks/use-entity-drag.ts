import { useSyncExternalStore } from "react";
import { canvasStore } from "#engine";
import type { DragSnapshot } from "#engine";

export function useEntityDrag(): DragSnapshot {
  return useSyncExternalStore(canvasStore.subscribe, canvasStore.getDragSnapshot);
}
