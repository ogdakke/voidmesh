/**
 * Tiny 5×7 pixel font for the loader's dithered captions, laid out in dither cells.
 * Lowercase only: captions are lowercased, and characters without a glyph are dropped.
 * Glyph rows run top to bottom; each row is five bits, leftmost pixel first.
 */

// prettier-ignore
const GLYPHS: Record<string, readonly string[]> = {
  a: ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
  b: ["10000", "10000", "10110", "11001", "10001", "10001", "11110"],
  c: ["00000", "00000", "01110", "10000", "10000", "10001", "01110"],
  d: ["00001", "00001", "01101", "10011", "10001", "10001", "01111"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01110"],
  f: ["00110", "01001", "01000", "11100", "01000", "01000", "01000"],
  g: ["00000", "01111", "10001", "10001", "01111", "00001", "01110"],
  h: ["10000", "10000", "10110", "11001", "10001", "10001", "10001"],
  i: ["00100", "00000", "01100", "00100", "00100", "00100", "01110"],
  j: ["00010", "00000", "00110", "00010", "00010", "10010", "01100"],
  k: ["10000", "10000", "10010", "10100", "11000", "10100", "10010"],
  l: ["01100", "00100", "00100", "00100", "00100", "00100", "01110"],
  m: ["00000", "00000", "11010", "10101", "10101", "10001", "10001"],
  n: ["00000", "00000", "10110", "11001", "10001", "10001", "10001"],
  o: ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
  p: ["00000", "00000", "11110", "10001", "11110", "10000", "10000"],
  q: ["00000", "00000", "01101", "10011", "01111", "00001", "00001"],
  r: ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
  s: ["00000", "00000", "01110", "10000", "01110", "00001", "11110"],
  t: ["01000", "01000", "11100", "01000", "01000", "01001", "00110"],
  u: ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
  v: ["00000", "00000", "10001", "10001", "10001", "01010", "00100"],
  w: ["00000", "00000", "10001", "10001", "10101", "10101", "01010"],
  x: ["00000", "00000", "10001", "01010", "00100", "01010", "10001"],
  y: ["00000", "00000", "10001", "10001", "01111", "00001", "01110"],
  z: ["00000", "00000", "11111", "00010", "00100", "01000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "'": ["01100", "00100", "01000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "…": ["00000", "00000", "00000", "00000", "00000", "00000", "10101"],
};

const GLYPH_ROWS = 7;
// Wide enough that word gaps survive the caption outline at one cell per font pixel.
const SPACE_WIDTH = 4;
const LETTER_GAP = 1;

interface Glyph {
  width: number;
  /** Column offset of the glyph's first lit column within its 5-wide box. */
  left: number;
  rows: readonly number[];
}

/** Glyphs trimmed to their lit columns, so the font sets proportionally. */
const FONT = new Map<string, Glyph>(
  Object.entries(GLYPHS).map(([char, rows]) => {
    const bits = rows.map((row) => Number.parseInt(row, 2));
    const used = bits.reduce((acc, row) => acc | row, 0);
    let left = 0;
    while (left < 5 && !(used & (1 << (4 - left)))) left++;
    let right = 4;
    while (right > left && !(used & (1 << (4 - right)))) right--;
    return [char, { width: right - left + 1, left, rows: bits }];
  }),
);

export interface PixelText {
  /** Size in cells, including the halo. */
  width: number;
  height: number;
  /** RG8 per cell: R = glyph pixel, G = halo (cells within `halo` of a glyph pixel). */
  data: Uint8Array;
}

/** Characters the caption can render; the rest are dropped. */
export function normalizePixelText(text: string) {
  return [...text.toLowerCase().replace(/\.\.\./g, "…")]
    .filter((char) => char === " " || FONT.has(char))
    .join("")
    .trim();
}

/** Lays `text` out in cells at `scale` cells per font pixel, with a `halo` cell border. */
export function layoutPixelText(text: string, scale: number, halo: number): PixelText {
  const chars = [...normalizePixelText(text)];
  let advance = 0;
  for (const [i, char] of chars.entries()) {
    advance += char === " " ? SPACE_WIDTH : (FONT.get(char)?.width ?? 0);
    if (i < chars.length - 1) advance += LETTER_GAP;
  }
  const pad = halo;
  const width = advance * scale + pad * 2;
  const height = GLYPH_ROWS * scale + pad * 2;
  const glyph = new Uint8Array(width * height);

  let x = pad;
  for (const char of chars) {
    const g = FONT.get(char);
    if (char === " " || !g) {
      x += (SPACE_WIDTH + LETTER_GAP) * scale;
      continue;
    }
    for (let row = 0; row < GLYPH_ROWS; row++) {
      for (let col = 0; col < g.width; col++) {
        if (!(g.rows[row]! & (1 << (4 - (g.left + col))))) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            glyph[(pad + row * scale + sy) * width + x + col * scale + sx] = 1;
          }
        }
      }
    }
    x += (g.width + LETTER_GAP) * scale;
  }

  const data = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (glyph[i]) {
        data[i * 2] = 255;
        continue;
      }
      // Halo: square dilation of the glyph mask.
      search: for (let dy = -halo; dy <= halo; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -halo; dx <= halo; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width && glyph[yy * width + xx]) {
            data[i * 2 + 1] = 255;
            break search;
          }
        }
      }
    }
  }
  return { width, height, data };
}
