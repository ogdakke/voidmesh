import { createContext, use } from "react";
import type { Orientation } from "../orientation/index.ts";

interface SliderPickerContextValue {
  orientation: Orientation;
  value: string;
  centeredValue: string;
  registerItem: (value: string, element: HTMLDivElement) => void;
  unregisterItem: (value: string) => void;
  scrollToItem: (value: string) => void;
  optionsRef: React.RefObject<HTMLDivElement | null>;
}

export const SliderPickerContext = createContext<SliderPickerContextValue | null>(null);

export function useSliderPickerContext() {
  const context = use(SliderPickerContext);
  if (!context) {
    throw new Error("SliderPicker components must be used within SliderPicker");
  }
  return context;
}

/** Hook to get the currently centered value (for custom rendering) */
export function useSliderPickerCenteredValue(): string {
  return useSliderPickerContext().centeredValue;
}

/** Hook to get the scroll container ref (for custom scroll-based effects) */
export function useSliderPickerOptionsRef(): React.RefObject<HTMLDivElement | null> {
  return useSliderPickerContext().optionsRef;
}
