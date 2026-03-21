import { Font, UnicodeBuffer, shape, getGlyphPath } from "text-shaper";

// Bitcast helper: reinterpret a u32 bit pattern as f32
const _u32 = new Uint32Array(1);
const _f32 = new Float32Array(_u32.buffer);
function packU32AsF32(value: number): number {
  _u32[0] = value >>> 0;
  return _f32[0]!;
}

interface Bounds {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface QuadCurve {
  p0x: number;
  p0y: number;
  p1x: number;
  p1y: number;
  p2x: number;
  p2y: number;
}

export interface GlyphBands {
  hBands: BandEntry[];
  vBands: BandEntry[];
  hBandCount: number;
  vBandCount: number;
}

export interface BandEntry {
  curveIndices: number[];
}

export interface SlugGlyph {
  glyphId: number;
  curves: QuadCurve[];
  bands: GlyphBands;
  bounds: Bounds;
}

/**
 * Extract quadratic bezier curves from a glyph path.
 * Line segments are converted to degenerate quadratics.
 */
export function extractCurves(font: Font, glyphId: number) {
  const path = getGlyphPath(font, glyphId);
  if (!path || !path.bounds) return null;

  const curves: QuadCurve[] = [];
  let curX = 0,
    curY = 0;
  let startX = 0,
    startY = 0;

  for (const cmd of path.commands) {
    switch (cmd.type) {
      case "M":
        curX = cmd.x;
        curY = cmd.y;
        startX = cmd.x;
        startY = cmd.y;
        break;

      case "L": {
        const dx = cmd.x - curX;
        const dy = cmd.y - curY;
        if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
          curX = cmd.x;
          curY = cmd.y;
          break;
        }
        const mx = (curX + cmd.x) / 2;
        const my = (curY + cmd.y) / 2;
        curves.push({
          p0x: curX,
          p0y: curY,
          p1x: mx,
          p1y: my,
          p2x: cmd.x,
          p2y: cmd.y,
        });
        curX = cmd.x;
        curY = cmd.y;
        break;
      }

      case "Q":
        curves.push({
          p0x: curX,
          p0y: curY,
          p1x: cmd.x1,
          p1y: cmd.y1,
          p2x: cmd.x,
          p2y: cmd.y,
        });
        curX = cmd.x;
        curY = cmd.y;
        break;

      case "C": {
        const cx1 = cmd.x1,
          cy1 = cmd.y1;
        const cx2 = cmd.x2,
          cy2 = cmd.y2;
        const ex = cmd.x,
          ey = cmd.y;

        const m01x = (curX + cx1) / 2,
          m01y = (curY + cy1) / 2;
        const m12x = (cx1 + cx2) / 2,
          m12y = (cy1 + cy2) / 2;
        const m23x = (cx2 + ex) / 2,
          m23y = (cy2 + ey) / 2;
        const m012x = (m01x + m12x) / 2,
          m012y = (m01y + m12y) / 2;
        const m123x = (m12x + m23x) / 2,
          m123y = (m12y + m23y) / 2;
        const midx = (m012x + m123x) / 2,
          midy = (m012y + m123y) / 2;

        curves.push({
          p0x: curX,
          p0y: curY,
          p1x: m01x,
          p1y: m01y,
          p2x: midx,
          p2y: midy,
        });
        curves.push({
          p0x: midx,
          p0y: midy,
          p1x: m123x,
          p1y: m123y,
          p2x: ex,
          p2y: ey,
        });
        curX = ex;
        curY = ey;
        break;
      }

      case "Z": {
        const cdx = startX - curX;
        const cdy = startY - curY;
        if (Math.abs(cdx) > 0.1 || Math.abs(cdy) > 0.1) {
          const mx = (curX + startX) / 2;
          const my = (curY + startY) / 2;
          curves.push({
            p0x: curX,
            p0y: curY,
            p1x: mx,
            p1y: my,
            p2x: startX,
            p2y: startY,
          });
        }
        curX = startX;
        curY = startY;
        break;
      }
    }
  }

  return { curves, bounds: path.bounds };
}

/**
 * Organize curves into horizontal and vertical bands.
 */
