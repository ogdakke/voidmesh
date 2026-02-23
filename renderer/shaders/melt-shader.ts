import type { ShaderCanvasEntity } from "#types/canvas.ts";
import meltShaderSource from "../melt.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

export class MeltShader extends ShaderPass {
  getShaderSource(): string {
    return meltShaderSource;
  }

  writeVariantUniforms(entity: ShaderCanvasEntity): void {
    // Melt doesn't use the variant field, write default eagerness for layout compatibility
    this.ctx.floatView[7] = entity.shaderParams.blobs?.eagerness ?? 0.5;
  }
}
