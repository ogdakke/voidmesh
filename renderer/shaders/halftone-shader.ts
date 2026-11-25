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
  }
}
