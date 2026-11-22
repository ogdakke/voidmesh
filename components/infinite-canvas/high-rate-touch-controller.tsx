import { useHighRateTouch } from "#hooks/use-high-rate-touch.ts";
import { useRef } from "react";

/** Invisible scroll area that receives canvas touches at the display rate. */
export function HighRateTouchController() {
  const controllerRef = useRef<HTMLDivElement>(null);
  useHighRateTouch(controllerRef);
  return (
    <div ref={controllerRef} className="infinite-canvas__touch-controller" aria-hidden="true">
      <div className="infinite-canvas__touch-controller-extent" />
    </div>
  );
}