export function buildBands(curves: QuadCurve[], bounds: Bounds, bandCount: number = 8): GlyphBands {
  const { xMin, yMin, xMax, yMax } = bounds;
  const width = xMax - xMin;
  const height = yMax - yMin;

  const hBands: BandEntry[] = [];
  for (let i = 0; i < bandCount; i++) {
    hBands.push({ curveIndices: [] });
  }

  const vBands: BandEntry[] = [];
  for (let i = 0; i < bandCount; i++) {
    vBands.push({ curveIndices: [] });
  }

  for (let ci = 0; ci < curves.length; ci++) {
    const c = curves[ci]!;
    const cyMin = Math.min(c.p0y, c.p1y, c.p2y);
    const cyMax = Math.max(c.p0y, c.p1y, c.p2y);
    const cxMin = Math.min(c.p0x, c.p1x, c.p2x);
    const cxMax = Math.max(c.p0x, c.p1x, c.p2x);

    if (height > 0) {
      const b0 = Math.max(0, Math.floor(((cyMin - yMin) / height) * bandCount));
      const b1 = Math.min(bandCount - 1, Math.floor(((cyMax - yMin) / height) * bandCount));
      for (let b = b0; b <= b1; b++) {
        hBands[b]!.curveIndices.push(ci);
      }
    }

    if (width > 0) {
      const b0 = Math.max(0, Math.floor(((cxMin - xMin) / width) * bandCount));
      const b1 = Math.min(bandCount - 1, Math.floor(((cxMax - xMin) / width) * bandCount));
      for (let b = b0; b <= b1; b++) {
        vBands[b]!.curveIndices.push(ci);
      }
    }
  }

  return { hBands, vBands, hBandCount: bandCount, vBandCount: bandCount };
}

const TEX_WIDTH = 4096;

/**
 * Pack glyph data into GPU textures (RGBA32Float for curves, RGBA32Uint for bands).
 */
