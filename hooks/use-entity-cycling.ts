import type { RefObject } from "react";
import { cycleToNextEntity, cycleToPreviousEntity } from "#application/canvas/entity-cycling.ts";
import { useViewportInsets } from "#hooks/use-viewport-insets.ts";

export function useEntityCycling(containerRef: RefObject<HTMLElement | null>) {
  const insets = useViewportInsets();

  const handleCycleNext = (event: KeyboardEvent) => {
    event.preventDefault();
    cycleToNextEntity(containerRef, event.repeat, insets);
  };

  const handleCyclePrevious = (event: KeyboardEvent) => {
    event.preventDefault();
    cycleToPreviousEntity(containerRef, event.repeat, insets);
  };

  return { handleCycleNext, handleCyclePrevious };
}
