import { useSyncExternalStore } from "react";
import { canvasStore, type ActionLayerSnapshot } from "#engine";

export function useActionLayer(): ActionLayerSnapshot {
  return useSyncExternalStore(canvasStore.subscribe, canvasStore.getActionLayerSnapshot);
}
