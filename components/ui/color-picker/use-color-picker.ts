import { createContext, use } from "react";
import type { ColorPickerContextValue } from "./color-picker-context";

export const ColorPickerContext = createContext<ColorPickerContextValue | null>(null);
export function useColorPicker(): ColorPickerContextValue {
  const ctx = use(ColorPickerContext);
  if (!ctx) throw new Error("useColorPicker must be used within ColorPickerProvider");
  return ctx;
}
