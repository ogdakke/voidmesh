import type { RefObject } from "react";
import { cycleToNextEntity, cycleToPreviousEntity } from "#application/canvas/entity-cycling.ts";
import { config } from "#config";
import { useIsMobile } from "#hooks/use-is-mobile.ts";

export function useEntityCycling(containerRef: RefObject<HTMLElement | null>) {
  const bottomInset = useIsMobile() ? config.canvas.mobile.bottomInset : 0;

  const handleCycleNext = (event: KeyboardEvent) => {
    event.preventDefault();
    cycleToNextEntity(containerRef, event.repeat, bottomInset);
  };

  const handleCyclePrevious = (event: KeyboardEvent) => {
    event.preventDefault();
    cycleToPreviousEntity(containerRef, event.repeat, bottomInset);
  };

  return { handleCycleNext, handleCyclePrevious };
}
