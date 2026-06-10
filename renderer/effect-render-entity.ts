import type { ShaderParams, ShaderType } from "#types/canvas.ts";

export interface EffectRenderEntity {
  id: string;
  originalSize: { width: number; height: number };
  shaderType: ShaderType;
  shaderParams: ShaderParams;
}
