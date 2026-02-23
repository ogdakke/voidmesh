import useMediaQuery from "./use-media-query";

export function useIsMobile() {
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const isCoarse = useMediaQuery("(any-pointer: coarse)");
  return isNarrow && isCoarse;
}

export function useIsTouch() {
  return useMediaQuery("(any-pointer: coarse)");
}