export function packGlyphData(glyphs: SlugGlyph[]) {
  // --- Curve texture (RGBA32Float, width 4096) ---
  // Each curve = 2 texels: (p0x, p0y, p1x, p1y) and (p2x, p2y, 0, 0)
  let totalCurveTexels = 0;
  for (const g of glyphs) totalCurveTexels += g.curves.length * 2;

  const curveTexHeight = Math.max(1, Math.ceil(totalCurveTexels / TEX_WIDTH));
  const curveTexData = new Float32Array(TEX_WIDTH * curveTexHeight * 4);

  let curveTexelIdx = 0;
  const glyphCurveStarts: number[] = [];

  for (const g of glyphs) {
    glyphCurveStarts.push(curveTexelIdx);
    for (const c of g.curves) {
      // Texel 0: (p0x, p0y, p1x, p1y)
      const i0 = curveTexelIdx;
      const x0 = i0 % TEX_WIDTH,
        y0 = (i0 / TEX_WIDTH) | 0;
      const off0 = (y0 * TEX_WIDTH + x0) * 4;
      curveTexData[off0] = c.p0x;
      curveTexData[off0 + 1] = c.p0y;
      curveTexData[off0 + 2] = c.p1x;
      curveTexData[off0 + 3] = c.p1y;

      // Texel 1: (p2x, p2y, 0, 0)
      const i1 = curveTexelIdx + 1;
      const x1 = i1 % TEX_WIDTH,
        y1 = (i1 / TEX_WIDTH) | 0;
      const off1 = (y1 * TEX_WIDTH + x1) * 4;
      curveTexData[off1] = c.p2x;
      curveTexData[off1 + 1] = c.p2y;

      curveTexelIdx += 2;
    }
  }

  // --- Band texture (RGBA32Uint, width 4096) ---
  // Per glyph: [hBand headers...] [vBand headers...] [curve index lists...]
  // Each header texel: (curveCount, offsetFromGlyphLoc, 0, 0)
  // Each curve ref texel: (curveTexX, curveTexY, 0, 0)
  let totalBandTexels = 0;
  for (const g of glyphs) {
    const headerCount = g.bands.hBandCount + g.bands.vBandCount;
    // Pad to avoid header wrapping at row boundary
    const padded = TEX_WIDTH - (totalBandTexels % TEX_WIDTH);
    if (padded < headerCount && padded < TEX_WIDTH) totalBandTexels += padded;
    totalBandTexels += headerCount;
    for (const band of [...g.bands.hBands, ...g.bands.vBands]) {
      totalBandTexels += band.curveIndices.length;
    }
  }

  const bandTexHeight = Math.max(1, Math.ceil(totalBandTexels / TEX_WIDTH));
  const bandTexData = new Uint32Array(TEX_WIDTH * bandTexHeight * 4);

  let bandTexelIdx = 0;
  const glyphBandInfo: { glyphLocX: number; glyphLocY: number }[] = [];

  for (const [gi, g] of glyphs.entries()) {
    const hBandCount = g.bands.hBandCount;
    const vBandCount = g.bands.vBandCount;
    const headerCount = hBandCount + vBandCount;

    // Ensure headers don't straddle a row boundary
    const curX = bandTexelIdx % TEX_WIDTH;
    if (curX + headerCount > TEX_WIDTH) {
      bandTexelIdx = (((bandTexelIdx / TEX_WIDTH) | 0) + 1) * TEX_WIDTH;
    }

    const glyphLocX = bandTexelIdx % TEX_WIDTH;
    const glyphLocY = (bandTexelIdx / TEX_WIDTH) | 0;
    glyphBandInfo.push({ glyphLocX, glyphLocY });

    const glyphStart = bandTexelIdx;
    const glyphCurveStart = glyphCurveStarts[gi]!;

    // Sort curves: h-bands by descending max x, v-bands by descending max y
    const sortedHBands = g.bands.hBands.map((band) => ({
      curveIndices: [...band.curveIndices].sort((a, b) => {
        const ca = g.curves[a]!,
          cb = g.curves[b]!;
        return Math.max(cb.p0x, cb.p1x, cb.p2x) - Math.max(ca.p0x, ca.p1x, ca.p2x);
      }),
    }));
    const sortedVBands = g.bands.vBands.map((band) => ({
      curveIndices: [...band.curveIndices].sort((a, b) => {
        const ca = g.curves[a]!,
          cb = g.curves[b]!;
        return Math.max(cb.p0y, cb.p1y, cb.p2y) - Math.max(ca.p0y, ca.p1y, ca.p2y);
      }),
    }));

    const allBands = [...sortedHBands, ...sortedVBands];

    // Calculate offsets: curve lists follow all headers
    let curveListOffset = headerCount;
    const bandOffsets: number[] = [];
    for (const band of allBands) {
      bandOffsets.push(curveListOffset);
      curveListOffset += band.curveIndices.length;
    }

    // Write band headers
    for (let i = 0; i < allBands.length; i++) {
      const tl = glyphStart + i;
      const tx = tl % TEX_WIDTH,
        ty = (tl / TEX_WIDTH) | 0;
      const di = (ty * TEX_WIDTH + tx) * 4;
      bandTexData[di] = allBands[i]!.curveIndices.length;
      bandTexData[di + 1] = bandOffsets[i]!;
    }

    // Write curve index lists (each entry = curve's 2D location in curve texture)
    for (let i = 0; i < allBands.length; i++) {
      const band = allBands[i]!;
      const listStart = glyphStart + bandOffsets[i]!;
      for (let j = 0; j < band.curveIndices.length; j++) {
        const ci = band.curveIndices[j]!;
        const curveTexel = glyphCurveStart! + ci * 2;
        const cTexX = curveTexel % TEX_WIDTH;
        const cTexY = (curveTexel / TEX_WIDTH) | 0;

        const tl = listStart + j;
        const tx = tl % TEX_WIDTH,
          ty = (tl / TEX_WIDTH) | 0;
        const di = (ty * TEX_WIDTH + tx) * 4;
        bandTexData[di] = cTexX;
        bandTexData[di + 1] = cTexY;
      }
    }

    bandTexelIdx = glyphStart + curveListOffset;
  }

  return {
    curveTexData,
    bandTexData,
    curveTexHeight,
    bandTexHeight,
    glyphBandInfo,
    glyphCurveStarts,
  };
}

/**
 * Prepare all glyph data for a text string.
 * Returns texture data and 5-attribute vertex buffers matching the Slug shaders.
 */
