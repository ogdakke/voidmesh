import { useRef, useState, useEffect, type PropsWithChildren } from "react";
import { cssToOklch, MAX_CHROMA, oklchToCss, type OklchColor } from "#lib/color-utils.ts";
import { ColorSpace } from "#types/enums.ts";
import { colorAreaGpu } from "./color-area-gpu";
import { ColorPickerContext, type ColorPickerContextValue } from "./use-color-picker";

export interface ColorPickerRootProps {
  /** CSS color string, e.g. "color(display-p3 0.5 0.3 0.8 / 0.5)" or "#ff0000" */
  value: string;
  onChange: (css: string) => void;
  onChangeStart?: () => void;
  onChangeEnd?: () => void;
  disabled?: boolean;
  /** Color space for CSS output (default: srgb) */
  colorSpace?: ColorSpace;
}

export function Root({
  value,
  onChange,
  onChangeStart,
  onChangeEnd,
  disabled = false,
  colorSpace = ColorSpace.srgb,
  children,
}: PropsWithChildren<ColorPickerRootProps>) {
  const [oklch, setOklchState] = useState<OklchColor>(() => cssToOklch(value));

  // Ref tracks latest oklch — source of truth during scrubbing
  const oklchRef = useRef(oklch);

  const isInteractingRef = useRef(false);
  const lastEmittedRef = useRef(value);
  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line react-hooks-js/refs -- callback ref pattern
  onChangeRef.current = onChange;
  const onChangeEndRef = useRef(onChangeEnd);
  // oxlint-disable-next-line react-hooks-js/refs -- callback ref pattern
  onChangeEndRef.current = onChangeEnd;

  // ── Element registry for imperative DOM updates during scrubbing ────

  const elementsRef = useRef(new Map<string, HTMLElement>());

  const registerElement = (key: string, el: HTMLElement | null) => {
    if (el) elementsRef.current.set(key, el);
    else elementsRef.current.delete(key);
  };

  // ── Imperative DOM broadcast (zero React re-renders) ───────────────

  const prevHueRef = useRef(oklch.h);

  const broadcastToDOM = (color: OklchColor) => {
    const elements = elementsRef.current;

    // Color area thumb
    const area = elements.get("area");
    if (area) {
      area.style.setProperty("--x", String(Math.min(1, color.c / MAX_CHROMA)));
      area.style.setProperty("--y", String(1 - color.l));
    }

    // Hue slider
    const hue = elements.get("hue");
    if (hue) {
      hue.style.setProperty("--position", String(color.h / 360));
    }

    // Alpha slider (thumb + gradient CSS variables)
    const alpha = elements.get("alpha");
    if (alpha) {
      alpha.style.setProperty("--position", String(color.a));
      alpha.style.setProperty("--l", String(color.l));
      alpha.style.setProperty("--c", String(color.c));
      alpha.style.setProperty("--h", String(color.h));
    }

    // Swatch — use CSS oklch() for native gamut mapping
    const swatch = elements.get("swatch");
    if (swatch) {
      swatch.style.setProperty(
        "--swatch-bg",
        `oklch(${color.l} ${color.c} ${color.h} / ${color.a})`,
      );
    }

    // Color area canvas — redraw via GPU when hue changes
    if (color.h !== prevHueRef.current) {
      prevHueRef.current = color.h;
      const canvas = elements.get("area-canvas");
      if (canvas instanceof HTMLCanvasElement) {
        colorAreaGpu.render(canvas, color.h);
      }
    }
  };

  // ── Sync external value → internal OKLCH (only when not interacting) ──

  useEffect(() => {
    if (isInteractingRef.current || value === lastEmittedRef.current) return;

    const parsed = cssToOklch(value);

    // The parent may reformat our emitted CSS (e.g. strip trailing zeros
    // from toFixed output: "0.5000" → "0.5"). Parse both strings to OKLCH
    // and compare directly — this avoids the lossy round-trip through
    // oklchToCss() which re-runs gamut clamping and can diverge due to
    // floating-point precision in the conversion matrices.
    const lastParsed = cssToOklch(lastEmittedRef.current);
    if (
      parsed.l === lastParsed.l &&
      parsed.c === lastParsed.c &&
      parsed.h === lastParsed.h &&
      parsed.a === lastParsed.a
    ) {
      lastEmittedRef.current = value;
      return;
    }

    // Genuinely different external value — accept it
    lastEmittedRef.current = value;
    setOklchState(parsed);
    oklchRef.current = parsed;
  }, [value]);

  // ── rAF-throttled emission: at most one onChange per frame ─────────

  const pendingEmitRef = useRef<OklchColor | null>(null);
  const rafIdRef = useRef(0);

  const scheduleEmit = (color: OklchColor) => {
    pendingEmitRef.current = color;
    if (rafIdRef.current === 0) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        const pending = pendingEmitRef.current;
        pendingEmitRef.current = null;
        if (pending !== null) {
          const css = oklchToCss(pending, colorSpace);
          lastEmittedRef.current = css;
          onChangeRef.current(css);
        }
      });
    }
  };

  // ── Actions ─────────────────────────────────────────────────────────

  const setChannel = (channel: "l" | "c" | "h" | "a", v: number) => {
    const next = { ...oklchRef.current, [channel]: v };
    oklchRef.current = next;

    if (isInteractingRef.current) {
      // Hot path: imperative DOM updates, no React re-render
      broadcastToDOM(next);
    } else {
      setOklchState(next);
    }
    scheduleEmit(next);
  };

  const setOklch = (color: OklchColor) => {
    oklchRef.current = color;

    if (isInteractingRef.current) {
      broadcastToDOM(color);
    } else {
      setOklchState(color);
    }
    scheduleEmit(color);
  };

  const setCssValue = (css: string) => {
    const parsed = cssToOklch(css);
    oklchRef.current = parsed;
    setOklchState(parsed);
    scheduleEmit(parsed);
  };

  const startCssRef = useRef("");

  const startInteraction = () => {
    if (!isInteractingRef.current) {
      isInteractingRef.current = true;
      prevHueRef.current = oklchRef.current.h;
      startCssRef.current = oklchToCss(oklchRef.current, colorSpace);
      onChangeStart?.();
    }
  };

  const endInteraction = () => {
    if (isInteractingRef.current) {
      isInteractingRef.current = false;

      // Flush any pending rAF emission immediately
      if (rafIdRef.current !== 0) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      const pending = pendingEmitRef.current ?? oklchRef.current;
      pendingEmitRef.current = null;
      const css = oklchToCss(pending, colorSpace);
      lastEmittedRef.current = css;

      // Only emit if the color actually changed during this interaction
      if (css !== startCssRef.current) {
        onChangeRef.current(css);
      }

      // Sync React state for the final render
      setOklchState(oklchRef.current);

      onChangeEndRef.current?.();
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== 0) cancelAnimationFrame(rafIdRef.current);
      if (isInteractingRef.current) onChangeEndRef.current?.();
    };
  }, []);

  // ── Context value ─────────────────────────────────────────────────

  const cssValue = oklchToCss(oklch, colorSpace);

  const ctx: ColorPickerContextValue = {
    state: { oklch, cssValue },
    actions: { setChannel, setOklch, setCssValue, startInteraction, endInteraction },
    meta: { isDisabled: disabled, colorSpace },
    registerElement,
  };

  return <ColorPickerContext value={ctx}>{children}</ColorPickerContext>;
}
