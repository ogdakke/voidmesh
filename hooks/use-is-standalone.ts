import useMediaQuery from "./use-media-query.ts";

interface NavigatorWithStandalone extends Navigator {
  /** iOS Safari's home-screen flag; predates `display-mode` support. */
  standalone?: boolean;
}

/** Running as an installed home-screen web app rather than in a browser tab. */
export function useIsStandalone(): boolean {
  const displayModeStandalone = useMediaQuery("(display-mode: standalone)");
  return displayModeStandalone || (navigator as NavigatorWithStandalone).standalone === true;
}
