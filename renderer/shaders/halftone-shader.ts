import { HalftoneKind } from "#types/canvas.ts";
import type { EffectRenderEntity } from "../effect-render-entity.ts";
import halftoneShaderSource from "../halftone.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

const KIND_INDEX: Record<HalftoneKind, number> = {
  [HalftoneKind.classic]: 0,
  [HalftoneKind.newsprint]: 1,
  [HalftoneKind.cmyk]: 2,
  [HalftoneKind.riso]: 3,
};

function unorm8(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

export class HalftoneShader extends ShaderPass {
  getShaderSource(): string {
    return halftoneShaderSource;
  }

  writeVariantUniforms(entity: EffectRenderEntity): void {
    this.ctx.floatView[7] = entity.shaderParams.halftone?.angle ?? 0;
  }

  override writeUniforms(entity: EffectRenderEntity): void {
    super.writeUniforms(entity);
    const halftone = entity.shaderParams.halftone;
    const kind = KIND_INDEX[halftone?.kind ?? HalftoneKind.classic];
    const u = this.ctx.uintView;
    // Offsets 9 and 11 are palette-metadata padding for halftone; written after the base pass.
    u[9] = kind;
    u[11] =
      unorm8(halftone?.dotGain ?? 0) |
      (unorm8(halftone?.paper ?? 0) << 8) |
      (unorm8(halftone?.misregistration ?? 0) << 16);
    // Print kinds hide `scale`; the slot carries pixel scale so paper texture stays LOD-stable.
    if (kind !== 0) this.ctx.floatView[2] = entity.pixelScale;
  }
}
