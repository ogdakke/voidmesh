import { createContext, use } from "react";

export interface LayoutContextValue {
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  setFullscreen: (value: boolean) => void;
}

export const LayoutContext = createContext<LayoutContextValue>({
  isFullscreen: false,
  toggleFullscreen: () => {},
  setFullscreen: () => {},
});

export function useLayout() {
  return use(LayoutContext);
}
