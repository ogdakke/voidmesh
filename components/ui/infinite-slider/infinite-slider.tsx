import { useEffect, useRef, type ComponentProps } from "react";
import { resolveCssVarColor } from "#lib/css.ts";
import { SliderEngine } from "./slider-engine.ts";
import {
  renderSliderTicks,
  defaultRenderConfig,
  type SliderRenderConfig,
} from "./slider-renderer.ts";
import "./infinite-slider.css";

export interface InfiniteSliderDriveHandle {
  driveValue(value: number): void;
}

export interface InfiniteSliderProps extends ComponentProps<"div"> {
  /** Current value. @default 0 */
  value?: number;
  /** Called when the derived integer value changes during scroll. */
  onValueChange?: (value: number) => void;
  /** Called when scroll settles on a final value. */
  onValueCommit?: (value: number) => void;
  /** Called when user starts interacting. */
  onInteractionStart?: () => void;
  /** Debounce for onValueChange in ms. @default 0 */
  changeDelay?: number;
  /** Debounce for onValueCommit in ms. @default 150 */
  commitDelay?: number;

  /** Lower bound. Omit for infinite mode. */
  min?: number;
  /** Upper bound. Omit for infinite mode. */
  max?: number;

  /** Value increment per tick. @default 1 */
  step?: number;
  /** Pixels between tick centers. @default 5 */
  tickSpacing?: number;
  /** Pixels of drag per step. Defaults to tickSpacing. */
  pixelsPerStep?: number;

  /** Exponential falloff rate. @default 0.06 */
  falloff?: number;
  /** Minimum scale for distant ticks. @default 0.4 */
  minScale?: number;
  /** Maximum scale for center tick. @default 1.0 */
  maxScale?: number;

  /** Override tick color (defaults to CSS --slider-tick-color). */
  tickColor?: string;
  /** Override highlight tick color (defaults to CSS --slider-highlight-color). */
  highlightColor?: string;

  /** Major tick interval (every Nth visible tick). 0 disables. @default 10 */
  majorTickInterval?: number;
  /** Override major tick color (defaults to CSS --slider-major-tick-color). */
  majorTickColor?: string;

  /** Imperative handle ref for external value driving (bypasses React re-renders). */
  driveRef?: React.RefObject<InfiniteSliderDriveHandle | null>;

  /** Accessible label for the slider. */
  ariaLabel?: string;
  /** ID of the element that labels this slider. */
  ariaLabelledBy?: string;
}

