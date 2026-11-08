/** Layout shared by the loader worker and the main thread. */

/** Target dither cell size; chunky cells read as pixel art and keep fragment counts low. */
const DITHER_CELL_CSS = 2.5;
const MAX_DITHER_CELLS = 200_000;

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
  return {
    cols,
    rows,
    cell: cellDevice / dpr,
    cssWidth: (cols * cellDevice) / dpr,
    cssHeight: (rows * cellDevice) / dpr,
  };
}
