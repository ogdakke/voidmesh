import { config } from "#config";
import { NO_VIEWPORT_INSETS } from "#lib/canvas-math.ts";
import type { ViewportInsets } from "#types/canvas.ts";
import { useIsCompactLandscape, useIsMobile } from "./use-is-mobile.ts";

const PORTRAIT_INSETS: ViewportInsets = Object.freeze({
  bottom: config.canvas.mobile.bottomInset,
  right: 0,
});

const LANDSCAPE_INSETS: ViewportInsets = Object.freeze({
  bottom: 0,
  right: config.canvas.mobile.rightInset,
});

/** Canvas edges covered by mobile controls: bottom stack in portrait, right rail in landscape. */
export function useViewportInsets(): ViewportInsets {
  const isMobile = useIsMobile();
  const isLandscape = useIsCompactLandscape();
  if (!isMobile) return NO_VIEWPORT_INSETS;
  return isLandscape ? LANDSCAPE_INSETS : PORTRAIT_INSETS;
}
