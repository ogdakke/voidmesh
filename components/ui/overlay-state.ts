import { useLayoutEffect } from "react";

let openOverlayCount = 0;

function syncDocumentOverlayState() {
  document.documentElement.toggleAttribute("data-overlay-open", openOverlayCount > 0);
}

export function useDocumentOverlayState(open: boolean) {
  useLayoutEffect(() => {
    if (!open) return;

    openOverlayCount += 1;
    syncDocumentOverlayState();

    return () => {
      openOverlayCount = Math.max(0, openOverlayCount - 1);
      syncDocumentOverlayState();
    };
  }, [open]);
}
