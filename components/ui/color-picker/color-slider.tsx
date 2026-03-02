import { useRef, useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { useColorPicker, useRegisterElement } from "./use-color-picker";
import { Field } from "#ui/field/field.tsx";
import type { FieldRootProps } from "@base-ui/react";

interface SliderBaseProps extends FieldRootProps {
  channel: "h" | "a";
  min: number;
  max: number;
  step: number;
  label: string;
  registryKey: string;
}

function SliderBase({
  channel,
  min,
  max,
  step,
  label,
  registryKey,
  children,
  ...props
}: SliderBaseProps) {
  const {
    state: { oklch },
    actions: { setChannel, startInteraction, endInteraction },
  } = useColorPicker();

  const trackRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const cachedRect = useRef<DOMRect | null>(null);
  const value = oklch[channel];

  // Register element for imperative scrubbing updates
  useRegisterElement(registryKey, trackRef);

  // Prevent drawer's drag-to-dismiss from capturing touch events during slider interaction
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (isDragging.current) e.stopPropagation();
    };
    const stopStart = (e: TouchEvent) => e.stopPropagation();
    el.addEventListener("touchstart", stopStart, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    return () => {
      el.removeEventListener("touchstart", stopStart);
      el.removeEventListener("touchmove", stop);
    };
  }, []);

  const updateFromPointer = (clientX: number) => {
    const rect = cachedRect.current;
    if (!rect) return;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setChannel(channel, min + frac * (max - min));
  };

  const handlePointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    trackRef.current?.focus();
    isDragging.current = true;
    cachedRect.current = trackRef.current?.getBoundingClientRect() ?? null;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    startInteraction();
    updateFromPointer(e.clientX);
  };

  const handlePointerMove = (e: ReactPointerEvent) => {
    if (!isDragging.current) return;
    updateFromPointer(e.clientX);
  };

  const handlePointerUp = (e: ReactPointerEvent) => {
    if (!isDragging.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    endInteraction();
    cachedRect.current = null;
    isDragging.current = false;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const bigStep = step * 10;
    const s = e.shiftKey ? bigStep : step;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        setChannel(channel, Math.min(max, value + s));
        break;
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        setChannel(channel, Math.max(min, value - s));
        break;
    }
  };

  const position = (value - min) / (max - min);

  return (
    <Field.Root {...props}>
      {children}
      <Field.Control
        render={(controlProps) => (
          <div
            {...controlProps}
            ref={trackRef}
            className="color-slider"
            data-channel={channel === "h" ? "hue" : "alpha"}
            role="slider"
            aria-label={label}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={Math.round(value * 100) / 100}
            tabIndex={0}
            style={
              {
                "--position": String(position),
                "--l": oklch.l,
                "--c": oklch.c,
                "--h": oklch.h,
              } as React.CSSProperties
            }
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onKeyDown={handleKeyDown}
          >
            <div className="color-slider__thumb" />
          </div>
        )}
      />
    </Field.Root>
  );
}

export function HueSlider(props: Partial<SliderBaseProps>) {
  return (
    <SliderBase {...props} min={0} max={360} step={1} label="Hue" channel="h" registryKey="hue" />
  );
}

export function AlphaSlider(props: Partial<SliderBaseProps>) {
  return (
    <SliderBase
      min={0}
      max={1}
      step={0.01}
      label="Opacity"
      {...props}
      channel="a"
      registryKey="alpha"
    />
  );
}
