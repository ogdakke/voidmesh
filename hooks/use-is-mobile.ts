import useMediaQuery from "./use-media-query";

export function useIsMobile() {
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const isCoarse = useMediaQuery("(any-pointer: coarse)");
  // chrome devtools triggers pointer: fine when picking an element, which is annoying, so in DEV, just look at narrow
  return isNarrow && (import.meta.env.DEV || isCoarse);
}

export function useIsTouch() {
  return useMediaQuery("(any-pointer: coarse)");
}
