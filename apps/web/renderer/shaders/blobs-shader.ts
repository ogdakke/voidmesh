import type { EffectRenderEntity } from "../effect-render-entity.ts";
import blobsShaderSource from "../blobs.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

export class BlobsShader extends ShaderPass {
  getShaderSource(): string {
    return blobsShaderSource;
  }

  writeVariantUniforms(entity: EffectRenderEntity): void {
    this.ctx.floatView[7] = entity.shaderParams.blobs?.eagerness ?? 0.5;
  }
}
