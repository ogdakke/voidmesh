import { CausticsKind } from "#types/canvas.ts";
import type { EffectRenderEntity } from "../effect-render-entity.ts";
import causticsShaderSource from "../caustics.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

const CAUSTICS_KIND_INDEX: Record<string, number> = {
  [CausticsKind.pool]: 0,
  [CausticsKind.crystal]: 1,
  [CausticsKind.lunar]: 2,
  [CausticsKind.oil]: 3,
};

export class CausticsShader extends ShaderPass {
  getShaderSource(): string {
    return causticsShaderSource;
  }
  writeVariantUniforms(entity: EffectRenderEntity): void {
    this.ctx.uintView[7] =
      CAUSTICS_KIND_INDEX[entity.shaderParams.caustics?.kind ?? CausticsKind.pool] ?? 0;
  }
}
