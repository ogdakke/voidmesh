import { TopographicKind } from "#types/canvas.ts";
import type { EffectRenderEntity } from "../effect-render-entity.ts";
import topographicShaderSource from "../topographic.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";
const TOPOGRAPHIC_KIND_INDEX: Record<string, number> = {
  [TopographicKind.contourLines]: 0,
  [TopographicKind.thermalMap]: 1,
  [TopographicKind.bathymetry]: 2,
  [TopographicKind.weatherRadar]: 3,
  [TopographicKind.seismicLines]: 4,
};
export class TopographicShader extends ShaderPass {
  getShaderSource(): string {
    return topographicShaderSource;
  }
  writeVariantUniforms(entity: EffectRenderEntity): void {
    this.ctx.uintView[7] =
      TOPOGRAPHIC_KIND_INDEX[
        entity.shaderParams.topographic?.kind ?? TopographicKind.contourLines
      ] ?? 0;
  }
}
