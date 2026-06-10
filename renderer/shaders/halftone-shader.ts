import type { EffectRenderEntity } from "../effect-render-entity.ts";
import halftoneShaderSource from "../halftone.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

export class HalftoneShader extends ShaderPass {
  getShaderSource(): string {
    return halftoneShaderSource;
  }

  writeVariantUniforms(entity: EffectRenderEntity): void {
    // Halftone uses eagerness at offset 7 (shared field, but unused by halftone WGSL)
    this.ctx.floatView[7] = entity.shaderParams.blobs?.eagerness ?? 0.5;
  }
}
