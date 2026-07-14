import { type RefObject, useEffect, useRef } from "react";
import { useCanvasInteraction } from "#context/use-canvas.ts";

/**
 * Observes canvas container size changes, adjusts the viewport to keep the
 * world-space center stable, and marks the canvas as needing re-render.
 */
export function useCanvasContainerResize(containerRef: RefObject<HTMLDivElement | null>): void {
  const prevSizeRef = useRef<{ width: number; height: number } | null>(null);
  const interaction = useCanvasInteraction();

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const handleResize = () => {
      if (!element) return;

      const newWidth = element.clientWidth;
      const newHeight = element.clientHeight;
      const prevSize = prevSizeRef.current;

      interaction.resizeSurface(
        prevSize,
        { width: newWidth, height: newHeight },
        window.devicePixelRatio,
      );
      prevSizeRef.current = { width: newWidth, height: newHeight };
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
  }, [containerRef, interaction]);
}
