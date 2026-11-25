import type { ShaderParams, ShaderType } from "#types/canvas.ts";

export interface EffectShaderSettings {
  shaderType: ShaderType;
  shaderParams: ShaderParams;
}

/**
 * Texel rectangle of an effect's output that is shown this frame. A pass that honours it
 * may leave everything outside undefined; zero size means nothing shows.
 */
export interface ShaderOutputRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EffectRenderEntity extends EffectShaderSettings {
  id: string;
  originalSize: { width: number; height: number };
  /** Scale from authored media pixels to the current render texture's pixels. */
  pixelScale: number;
}
