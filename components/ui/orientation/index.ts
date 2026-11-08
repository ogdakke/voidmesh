import { createContext, use } from "react";

export type Orientation = "horizontal" | "vertical";

/**
 * Default axis for scrollable controls (SliderPicker, InfiniteSlider) below this provider.
 * Lets a layout flip a whole control panel without threading a prop through every knob.
 */
export const OrientationContext = createContext<Orientation>("horizontal");

export function useOrientation(override?: Orientation): Orientation {
  const inherited = use(OrientationContext);
  return override ?? inherited;
}
