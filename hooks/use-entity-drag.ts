import { useCanvasDragSnapshot, type CanvasDragSnapshot } from "#context/use-canvas.ts";

export function useEntityDrag(): CanvasDragSnapshot {
  return useCanvasDragSnapshot();
}
