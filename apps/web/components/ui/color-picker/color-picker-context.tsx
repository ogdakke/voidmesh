import { startTransition, useRef, useState, useEffect, type PropsWithChildren } from "react";
import { cssToOklch, MAX_CHROMA, type OklchColor } from "#lib/color-utils.ts";
import { ColorSpace } from "#types/enums.ts";
import { colorAreaGpu } from "./color-area-gpu";
import { ColorPickerContext, type ColorPickerContextValue } from "./use-color-picker";
import {
  ColorValueFormat,
  detectColorValueFormat,
  formatOklchForValueFormat,
  getAvailableColorValueFormats,
} from "./color-value-formats";

export interface ColorPickerRootProps {
  /** CSS color string, e.g. "color(display-p3 0.5 0.3 0.8 / 0.5)" or "#ff0000" */
  value: string;
  onChange: (css: string) => void;
  onChangeStart?: () => void;
  onChangeEnd?: () => void;
  disabled?: boolean;
  /** Picker capability hint used to enable Display P3-specific UI/output */
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
  const supportsP3 = colorSpace === ColorSpace.displayP3;
  const availableFormats = getAvailableColorValueFormats({ supportsP3 }).map(
    (definition) => definition.id,
  );
  const getInitialSelectedFormat = () =>
    detectColorValueFormat(value, { supportsP3 }) ??
    (supportsP3 ? ColorValueFormat.p3 : ColorValueFormat.hex);

  const [oklch, setOklchState] = useState<OklchColor>(() => cssToOklch(value));
  const [selectedFormat, setSelectedFormatState] = useState(getInitialSelectedFormat);

  // Ref tracks latest oklch — source of truth during scrubbing
  const oklchRef = useRef(oklch);
  const selectedFormatRef = useRef(selectedFormat);

  const isInteractingRef = useRef(false);
  const lastEmittedRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onChangeEndRef = useRef(onChangeEnd);

  useEffect(() => {
    onChangeRef.current = onChange;
    onChangeEndRef.current = onChangeEnd;
  }, [onChange, onChangeEnd]);

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
    oklchRef.current = parsed;
    startTransition(() => {
      setOklchState(parsed);
    });
  }, [value]);

  useEffect(() => {
    const nextFormat = supportsP3 ? selectedFormatRef.current : ColorValueFormat.hex;
    if (selectedFormatRef.current === nextFormat) return;
    selectedFormatRef.current = nextFormat;
    startTransition(() => {
      setSelectedFormatState(nextFormat);
    });
  }, [supportsP3]);

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
          const css = formatOklchForValueFormat(pending, selectedFormatRef.current);
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

  const setCssValue = (css: string, color?: OklchColor) => {
    const nextColor = color ?? cssToOklch(css);
    oklchRef.current = nextColor;
    setOklchState(nextColor);
    scheduleEmit(nextColor);
  };

  const setSelectedFormat = (format: ColorValueFormat) => {
    if (!availableFormats.includes(format) || selectedFormatRef.current === format) return;
    selectedFormatRef.current = format;
    setSelectedFormatState(format);
  };

  const startCssRef = useRef("");

  const startInteraction = () => {
    if (!isInteractingRef.current) {
      isInteractingRef.current = true;
      prevHueRef.current = oklchRef.current.h;
      startCssRef.current = formatOklchForValueFormat(oklchRef.current, selectedFormatRef.current);
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
      const css = formatOklchForValueFormat(pending, selectedFormatRef.current);
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

  const cssValue = formatOklchForValueFormat(oklch, selectedFormat);

  const ctx: ColorPickerContextValue = {
    state: { oklch, cssValue },
    actions: {
      setChannel,
      setOklch,
      setCssValue,
      setSelectedFormat,
      startInteraction,
      endInteraction,
    },
    meta: { isDisabled: disabled, supportsP3, selectedFormat, availableFormats },
    registerElement,
  };

  return <ColorPickerContext value={ctx}>{children}</ColorPickerContext>;
}