export function InfiniteSlider({
  value = 0,
  onValueChange,
  onValueCommit,
  onInteractionStart,
  changeDelay = 0,
  commitDelay = 150,
  min,
  max,
  step = 1,
  tickSpacing = 5,
  pixelsPerStep: pixelsPerStepProp,
  falloff = 0.06,
  minScale = 0.4,
  maxScale = 1.0,
  tickColor: tickColorProp,
  highlightColor: highlightColorProp,
  majorTickInterval = 10,
  driveRef,
  majorTickColor: majorTickColorProp,
  ariaLabel,
  ariaLabelledBy,
  ...props
}: InfiniteSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<SliderEngine | null>(null);
  const renderConfigRef = useRef<SliderRenderConfig>({
    ...defaultRenderConfig,
  });

  // Keep callbacks in a ref to avoid engine re-creation
  const callbacksRef = useRef({
    onValueChange,
    onValueCommit,
    onInteractionStart,
  });
  callbacksRef.current = {
    onValueChange,
    onValueCommit,
    onInteractionStart,
  };

  // Update visual config when props change
  useEffect(() => {
    renderConfigRef.current.falloff = falloff;
    renderConfigRef.current.minScale = minScale;
    renderConfigRef.current.maxScale = maxScale;
    renderConfigRef.current.tickSpacing = tickSpacing;
    renderConfigRef.current.majorTickInterval = majorTickInterval;
    renderConfigRef.current.minTick = min != null ? Math.ceil(min / step) : null;
    renderConfigRef.current.maxTick = max != null ? Math.floor(max / step) : null;
  }, [falloff, minScale, maxScale, tickSpacing, min, max, step, majorTickInterval]);

  // Resolve CSS colors + listen for theme changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const resolveColors = () => {
      // Prop overrides take priority
      if (tickColorProp) {
        renderConfigRef.current.tickColor = tickColorProp;
      } else {
        const resolved = resolveCssVarColor("--slider-tick-color", el);
        if (resolved) renderConfigRef.current.tickColor = resolved;
      }

      if (highlightColorProp) {
        renderConfigRef.current.highlightColor = highlightColorProp;
      } else {
        const resolved = resolveCssVarColor("--slider-highlight-color", el);
        if (resolved) renderConfigRef.current.highlightColor = resolved;
      }

      if (majorTickColorProp) {
        renderConfigRef.current.majorTickColor = majorTickColorProp;
      } else {
        const resolved = resolveCssVarColor("--slider-major-tick-color", el);
        if (resolved) renderConfigRef.current.majorTickColor = resolved;
      }

      // Re-render with new colors
      const engine = engineRef.current;
      const canvas = canvasRef.current;
      if (engine && canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          renderSliderTicks(
            ctx,
            canvas.clientWidth,
            canvas.clientHeight,
            window.devicePixelRatio || 1,
            engine.getOffset(),
            renderConfigRef.current,
          );
        }
      }
    };

    resolveColors();

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", resolveColors);
    return () => mq.removeEventListener("change", resolveColors);
  }, [tickColorProp, highlightColorProp, majorTickColorProp]);

  // Initialize engine
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const engine = new SliderEngine({
      step,
      tickSpacing,
      pixelsPerStep: pixelsPerStepProp,
      min: min ?? null,
      max: max ?? null,
      initialValue: value,
      changeDelay,
      commitDelay,
      onFrame: (offset) => {
        const cfg = renderConfigRef.current;
        renderSliderTicks(
          ctx,
          canvas.clientWidth,
          canvas.clientHeight,
          window.devicePixelRatio || 1,
          offset,
          cfg,
        );
      },
      onValueChange: (v) => callbacksRef.current.onValueChange?.(v),
      onValueCommit: (v) => callbacksRef.current.onValueCommit?.(v),
      onInteractionStart: () => callbacksRef.current.onInteractionStart?.(),
    });

    engineRef.current = engine;

    // Expose imperative drive handle
    if (driveRef) {
      driveRef.current = { driveValue: (v: number) => engine.driveValue(v) };
    }

    // Initial render (no animation)
    engine.setValue(value, false);

    return () => {
      engine.destroy();
      engineRef.current = null;
      if (driveRef) driveRef.current = null;
    };
    // Intentionally only re-create engine when structural props change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, tickSpacing, pixelsPerStepProp, min, max, changeDelay, commitDelay]);

  // Sync external value changes
  useEffect(() => {
    engineRef.current?.setValue(value, true);
  }, [value]);

  // Update bounds when they change (without engine re-creation)
  useEffect(() => {
    engineRef.current?.updateBounds(min ?? null, max ?? null);
  }, [min, max]);

  // ResizeObserver for canvas pixel sizing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;

      // Re-render at current offset
      const engine = engineRef.current;
      if (engine) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          renderSliderTicks(
            ctx,
            rect.width,
            rect.height,
            dpr,
            engine.getOffset(),
            renderConfigRef.current,
          );
        }
      }
    };

    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(canvas);

    // Initial size
    resizeCanvas();

    return () => observer.disconnect();
  }, []);

  // Wheel event — must be non-passive to call preventDefault
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      engineRef.current?.handleWheel(e.deltaX, e.deltaY);
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // Touch events — native listeners for iOS momentum (same pattern as wheel)
  const touchActiveRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      if (e.cancelable) {
        e.preventDefault();
      }
      touchActiveRef.current = true;
      engineRef.current?.handlePointerDown(e.touches[0]!.clientX);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!touchActiveRef.current || e.touches.length !== 1) return;
      if (e.cancelable) {
        e.preventDefault();
      }
      engineRef.current?.handlePointerMove(e.touches[0]!.clientX);
    };

    const handleTouchEnd = () => {
      if (!touchActiveRef.current) return;
      touchActiveRef.current = false;
      engineRef.current?.handlePointerUp();
    };

    canvas.addEventListener("touchstart", handleTouchStart, { passive: false });
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false });
    canvas.addEventListener("touchend", handleTouchEnd);
    canvas.addEventListener("touchcancel", handleTouchEnd);

    return () => {
      canvas.removeEventListener("touchstart", handleTouchStart);
      canvas.removeEventListener("touchmove", handleTouchMove);
      canvas.removeEventListener("touchend", handleTouchEnd);
      canvas.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, []);

  // Pointer event handlers — desktop mouse only (skipped when touch is active)
  const handlePointerDown = (e: React.PointerEvent) => {
    if (touchActiveRef.current) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    engineRef.current?.handlePointerDown(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (touchActiveRef.current) return;
    engineRef.current?.handlePointerMove(e.clientX);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (touchActiveRef.current) return;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Pointer may already be released
    }
    engineRef.current?.handlePointerUp();
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const engine = engineRef.current;
    if (!engine) return;

    const pageSteps = majorTickInterval || 10;

    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        engine.stepBy(1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        engine.stepBy(-1);
        break;
      case "PageUp":
        e.preventDefault();
        engine.stepBy(pageSteps);
        break;
      case "PageDown":
        e.preventDefault();
        engine.stepBy(-pageSteps);
        break;
      case "Home":
        if (min != null) {
          e.preventDefault();
          const currentValue = engine.getValue();
          const stepsToMin = Math.round((min - currentValue) / step);
          engine.stepBy(stepsToMin);
        }
        break;
      case "End":
        if (max != null) {
          e.preventDefault();
          const currentValue = engine.getValue();
          const stepsToMax = Math.round((max - currentValue) / step);
          engine.stepBy(stepsToMax);
        }
        break;
    }
  };

  return (
    <div
      {...props}
      ref={containerRef}
      className="infinite-slider"
      role="slider"
      tabIndex={0}
      aria-valuenow={value}
      aria-valuemin={min || undefined}
      aria-valuemax={max || undefined}
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      onKeyDown={handleKeyDown}
    >
      <canvas
        ref={canvasRef}
        className="infinite-slider__canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  );
}
