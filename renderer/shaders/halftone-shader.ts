import { config } from "#config";
import { PrintKind, ShaderType } from "#types/canvas.ts";
import type { EffectRenderEntity } from "../effect-render-entity.ts";
import halftoneShaderSource from "../halftone.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

/** WGSL `kind`: 0 is the classic halftone, 1-3 are the print screens. */
const PRINT_KIND_INDEX: Record<PrintKind, number> = {
  [PrintKind.newsprint]: 1,
  [PrintKind.cmyk]: 2,
  [PrintKind.riso]: 3,
};

function unorm8(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

const PALETTE_FLOAT_OFFSET = 12;
const MAX_PALETTE_COLORS = 16;
const MAX_RISO_INKS = 3;
/** Inks whose density against the paper is below this print nothing visible. */
const MIN_INK_DENSITY = 0.05;

function inkDensity(ink: number, paper: number): number {
  return -Math.log(Math.min(1, Math.max(0.02, ink / Math.max(paper, 0.05))));
}

/**
 * Riso prints dark inks on light stock, so the lightest palette colour is the paper and up to three
 * of the rest are the inks: the strongest first, then whichever differs most from those already
 * chosen. Palettes are arbitrary (most presets start dark), so palette order cannot carry this.
 * Reorders `palette` (RGBA floats, `count` colours) in place and returns the new colour count.
 */
export function arrangeRisoPalette(palette: Float32Array, count: number): number {
  const n = Math.min(count, MAX_PALETTE_COLORS);
  if (n < 2) return n;
  let paper = 0;
  let paperLum = -1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lum = 0.2126 * palette[o]! + 0.7152 * palette[o + 1]! + 0.0722 * palette[o + 2]!;
    if (lum > paperLum) {
      paperLum = lum;
      paper = i;
    }
  }
  const po = paper * 4;
  const densities: [number, number, number][] = [];
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === paper) continue;
    const o = i * 4;
    densities[i] = [
      inkDensity(palette[o]!, palette[po]!),
      inkDensity(palette[o + 1]!, palette[po + 1]!),
      inkDensity(palette[o + 2]!, palette[po + 2]!),
    ];
    candidates.push(i);
  }
  const strength = (i: number) => Math.hypot(...densities[i]!);
  const distance = (a: number, b: number) => {
    const da = densities[a]!;
    const db = densities[b]!;
    return Math.hypot(da[0] - db[0], da[1] - db[1], da[2] - db[2]);
  };
  const usable = candidates.filter((i) => strength(i) >= MIN_INK_DENSITY);
  const pool = usable.length > 0 ? usable : candidates;
  const inks: number[] = [];
  while (inks.length < MAX_RISO_INKS && inks.length < pool.length) {
    let best = -1;
    let bestScore = -1;
    for (const i of pool) {
      if (inks.includes(i)) continue;
      const score =
        inks.length === 0 ? strength(i) : Math.min(...inks.map((chosen) => distance(i, chosen)));
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    inks.push(best);
  }
  const source = palette.slice(0, n * 4);
  const order = [paper, ...inks];
  order.forEach((from, to) => palette.set(source.subarray(from * 4, from * 4 + 4), to * 4));
  return order.length;
}

/** Classic halftone and the print effect share this pass and WGSL module. */
export class HalftoneShader extends ShaderPass {
  getShaderSource(): string {
    return halftoneShaderSource;
  }

  writeVariantUniforms(entity: EffectRenderEntity): void {
    this.ctx.floatView[7] =
      entity.shaderType === ShaderType.print ? (entity.shaderParams.print?.angle ?? 0) : 0;
  }

  override writeUniforms(entity: EffectRenderEntity): void {
    super.writeUniforms(entity);
    const isPrint = entity.shaderType === ShaderType.print;
    const print = isPrint ? entity.shaderParams.print : undefined;
    const kind = isPrint
      ? PRINT_KIND_INDEX[print?.kind ?? config.defaults.shaderParams.print.kind]
      : 0;
    const u = this.ctx.uintView;
    // Offsets 9 and 11 are palette-metadata padding for halftone; written after the base pass.
    u[9] = kind;
    u[11] =
      unorm8(print?.dotGain ?? 0) |
      (unorm8(print?.paper ?? 0) << 8) |
      (unorm8(print?.misregistration ?? 0) << 16);
    // Print hides `scale`; the slot carries pixel scale so paper texture stays LOD-stable.
    if (isPrint) this.ctx.floatView[2] = entity.pixelScale;
    if (kind === PRINT_KIND_INDEX[PrintKind.riso]) {
      const palette = this.ctx.floatView.subarray(
        PALETTE_FLOAT_OFFSET,
        PALETTE_FLOAT_OFFSET + MAX_PALETTE_COLORS * 4,
      );
      u[8] = arrangeRisoPalette(palette, u[8]!);
    }
  }
}
