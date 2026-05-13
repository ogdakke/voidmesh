import { type RefObject, useEffect, useRef } from "react";
import { canvasStore, gameLoop } from "../engine/index.ts";
import { panTrace } from "#lib/pan-trace.ts";

/**
 * Observes canvas container size changes, adjusts the viewport to keep the
 * world-space center stable, and marks the canvas as needing re-render.
 */
export function useCanvasContainerResize(containerRef: RefObject<HTMLDivElement | null>): void {
  const prevSizeRef = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const handleResize = () => {
      if (!element) return;

      const newWidth = element.clientWidth;
      const newHeight = element.clientHeight;
      const prevSize = prevSizeRef.current;
      const viewportInteractionActive = gameLoop.isViewportInteractionActive();

      if (
        panTrace.enabled &&
        prevSize &&
        (prevSize.width !== newWidth || prevSize.height !== newHeight)
      ) {
        panTrace.record("containerResize", {
          prevSize,
          newSize: { width: newWidth, height: newHeight },
          viewportInteractionActive,
          viewport: canvasStore.getViewport(),
        });
      }

      // Adjust viewport offset so the world-space center stays fixed.
      // During viewport gestures, keep the top-left anchor stable so iOS
      // dynamic viewport resizes cannot inject a competing pan delta.
      if (
        prevSize &&
        (prevSize.width !== newWidth || prevSize.height !== newHeight) &&
        !viewportInteractionActive
      ) {
        const dpr = window.devicePixelRatio;
        const { zoom } = canvasStore.getViewport();
        const dx = ((prevSize.width - newWidth) * dpr) / (2 * zoom);
        const dy = ((prevSize.height - newHeight) * dpr) / (2 * zoom);
        canvasStore.panBy({ x: dx, y: dy });
      }

      prevSizeRef.current = { width: newWidth, height: newHeight };
      canvasStore.setContainerDirty();
    };

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        handleResize();
      });
      observer.observe(element, { box: "border-box" });

      return () => {
        observer.disconnect();
      };
    }

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [containerRef]);
}
