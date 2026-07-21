import { createContext, use } from "react";

export interface LayoutContextValue {
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  setFullscreen: (value: boolean) => void;
  registerPanelToggle: (toggle: (() => void) | null) => void;
}

export const LayoutContext = createContext<LayoutContextValue>({
  isFullscreen: false,
  toggleFullscreen: () => {},
  setFullscreen: () => {},
  registerPanelToggle: () => {},
});

export function useLayout() {
  return use(LayoutContext);
}
