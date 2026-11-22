import { useEffect, useRef } from "react";
import { cancelDisplayFrame, requestDisplayFrame } from "#lib/display-clock.ts";
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
 * Slider for shader time that drives the InfiniteSlider imperatively
 * at the display rate during autoplay — zero React re-renders while playing.
 */
export function TimeSlider({
  entity,
  isAutoPlaying,
  entityTime,
  onInteractionStart,
  onValueChange,
  onValueCommit,
  ...props
}: TimeSliderProps) {
  const driveRef = useRef<InfiniteSliderDriveHandle | null>(null);

  // Drive slider every display frame — no React re-renders.
  // Reads entity.shaderParams.time directly (mutated in-place by shader).
  useEffect(() => {
    if (!isAutoPlaying || !entity) return;
    let rafId: number;
    const tick = () => {
      driveRef.current?.driveValue(entity.shaderParams.time ?? 0);
      rafId = requestDisplayFrame(tick);
    };
    rafId = requestDisplayFrame(tick);
    return () => {
      cancelDisplayFrame(rafId);
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
}
