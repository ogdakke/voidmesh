import { afterEach, describe, expect, it } from "vitest";
import { OPENING_LINE } from "#renderer/app-loader/captions.ts";
import {
  layoutLoaderCaption,
  loaderCaptionOrigin,
  loaderCenter,
  loaderDitherGrid,
  loaderViewportGrid,
} from "#renderer/app-loader/layout.ts";
import { placeLoaderWordmark } from "#renderer/app-loader/wordmark.ts";

const BLEED = 200;

/** The cells the static wordmark's path fills, as "col,row". */
function pathCells(d: string) {
  const cells = new Set<string>();
  for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) cells.add(`${Number(x) + i},${y}`);
  }
  return cells;
}

/** The glyph cells the worker draws for the opening caption, as "col,row". */
function workerCells(width: number, height: number, dpr: number) {
  const viewport = { width, height, coverHeight: height + BLEED, dpr };
  const grid = loaderViewportGrid(viewport);
  const caption = layoutLoaderCaption(OPENING_LINE, grid);
  const [ox, oy] = loaderCaptionOrigin(loaderCenter(viewport, grid), caption);
  const cells = new Set<string>();
  for (let row = 0; row < caption.height; row++) {
    for (let col = 0; col < caption.width; col++) {
      if (caption.data[(row * caption.width + col) * 2]) cells.add(`${ox + col},${oy + row}`);
    }
  }
  return { grid, cells };
}

describe("loader first-paint wordmark", () => {
  const originalDpr = devicePixelRatio;
  const originalWidth = innerWidth;

  afterEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: originalDpr, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    document.body.innerHTML = "";
  });

  it.each([
    [393, 852, 3],
    [852, 393, 3],
    [1032, 1376, 2],
    [375, 667, 2],
    [1440, 900, 2],
    [1280, 800, 1],
  ])(
    "fills exactly the worker's caption cells at %i×%i@%i, bleed included",
    (width, height, dpr) => {
      Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
      document.body.innerHTML = `<div id="app-loader"><svg class="loader-wordmark"><path /></svg></div>`;
      const el = document.getElementById("app-loader")!;
      el.style.setProperty("--loader-bleed", `${BLEED}px`);
      el.getBoundingClientRect = () => ({ height: height + BLEED }) as DOMRect;

      placeLoaderWordmark(el);

      const svg = el.querySelector("svg")!;
      const { grid, cells } = workerCells(width, height, dpr);
      expect(svg.getAttribute("viewBox")).toBe(`0 0 ${grid.cols} ${grid.rows}`);
      expect(svg.style.width).toBe(`${grid.cols}px`);
      expect(svg.style.transform).toBe(`scale(${grid.cell})`);
      expect(pathCells(svg.querySelector("path")!.getAttribute("d")!)).toEqual(cells);
    },
  );
});

describe("loader dither grid", () => {
  it("uses a whole number of device pixels per cell", () => {
    for (const [width, height, dpr] of [
      [393, 852, 3],
      [1440, 900, 2],
      [2560, 1440, 2],
      [1280, 800, 1],
    ] as const) {
      const grid = loaderDitherGrid(width, height, dpr);
      expect(grid.cell * dpr).toBeCloseTo(Math.round(grid.cell * dpr), 9);
      expect(grid.cols * grid.cell).toBeGreaterThanOrEqual(width);
      expect(grid.rows * grid.cell).toBeGreaterThanOrEqual(height);
    }
  });
});
