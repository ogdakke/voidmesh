/**
 * Renders every app icon from the logo master.
 *
 *   bun run icons
 *
 * The master (scripts/app-icons/logo.svg) is the desktop app icon on a 1024 canvas: a
 * rounded tile at 100..924 and a white dither mark. Each output picks a frame (which part
 * of the canvas it shows and how the tile is cut) and a tint (the tile colour), so local
 * and preview deployments get the same icon in a colour that tells them apart.
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

function composeSvg(mark: string, frame: Frame, tint: Tint): string {
  const [x, y, size] = VIEW_BOX[frame];
  const fill = TINTS[tint];
  const tile =
    frame === "rounded" || frame === "padded"
      ? `<rect x="100" y="100" width="824" height="824" rx="185" fill="${fill}"/>`
      : `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${fill}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${size} ${size}">${tile}<path fill="#fff" d="${mark}"/></svg>\n`;
}

function render(svg: string, size: number, opaque: boolean): Sharp {
  // Rasterise at >= 1024 px, then downsample: librsvg aliases the dither at small sizes.
  // The SVG has no width/height, so its intrinsic size at 72 dpi is the viewBox size.
  const viewSize = Number(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/.exec(svg)?.[1]);
  const image = sharp(Buffer.from(svg), { density: (72 * Math.max(1024, size * 4)) / viewSize })
    .resize(size, size, { kernel: "lanczos3" })
    .toColourspace("srgb");
  // Opaque frames cover the whole viewBox, so dropping alpha changes no pixel.
  return opaque ? image.removeAlpha() : image;
}

async function writePng(path: string, svg: string, size: number, opaque = false) {
  await mkdir(dirname(path), { recursive: true });
  await render(svg, size, opaque).png({ compressionLevel: 9 }).toFile(path);
}

async function writeWebp(path: string, svg: string, size: number) {
  await render(svg, size, false).webp({ lossless: true }).toFile(path);
}

/** ICO with PNG-encoded entries (supported by every browser that reads favicon.ico). */
async function writeIco(path: string, svg: string, sizes: number[]) {
  const images = await Promise.all(sizes.map((size) => render(svg, size, false).png().toBuffer()));
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

async function writeFavicons(dir: string, mark: string, tint: Tint) {
  const rounded = composeSvg(mark, "rounded", tint);
  await writePng(join(dir, "favicon-16x16.png"), rounded, 16);
  await writePng(join(dir, "favicon-32x32.png"), rounded, 32);
  await writePng(join(dir, "favicon-64x64.png"), rounded, 64);
  await writePng(join(dir, "favicon.png"), rounded, 512);
  await writeWebp(join(dir, "favicon.webp"), rounded, 512);
  await writePng(join(dir, "apple-touch-icon.png"), composeSvg(mark, "square", tint), 180, true);
}

async function main() {
  const master = await readFile(MASTER, "utf8");
  const mark = /<path id="mark"[^>]*\sd="([^"]+)"/.exec(master)?.[1];
  if (!mark) throw new Error(`No <path id="mark"> in ${MASTER}`);

  await writeFile(join(PUBLIC, "logo.svg"), composeSvg(mark, "rounded", "brand"));
  await writeFavicons(PUBLIC, mark, "brand");
  await writeIco(join(PUBLIC, "favicon.ico"), composeSvg(mark, "rounded", "brand"), [16, 32, 48]);

  const padded = composeSvg(mark, "padded", "brand");
  await writePng(join(PUBLIC, "rect_192.png"), padded, 192);
  await writePng(join(PUBLIC, "rect_512.png"), padded, 512);

  const maskable = composeSvg(mark, "maskable", "brand");
  await writePng(join(PUBLIC, "assets/manifest-icon-192.maskable.png"), maskable, 192, true);
  await writePng(join(PUBLIC, "assets/manifest-icon-512.maskable.png"), maskable, 512, true);

  for (const tint of ["local", "preview"] as const) {
    await writeFavicons(join(PUBLIC, "assets/app-icons", tint), mark, tint);
  }
  console.log("Wrote app icons to public/");
}

await main();
