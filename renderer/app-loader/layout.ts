/**
 * Layout shared by the loader worker, the main thread, and the first-paint wordmark.
 * Everything that decides where a cell or caption pixel lands lives here, so the
 * HTML wordmark, the canvas, and the PWA splash images agree to the device pixel.
 */

import { LINES, OPENING_LINE } from "./captions.ts";
import { layoutPixelText, type PixelText } from "./pixel-font.ts";

/** Target dither cell size; chunky cells read as pixel art and keep fragment counts low. */
const DITHER_CELL_CSS = 2.5;
const MAX_DITHER_CELLS = 200_000;
/** Target caption height in CSS px; font pixels snap to whole cells. */
const CAPTION_HEIGHT_CSS = 32;
/** Widest share of the viewport a caption may take. */
const CAPTION_MAX_WIDTH = 0.8;
/** Blue outline around caption glyphs, in cells; it separates them from the cloud. */
const CAPTION_HALO = 1;
/** Widest line at one cell per font pixel; sizes every line consistently. */
const WIDEST_LINE = Math.max(
  ...[OPENING_LINE, ...LINES].map((line) => layoutPixelText(line, 1, 0).width),
);

export interface LoaderViewport {
  width: number;
  /** Visible region (100svh): the wordmark, cloud, and reveal centre on it. */
  height: number;
  /** Painted height: the visible region plus the bleed below it (app-loader.css). */
  coverHeight: number;
  dpr: number;
}

export type LoaderGrid = ReturnType<typeof loaderDitherGrid>;

export function readLoaderViewport(el: HTMLElement): LoaderViewport {
  const coverHeight = el.getBoundingClientRect().height;
  const bleed = Number.parseFloat(getComputedStyle(el).getPropertyValue("--loader-bleed")) || 0;
  return { width: innerWidth, height: coverHeight - bleed, coverHeight, dpr: devicePixelRatio };
}

/** The cell grid covering the whole painted area, bleed included. */
export function loaderViewportGrid(viewport: LoaderViewport) {
  return loaderDitherGrid(viewport.width, viewport.coverHeight, viewport.dpr);
}

/**
 * Sizes the loader canvas or wordmark SVG to the cell grid: one CSS px per cell, scaled
 * up by a transform. A CSS size of `cols * cell` px is generally not representable in
 * layout units (e.g. 8 device px per cell at 3×), and the snapped size makes the
 * pixelated upscale drift off the cell edges; a float transform keeps it exact.
 */
export function fitLoaderGrid(element: HTMLElement | SVGElement, grid: LoaderGrid) {
  element.style.width = `${grid.cols}px`;
  element.style.height = `${grid.rows}px`;
  element.style.transform = `scale(${grid.cell})`;
}

/**
 * Pixel-art canvas for the dither loader: one canvas pixel per dither cell, and each
 * cell an integer number of device pixels so `image-rendering: pixelated` stays crisp.
 */
export function loaderDitherGrid(width: number, height: number, dpr: number) {
  // Cap the cell count so large/high-DPI displays get bigger cells, not more fragments.
  const devicePixels = width * height * dpr * dpr;
  const cellDevice = Math.max(
    2,
    Math.round(dpr * DITHER_CELL_CSS),
    Math.ceil(Math.sqrt(devicePixels / MAX_DITHER_CELLS)),
  );
  const cols = Math.ceil((width * dpr) / cellDevice);
  const rows = Math.ceil((height * dpr) / cellDevice);
  return { cols, rows, cell: cellDevice / dpr };
}

/** Visible-region centre in cells: the cloud, the caption, and the reveal centre on it. */
export function loaderCenter(viewport: LoaderViewport, grid: LoaderGrid) {
  return [viewport.width / grid.cell / 2, viewport.height / grid.cell / 2] as const;
}

/** One scale per viewport (not per line) so captions don't change size as they rotate. */
export function layoutLoaderCaption(text: string, grid: LoaderGrid): PixelText {
  const byHeight = Math.round(CAPTION_HEIGHT_CSS / (7 * grid.cell));
  const byWidth = Math.floor((grid.cols * CAPTION_MAX_WIDTH) / WIDEST_LINE);
  const scale = Math.max(1, Math.min(byHeight, byWidth));
  return layoutPixelText(text, scale, CAPTION_HALO);
}

/** Top-left cell of a caption (including its halo) centred on `center`. */
export function loaderCaptionOrigin(
  center: readonly [number, number],
  size: { width: number; height: number },
) {
  return [Math.round(center[0] - size.width / 2), Math.round(center[1] - size.height / 2)] as const;
}
