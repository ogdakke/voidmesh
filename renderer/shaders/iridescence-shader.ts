import { IridescenceKind } from "#types/canvas.ts";
import type { EffectRenderEntity } from "../effect-render-entity.ts";
import iridescenceShaderSource from "../iridescence.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";
const IRIDESCENCE_KIND_INDEX: Record<string, number> = {
  [IridescenceKind.foil]: 0,
  [IridescenceKind.soapBubble]: 1,
  [IridescenceKind.pearl]: 2,
  [IridescenceKind.cdDiffraction]: 3,
  [IridescenceKind.prismaticChrome]: 4,
};
export class IridescenceShader extends ShaderPass {
  getShaderSource(): string {
    return iridescenceShaderSource;
  }
  writeVariantUniforms(entity: EffectRenderEntity): void {
    this.ctx.uintView[7] =
      IRIDESCENCE_KIND_INDEX[entity.shaderParams.iridescence?.kind ?? IridescenceKind.foil] ?? 0;
  }
}
