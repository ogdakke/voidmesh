import type { ShaderParams, ShaderType } from "#types/canvas.ts";

export interface EffectShaderSettings {
  shaderType: ShaderType;
  shaderParams: ShaderParams;
}

export interface EffectRenderEntity extends EffectShaderSettings {
  id: string;
  originalSize: { width: number; height: number };
  /** Scale from authored media pixels to the current render texture's pixels. */
  pixelScale: number;
}
