import { OPENING_LINE } from "./captions.ts";
import {
  fitLoaderGrid,
  layoutLoaderCaption,
  loaderCaptionOrigin,
  loaderCenter,
  loaderViewportGrid,
  readLoaderViewport,
} from "./layout.ts";

/**
 * Lays the static wordmark (`.loader-wordmark`, an SVG under the loader canvas) onto
 * exactly the cells the worker draws the opening caption on. It is what the first
 * paint shows, and what the canvas covers pixel for pixel once it draws.
 */
export function placeLoaderWordmark(el: HTMLElement) {
  const svg = el.querySelector<SVGSVGElement>(".loader-wordmark");
  const path = svg?.querySelector("path");
  if (!svg || !path) return;
  const viewport = readLoaderViewport(el);
  const grid = loaderViewportGrid(viewport);
  const caption = layoutLoaderCaption(OPENING_LINE, grid);
  const [x, y] = loaderCaptionOrigin(loaderCenter(viewport, grid), caption);

  // The same box and cell scale as the canvas, so both land on identical device pixels.
  svg.setAttribute("viewBox", `0 0 ${grid.cols} ${grid.rows}`);
  fitLoaderGrid(svg, grid);

  // One subpath per horizontal run of glyph cells (R channel; the halo is blue on blue).
  let d = "";
  for (let row = 0; row < caption.height; row++) {
    let col = 0;
    while (col < caption.width) {
      if (!caption.data[(row * caption.width + col) * 2]) {
        col++;
        continue;
      }
      const start = col;
      while (col < caption.width && caption.data[(row * caption.width + col) * 2]) col++;
      d += `M${x + start} ${y + row}h${col - start}v1h${start - col}z`;
    }
  }
  path.setAttribute("d", d);
}
