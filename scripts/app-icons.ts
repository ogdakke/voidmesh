/**
 * Renders every app icon from the logo master.
 *
 *   bun run icons
 *
 * The master (scripts/app-icons/logo.svg) is the desktop app icon on a 1024 canvas: a
 * rounded tile at 100..924 and a white dither mark. Each output picks a frame (which part
 * of the canvas it shows and how the tile is cut) and a tint (the tile colour), so local
 * and preview deployments get the same icon in a colour that tells them apart.
 *
 * The mark is pixel art on a 16-unit cell grid. Wherever a cell is at least one output
 * pixel, the mark is redrawn cell by cell at a whole number of pixels per cell, so home
 * screen icons stay crisp instead of resampling the grid into blur. Smaller favicons fall
 * back to a smooth downsample, where the grid reads as a glow.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import sharp, { type Sharp } from "sharp";

const ROOT = resolve(import.meta.dirname, "..");
const PUBLIC = join(ROOT, "public");
const MASTER = join(ROOT, "scripts/app-icons/logo.svg");

/** Tile colours. Brand blue matches the loader, splash images and manifest background. */
const TINTS = {
  brand: "#007eff",
  local: "#525252",
  preview: "#f26b1d",
} as const;
type Tint = keyof typeof TINTS;

/**
 * rounded: the tile edge to edge, corners cut (favicons, in-page logo).
 * padded: the whole canvas, as the macOS app icon (manifest "any" icons).
 * square: the tile edge to edge, square and opaque; iOS rounds it (apple-touch-icon).
 * maskable: an opaque square with the mark inside the 40% safe-zone radius.
 */
type Frame = "rounded" | "padded" | "square" | "maskable";

const VIEW_BOX: Record<Frame, [number, number, number]> = {
  rounded: [100, 100, 824],
  padded: [0, 0, 1024],
  square: [100, 100, 824],
  // The mark reaches 340 units from the centre; 340 / 906 keeps it inside the 0.4 radius.
  maskable: [59, 59, 906],
};

/** The mark's cell grid on the master canvas: 37 × 37 cells of 16 units from (216, 216), centred on the tile. */
const CELL = 16;
const GRID_ORIGIN = 216;
const GRID_CELLS = 37;

/** Lit cells of the mark, row-major, read from a 1 unit = 1 px raster of the master path. */
async function readCells(mark: string): Promise<boolean[]> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><path fill="#fff" d="${mark}"/></svg>`;
  const { data } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cells: boolean[] = [];
  for (let cy = 0; cy < GRID_CELLS; cy++) {
    for (let cx = 0; cx < GRID_CELLS; cx++) {
      let lit = 0;
      for (let y = 0; y < CELL; y++) {
        const row = (GRID_ORIGIN + cy * CELL + y) * 1024 + GRID_ORIGIN + cx * CELL;
        for (let x = 0; x < CELL; x++) lit += (data[row + x] ?? 0) > 127 ? 1 : 0;
      }
      cells.push(lit * 2 >= CELL * CELL);
    }
  }
  return cells;
}

function tileSvg(frame: Frame, tint: Tint): string {
  const [x, y, size] = VIEW_BOX[frame];
  const fill = TINTS[tint];
  return frame === "rounded" || frame === "padded"
    ? `<rect x="100" y="100" width="824" height="824" rx="185" fill="${fill}"/>`
    : `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${fill}"/>`;
}

/**
 * The icon at `size` px with the mark snapped to whole pixels, or undefined when a cell
 * would be under one pixel. The grid keeps its centre; only its scale rounds.
 */
