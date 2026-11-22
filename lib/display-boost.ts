import { diagnosticNoBoost, highRefreshEnabled } from "./high-refresh.ts";
import { countHud } from "./high-refresh-hud.ts";

// iOS ProMotion only raises the display to its full refresh rate while
// something is scrolling under a GPU-accelerated animation; a canvas that just
// repaints is left at a lower rate, which paces every presented frame no matter
// how fast we submit. A tiny, nearly invisible scroller that smooth-scrolls in
// the background under a composited CSS animation keeps the display at 120 Hz.
// It only runs while frames are being rendered, so idle pages stay cheap.
const HOLD_MS = 600;
const SCROLL_INTERVAL_MS = 500;
const SCROLL_TRAVEL_PX = 2_000;

let scroller: HTMLDivElement | null = null;
let style: HTMLStyleElement | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let moveTimer: ReturnType<typeof setTimeout> | null = null;
let down = false;
let touching = false;

function start(): void {
  style = document.createElement("style");
  style.textContent =
    "@keyframes display-boost { from { transform: translate3d(0,0,0); } to { transform: translate3d(0,1px,0); } }";
  document.head.append(style);

  scroller = document.createElement("div");
  scroller.setAttribute("aria-hidden", "true");
  scroller.style.cssText =
    "position:absolute;top:0;left:0;width:8px;height:8px;overflow:scroll;opacity:0.01;" +
    "pointer-events:none;scrollbar-width:none;z-index:-1";
  const content = document.createElement("div");
  content.style.cssText =
    "width:1px;height:20000px;will-change:transform;" +
    "animation:display-boost 0.5s linear infinite alternate";
  scroller.append(content);
  scroller.addEventListener("scroll", () => countHud("scrollDelta"), { passive: true });
  document.body.append(scroller);

  const move = (): void => {
    down = !down;
    scroller?.scrollTo({ top: down ? SCROLL_TRAVEL_PX : 0, behavior: "smooth" });
    moveTimer = setTimeout(move, SCROLL_INTERVAL_MS);
  };
  move();
}

function stop(): void {
  if (moveTimer !== null) clearTimeout(moveTimer);
  moveTimer = null;
  scroller?.remove();
  scroller = null;
  style?.remove();
  style = null;
  stopTimer = null;
}

/**
 * A background smooth-scroll makes WebKit throttle touch delivery (touchmove
 * fell from ~60-80/s to ~16/s while panning), and a finger on the screen
 * already raises the display rate, so the boost stays off while touching.
 */
export function setDisplayBoostTouching(isTouching: boolean): void {
  touching = isTouching;
  if (isTouching) {
    if (stopTimer !== null) clearTimeout(stopTimer);
    stop();
  }
}

/** Call whenever a frame is rendered; the boost lapses shortly after calls stop. */
export function keepDisplayBoosted(): void {
  if (!highRefreshEnabled || diagnosticNoBoost || touching) return;
  if (!scroller) start();
  if (stopTimer !== null) clearTimeout(stopTimer);
  stopTimer = setTimeout(stop, HOLD_MS);
}
