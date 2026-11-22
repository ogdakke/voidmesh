// Experiment: ?hz120 draws into transferred OffscreenCanvases and drives frame
// work from a worker timer, so iOS Safari is not capped at 60 Hz.
export const highRefreshEnabled = new URLSearchParams(globalThis.location?.search).has("hz120");

export type DrawSurface = HTMLCanvasElement | OffscreenCanvas;
export type Draw2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// transferControlToOffscreen() throws on a second call, but effects can run
// twice for one element (StrictMode, re-init), so cache the surface.
const offscreenSurfaces = new WeakMap<HTMLCanvasElement, OffscreenCanvas>();

/**
 * The surface to size and draw into. With ?hz120 control of the canvas is
 * transferred once (irreversible) so presentation does not wait on the
 * main-thread rendering update, which is capped at 60 Hz on iOS.
 */
export function getDrawSurface(canvas: HTMLCanvasElement): DrawSurface {
  if (!highRefreshEnabled) return canvas;
  let surface = offscreenSurfaces.get(canvas);
  if (!surface) {
    surface = canvas.transferControlToOffscreen();
    offscreenSurfaces.set(canvas, surface);
  }
  return surface;
}

// Diagnostic: ?nowlur skips the full-screen glass blur overlay so its GPU cost
// can be measured in isolation. Remove with the rest of the experiment.
export const diagnosticSkipWlur = new URLSearchParams(globalThis.location?.search).has("nowlur");
