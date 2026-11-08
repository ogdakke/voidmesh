import useMediaQuery from "./use-media-query";

export function useIsMobile() {
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const isLandscape = useMediaQuery("(orientation: landscape)");
  const isCoarse = useMediaQuery("(any-pointer: coarse)") && navigator.maxTouchPoints > 1;
  // if landscape, only consider coarse pointer and touch points
  if (isLandscape) {
    return isCoarse;
  }
  // chrome devtools triggers pointer: fine when picking an element, which is annoying, so in DEV, just look at narrow
  return isNarrow && (import.meta.env.DEV || isCoarse);
}

/**
 * Phone held sideways: too short for the bottom control stack, so mobile controls
 * move to a right-side rail. Mirrored in CSS by `.mobile-layout[data-orientation="landscape"]`.
 */
export function useIsCompactLandscape() {
  const isMobile = useIsMobile();
  const isShortLandscape = useMediaQuery("(orientation: landscape) and (max-height: 500px)");
  return isMobile && isShortLandscape;
}

export function useIsTouch() {
  return useMediaQuery("(any-pointer: coarse)") && navigator.maxTouchPoints > 1;
}
