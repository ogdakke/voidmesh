import { memo, useEffect, useRef } from "react";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import {
  InfiniteSlider,
  type InfiniteSliderDriveHandle,
  type InfiniteSliderProps,
} from "../infinite-slider";

export interface TimeSliderProps extends InfiniteSliderProps {
  entity: ShaderCanvasEntity | null;
  isAutoPlaying: boolean;
  entityTime: number;
  onInteractionStart?: () => void;
  onValueChange?: (value: number) => void;
  onValueCommit?: () => void;
}

/**
 * Memoized slider for shader time that drives the InfiniteSlider imperatively
 * at 60fps during autoplay — zero React re-renders while playing.
 */
export const TimeSlider = memo(function TimeSlider({
  entity,
  isAutoPlaying,
  entityTime,
  onInteractionStart,
  onValueChange,
  onValueCommit,
  ...props
}: TimeSliderProps) {
  const driveRef = useRef<InfiniteSliderDriveHandle | null>(null);

  // Drive slider at 60fps via rAF — no React re-renders.
  // Reads entity.shaderParams.time directly (mutated in-place by shader).
  useEffect(() => {
    if (!isAutoPlaying || !entity) return;
    let rafId: number;
    const tick = () => {
      driveRef.current?.driveValue(entity.shaderParams.time ?? 0);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isAutoPlaying, entity]);

  return (
    <InfiniteSlider
      {...props}
      driveRef={driveRef}
      value={entityTime}
      onInteractionStart={onInteractionStart}
      onValueChange={onValueChange}
      onValueCommit={onValueCommit}
      step={0.005}
      pixelsPerStep={0.5}
    />
  );
});
