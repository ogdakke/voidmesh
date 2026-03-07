import { createContext, use, useEffect } from "react";
import type { OklchColor } from "#lib/color-utils.ts";
import type { ColorValueFormat } from "./color-value-formats";

export interface ColorPickerState {
  oklch: OklchColor;
  cssValue: string;
}

export interface ColorPickerActions {
  setChannel: (channel: "l" | "c" | "h" | "a", value: number) => void;
  setOklch: (oklch: OklchColor) => void;
  setCssValue: (css: string, color?: OklchColor) => void;
  setSelectedFormat: (format: ColorValueFormat) => void;
  startInteraction: () => void;
  endInteraction: () => void;
}

export interface ColorPickerMeta {
  isDisabled: boolean;
  supportsP3: boolean;
  selectedFormat: ColorValueFormat;
  availableFormats: readonly ColorValueFormat[];
}

/** Register a DOM element for imperative updates during scrubbing */
export type RegisterElement = (key: string, el: HTMLElement | null) => void;

export interface ColorPickerContextValue {
  state: ColorPickerState;
  actions: ColorPickerActions;
  meta: ColorPickerMeta;
  /** Register a DOM element for imperative updates during ref-based scrubbing */
  registerElement: RegisterElement;
}

export const ColorPickerContext = createContext<ColorPickerContextValue | null>(null);

export function useColorPicker(): ColorPickerContextValue {
  const ctx = use(ColorPickerContext);
  if (!ctx) throw new Error("useColorPicker must be used within ColorPicker.Root");
  return ctx;
}

/** Register a DOM element with the color picker for imperative scrubbing updates. */
export function useRegisterElement(key: string, ref: React.RefObject<HTMLElement | null>): void {
  const { registerElement } = useColorPicker();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    registerElement(key, el);
    return () => registerElement(key, null);
  }, [key, registerElement, ref]);
}

// ── Picker close context ──────────────────────────────────────────────
// Provided by PopoverRootInner / DrawerRootInner so presets can
// programmatically close the picker (e.g. on color removal).

export const PickerCloseContext = createContext<(() => void) | null>(null);

export function usePickerClose(): (() => void) | null {
  return use(PickerCloseContext);
}
