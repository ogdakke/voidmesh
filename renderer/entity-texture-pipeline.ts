import type { ShaderCanvasEntity } from "#types/canvas.ts";
import type { ProcessingPipeline } from "./processing-pipeline.ts";
import type { ShaderRegistry } from "./shaders/shader-registry.ts";
import type { TexturePool } from "./texture-pool.ts";
import type { CopyPass } from "./copy-pass.ts";

interface EncodeEntityTexturePipelineParams {
  device: GPUDevice;
  entity: ShaderCanvasEntity;
  sourceTexture: GPUTexture;
  outputTexture: GPUTexture;
  encoder: GPUCommandEncoder;
  width: number;
  height: number;
  processingPipeline: ProcessingPipeline;
  shaderRegistry: ShaderRegistry;
  texturePool: TexturePool | null;
  passthroughCopyPass: CopyPass;
  intermediateFormat: GPUTextureFormat;
  respectShowOriginal: boolean;
}

function releaseTexture(
  device: GPUDevice,
  texturePool: TexturePool | null,
  texture: GPUTexture,
  width: number,
  height: number,
  usage: GPUTextureUsageFlags,
): void {
  if (texturePool) {
    texturePool.release(texture, width, height, usage);
    return;
  }
  texture.destroy();
}

function acquireTexture(
  device: GPUDevice,
  texturePool: TexturePool | null,
  width: number,
  height: number,
  usage: GPUTextureUsageFlags,
  format: GPUTextureFormat,
  label: string,
): GPUTexture {
  if (texturePool) return texturePool.acquire(width, height, usage, label);
  return device.createTexture({
    label,
    size: [width, height],
    format,
    usage,
  });
}

export function encodeEntityTexturePipeline(params: EncodeEntityTexturePipelineParams): void {
  const {
    device,
    entity,
    sourceTexture,
    outputTexture,
    encoder,
    width,
    height,
    processingPipeline,
    shaderRegistry,
    texturePool,
    passthroughCopyPass,
    intermediateFormat,
    respectShowOriginal,
  } = params;

  if (respectShowOriginal && entity.shaderParams.showOriginal) {
    passthroughCopyPass.encode(encoder, sourceTexture, outputTexture);
    return;
  }

  const needsBlur = processingPipeline.needsBlur(entity);
  const needsAdjustments = processingPipeline.needsAdjustments(entity);
  const postProcessEnabled = entity.shaderParams.postProcess?.enabled ?? false;
  const preProcessUsage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.COPY_SRC;

  let shaderSourceTexture = sourceTexture;
  let blurOutputTexture: GPUTexture | null = null;
  let adjustmentsOutputTexture: GPUTexture | null = null;

  if (needsBlur) {
    blurOutputTexture = acquireTexture(
      device,
      texturePool,
      width,
      height,
      preProcessUsage,
      intermediateFormat,
      "Blur output texture",
    );
    processingPipeline.applyBlur(entity, sourceTexture, blurOutputTexture, encoder);
    shaderSourceTexture = blurOutputTexture;
  }

  if (needsAdjustments) {
    adjustmentsOutputTexture = acquireTexture(
      device,
      texturePool,
      width,
      height,
      preProcessUsage,
      intermediateFormat,
      "Adjustments output texture",
    );
    processingPipeline.applyAdjustments(
      entity,
      shaderSourceTexture,
      adjustmentsOutputTexture,
      encoder,
    );
    shaderSourceTexture = adjustmentsOutputTexture;
  }

  const postProcessUsage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.COPY_DST;
  let mainShaderOutputTexture = outputTexture;
  let postProcessIntermediateTexture: GPUTexture | null = null;

  if (postProcessEnabled) {
    postProcessIntermediateTexture = acquireTexture(
      device,
      texturePool,
      width,
      height,
      postProcessUsage,
      intermediateFormat,
      "Post-process intermediate texture",
    );
    mainShaderOutputTexture = postProcessIntermediateTexture;
  }

  shaderRegistry.applyShader(entity, shaderSourceTexture, mainShaderOutputTexture, encoder);

  if (blurOutputTexture) {
    releaseTexture(device, texturePool, blurOutputTexture, width, height, preProcessUsage);
  }
  if (adjustmentsOutputTexture) {
    releaseTexture(device, texturePool, adjustmentsOutputTexture, width, height, preProcessUsage);
  }

  if (postProcessEnabled && postProcessIntermediateTexture) {
    processingPipeline.applyPostProcessing(
      entity,
      postProcessIntermediateTexture,
      outputTexture,
      encoder,
    );
    releaseTexture(
      device,
      texturePool,
      postProcessIntermediateTexture,
      width,
      height,
      postProcessUsage,
    );
  }
}