export function prepareText(font: Font, text: string, fontSize: number) {
  const buf = new UnicodeBuffer();
  buf.addStr(text);
  const glyphBuffer = shape(font, buf);
  const scale = font.scaleForSize(fontSize);

  // Process unique glyphs
  const glyphMap = new Map<number, SlugGlyph>();
  for (const { info } of glyphBuffer) {
    if (glyphMap.has(info.glyphId)) continue;
    const result = extractCurves(font, info.glyphId);
    if (!result) continue;
    const bands = buildBands(result.curves, result.bounds);
    glyphMap.set(info.glyphId, {
      glyphId: info.glyphId,
      curves: result.curves,
      bands,
      bounds: result.bounds,
    });
  }

  const slugGlyphs = [...glyphMap.values()];
  const packed = packGlyphData(slugGlyphs);

  // Build per-glyph lookup
  const glyphDataMap = new Map<
    number,
    {
      glyph: SlugGlyph;
      glyphLocX: number;
      glyphLocY: number;
    }
  >();
  for (const [index, glyph] of slugGlyphs.entries()) {
    glyphDataMap.set(glyph.glyphId, {
      glyph,
      ...packed.glyphBandInfo[index]!,
    });
  }

  // Build vertex/index data
  // 5 attributes × vec4 = 20 floats = 80 bytes per vertex
  const verts: number[] = [];
  const idxs: number[] = [];
  let cursorX = 0;
  let quadIdx = 0;

  for (const { info, position } of glyphBuffer) {
    const data = glyphDataMap.get(info.glyphId);
    if (!data) {
      cursorX += position.xAdvance;
      continue;
    }

    const { glyph, glyphLocX, glyphLocY } = data;
    const { xMin, yMin, xMax, yMax } = glyph.bounds;
    const w = xMax - xMin;
    const h = yMax - yMin;

    // Object-space position (Y-up screen pixels)
    const ox = (cursorX + position.xOffset) * scale;
    const oy = position.yOffset * scale;
    const x0 = ox + xMin * scale;
    const y0 = oy + yMin * scale;
    const x1 = ox + xMax * scale;
    const y1 = oy + yMax * scale;

    // Band transform: maps em-space to band indices
    const bandScaleX = w > 0 ? glyph.bands.vBandCount / w : 0;
    const bandScaleY = h > 0 ? glyph.bands.hBandCount / h : 0;
    const bandOffsetX = -xMin * bandScaleX;
    const bandOffsetY = -yMin * bandScaleY;

    // Pack tex.z: glyph location in band texture (u16 x, u16 y → bitcast to f32)
    const glyphLocPacked = packU32AsF32((glyphLocY << 16) | glyphLocX);

    // Pack tex.w: band max indices (bandMaxX in bits 0-7, bandMaxY in bits 16-23)
    const bandMaxX = glyph.bands.vBandCount - 1;
    const bandMaxY = glyph.bands.hBandCount - 1;
    const bandMaxPacked = packU32AsF32((bandMaxY << 16) | bandMaxX);

    // Inverse Jacobian: d(em)/d(obj) = 1/scale (uniform scaling)
    const invScale = 1 / scale;

    // 4 corners: (objX, objY, normX, normY, emX, emY)
    const corners: [number, number, number, number, number, number][] = [
      [x0, y0, -1, -1, xMin, yMin],
      [x1, y0, 1, -1, xMax, yMin],
      [x1, y1, 1, 1, xMax, yMax],
      [x0, y1, -1, 1, xMin, yMax],
    ];

    for (const [px, py, nx, ny, ex, ey] of corners) {
      verts.push(
        // pos (location 0): object-space position + normal
        px,
        py,
        nx,
        ny,
        // tex (location 1): em-space coords + packed glyph/band data
        ex,
        ey,
        glyphLocPacked,
        bandMaxPacked,
        // jac (location 2): inverse Jacobian (d(em)/d(obj))
        invScale,
        0,
        0,
        invScale,
        // bnd (location 3): band transform (scale + offset)
        bandScaleX,
        bandScaleY,
        bandOffsetX,
        bandOffsetY,
        // col (location 4): vertex color
        1,
        1,
        1,
        1,
      );
    }

    const base = quadIdx * 4;
    idxs.push(base, base + 1, base + 2, base, base + 2, base + 3);
    cursorX += position.xAdvance;
    quadIdx++;
  }

  return {
    slugGlyphs,
    vertices: new Float32Array(verts),
    indices: new Uint32Array(idxs),
    curveTexData: packed.curveTexData,
    bandTexData: packed.bandTexData,
    curveTexHeight: packed.curveTexHeight,
    bandTexHeight: packed.bandTexHeight,
    totalAdvance: cursorX,
  };
}
