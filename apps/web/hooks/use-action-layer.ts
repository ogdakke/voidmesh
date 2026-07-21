import {
  useCanvasActionLayerSnapshot,
  type CanvasActionLayerSnapshot,
} from "#context/use-canvas.ts";

export function useActionLayer(): CanvasActionLayerSnapshot {
  return useCanvasActionLayerSnapshot();
}