function snappedSvg(cells: boolean[], frame: Frame, tint: Tint, size: number): string | undefined {
  const [vx, vy, vs] = VIEW_BOX[frame];
  const scale = size / vs;
  if (CELL * scale < 1) return undefined;
  const cellPx = Math.round(CELL * scale);
  const centre = GRID_ORIGIN + (GRID_CELLS * CELL) / 2;
  const left = Math.round((centre - vx) * scale - (GRID_CELLS * cellPx) / 2);
  const top = Math.round((centre - vy) * scale - (GRID_CELLS * cellPx) / 2);
  let d = "";
  cells.forEach((lit, i) => {
    if (!lit) return;
    const x = left + (i % GRID_CELLS) * cellPx;
    const y = top + Math.floor(i / GRID_CELLS) * cellPx;
    d += `M${x} ${y}h${cellPx}v${cellPx}h-${cellPx}z`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g transform="scale(${scale}) translate(${-vx} ${-vy})">${tileSvg(frame, tint)}</g><path fill="#fff" shape-rendering="crispEdges" d="${d}"/></svg>`;
}

function composeSvg(mark: string, frame: Frame, tint: Tint): string {
  const [x, y, size] = VIEW_BOX[frame];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${size} ${size}">${tileSvg(frame, tint)}<path fill="#fff" d="${mark}"/></svg>\n`;
}

interface Icon {
  mark: string;
  cells: boolean[];
  frame: Frame;
  tint: Tint;
}

function render({ mark, cells, frame, tint }: Icon, size: number): Sharp {
  const snapped = snappedSvg(cells, frame, tint, size);
  const image = snapped
    ? sharp(Buffer.from(snapped))
    : // Rasterise at 1024 px, then downsample: librsvg aliases the dither at small sizes.
      // The SVG has no width/height, so its intrinsic size at 72 dpi is the viewBox size.
      sharp(Buffer.from(composeSvg(mark, frame, tint)), {
        density: (72 * 1024) / VIEW_BOX[frame][2],
      }).resize(size, size, { kernel: "lanczos3" });
  // Square and maskable frames cover the whole canvas: drop alpha so they are opaque.
  const opaque = frame === "square" || frame === "maskable";
  return opaque ? image.toColourspace("srgb").removeAlpha() : image.toColourspace("srgb");
}

async function writePng(path: string, icon: Icon, size: number) {
  await mkdir(dirname(path), { recursive: true });
  await render(icon, size).png({ compressionLevel: 9 }).toFile(path);
}

async function writeWebp(path: string, icon: Icon, size: number) {
  await render(icon, size).webp({ lossless: true }).toFile(path);
}

/** ICO with PNG-encoded entries (supported by every browser that reads favicon.ico). */
async function writeIco(path: string, icon: Icon, sizes: number[]) {
  const images = await Promise.all(sizes.map((size) => render(icon, size).png().toBuffer()));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((data, i) => {
    const size = sizes[i] ?? 0;
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  await writeFile(path, Buffer.concat([header, ...images]));
}

async function writeFavicons(dir: string, mark: string, cells: boolean[], tint: Tint) {
  const rounded: Icon = { mark, cells, frame: "rounded", tint };
  await writePng(join(dir, "favicon-16x16.png"), rounded, 16);
  await writePng(join(dir, "favicon-32x32.png"), rounded, 32);
  await writePng(join(dir, "favicon-64x64.png"), rounded, 64);
  await writePng(join(dir, "favicon.png"), rounded, 512);
  await writeWebp(join(dir, "favicon.webp"), rounded, 512);
  await writePng(join(dir, "apple-touch-icon.png"), { mark, cells, frame: "square", tint }, 180);
}

async function main() {
  const master = await readFile(MASTER, "utf8");
  const mark = /<path id="mark"[^>]*\sd="([^"]+)"/.exec(master)?.[1];
  if (!mark) throw new Error(`No <path id="mark"> in ${MASTER}`);
  const cells = await readCells(mark);

  await writeFile(join(PUBLIC, "logo.svg"), composeSvg(mark, "rounded", "brand"));
  await writeFavicons(PUBLIC, mark, cells, "brand");
  const rounded: Icon = { mark, cells, frame: "rounded", tint: "brand" };
  await writeIco(join(PUBLIC, "favicon.ico"), rounded, [16, 32, 48]);

  const padded: Icon = { mark, cells, frame: "padded", tint: "brand" };
  await writePng(join(PUBLIC, "rect_192.png"), padded, 192);
  await writePng(join(PUBLIC, "rect_512.png"), padded, 512);

  const maskable: Icon = { mark, cells, frame: "maskable", tint: "brand" };
  await writePng(join(PUBLIC, "assets/manifest-icon-192.maskable.png"), maskable, 192);
  await writePng(join(PUBLIC, "assets/manifest-icon-512.maskable.png"), maskable, 512);

  for (const tint of ["local", "preview"] as const) {
    await writeFavicons(join(PUBLIC, "assets/app-icons", tint), mark, cells, tint);
  }
  console.log("Wrote app icons to public/");
}

await main();
