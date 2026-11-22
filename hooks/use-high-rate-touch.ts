import { useCanvasInteraction } from "#context/use-canvas.ts";
import { countHud } from "#lib/high-refresh-hud.ts";
import { useEffect, type RefObject } from "react";

// The scroll area is much larger than the viewport so a native fling never runs
// out of room mid-gesture; it is re-centered at the start of the next touch.
const SCROLL_EXTENT = 200_000;
const RECENTER_MARGIN = SCROLL_EXTENT / 4;

/**
 * Feeds canvas touches from a hidden native scroll area. WebKit holds touch
 * events on a regular page to 60 Hz, but a passive listener on a scrolling
 * element is delivered at the display rate. The scroll area is invisible and
 * never read for position; it exists only to change how touches are scheduled.
 */
export function useHighRateTouch(controllerRef: RefObject<HTMLDivElement | null>) {
  const interaction = useCanvasInteraction();

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;

    const center = () => {
      controller.scrollTop = SCROLL_EXTENT / 2;
      controller.scrollLeft = SCROLL_EXTENT / 2;
    };
    center();

    const points: { x: number; y: number }[] = [];
    const readPoints = (touches: TouchList) => {
      points.length = touches.length;
      for (let index = 0; index < touches.length; index++) {
        const touch = touches[index]!;
        const point = points[index];
        if (point) {
          point.x = touch.clientX;
          point.y = touch.clientY;
        } else {
          points[index] = { x: touch.clientX, y: touch.clientY };
        }
      }
      return points;
    };

    const onTouchStart = (event: TouchEvent) => {
      const { scrollTop, scrollLeft } = controller;
      if (
        scrollTop < RECENTER_MARGIN ||
        scrollTop > SCROLL_EXTENT - RECENTER_MARGIN ||
        scrollLeft < RECENTER_MARGIN ||
        scrollLeft > SCROLL_EXTENT - RECENTER_MARGIN
      ) {
        center();
      }
      interaction.touchStart(readPoints(event.touches), event.timeStamp);
    };
    const onTouchMove = (event: TouchEvent) => {
      countHud("touchmove");
      interaction.touchMove(readPoints(event.touches), event.timeStamp);
    };
    // iOS swallows the touch that stops a scroller's momentum (no touchstart),
    // so the engine would miss every touch until native momentum died out. The
    // engine has its own momentum, so freeze the scroller once all fingers lift.
    let thawTimer: ReturnType<typeof setTimeout> | null = null;
    const freeze = () => {
      controller.classList.add("infinite-canvas__touch-controller--frozen");
      controller.scrollTo({
        top: controller.scrollTop,
        left: controller.scrollLeft,
        behavior: "instant",
      });
      if (thawTimer !== null) clearTimeout(thawTimer);
      thawTimer = setTimeout(() => {
        thawTimer = null;
        controller.classList.remove("infinite-canvas__touch-controller--frozen");
      }, 50);
    };
    const onTouchEnd = (event: TouchEvent) => {
      interaction.touchEnd(readPoints(event.touches), false, event.timeStamp);
      if (event.touches.length === 0) freeze();
    };
    const onTouchCancel = (event: TouchEvent) => {
      interaction.touchEnd(readPoints(event.touches), true, event.timeStamp);
      if (event.touches.length === 0) freeze();
    };
    const onScroll = () => countHud("scrollDelta");

    const options = { passive: true } as const;
    controller.addEventListener("touchstart", onTouchStart, options);
    controller.addEventListener("touchmove", onTouchMove, options);
    controller.addEventListener("touchend", onTouchEnd, options);
    controller.addEventListener("touchcancel", onTouchCancel, options);
    controller.addEventListener("scroll", onScroll, options);
    return () => {
      if (thawTimer !== null) clearTimeout(thawTimer);
      controller.removeEventListener("touchstart", onTouchStart);
      controller.removeEventListener("touchmove", onTouchMove);
      controller.removeEventListener("touchend", onTouchEnd);
      controller.removeEventListener("touchcancel", onTouchCancel);
      controller.removeEventListener("scroll", onScroll);
    };
  }, [controllerRef, interaction]);
}
