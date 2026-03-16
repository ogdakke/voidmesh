import { GlitchKind, type ShaderCanvasEntity } from "#types/canvas.ts";
import glitchShaderSource from "../glitch.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

/** Kind enum value -> uniform index */
const GLITCH_KIND_INDEX: Record<string, number> = {
  [GlitchKind.channelShift]: 0,
  [GlitchKind.scanline]: 1,
  [GlitchKind.blockCorrupt]: 2,
  [GlitchKind.pixelSmear]: 3,
};

export class GlitchShader extends ShaderPass {
  override supportsDepth(): boolean {
    return true;
  }

  getShaderSource(): string {
    return glitchShaderSource;
  }

  writeVariantUniforms(entity: ShaderCanvasEntity): void {
    const params = entity.shaderParams;
    const glitchKind = params.glitch?.kind ?? GlitchKind.channelShift;
    const kindIndex = GLITCH_KIND_INDEX[glitchKind] ?? 0;

    // Encode preserveColors as bit 8 of kind (inverted: bit set = quantize)
    const quantizeBit = params.preserveColors ? 0 : 256;

    // Offset 6: angle in degrees (overwrites preserveColors)
    this.ctx.floatView[6] = params.glitch?.angle ?? 0;
    // Offset 7: kind index | quantize flag
    this.ctx.uintView[7] = kindIndex | quantizeBit;
  }
}
