import { AsciiKind, type ShaderCanvasEntity } from "#types/canvas.ts";
import asciiShaderSource from "../ascii.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

// Map AsciiKind to uniform index
// Matches asciiKind values in ascii.wgsl: 0=standard, 1=extended, 2=binary, 3=minimal
const ASCII_KIND_INDEX: Record<AsciiKind, number> = {
  [AsciiKind.standard]: 0,
  [AsciiKind.extended]: 1,
  [AsciiKind.binary]: 2,
  [AsciiKind.minimal]: 3,
};

export class AsciiShader extends ShaderPass {
  #atlasTexture: GPUTexture | null = null;
  #atlasSampler: GPUSampler | null = null;

  /** Optional callback for error notifications (e.g., to show toast) */
  onEntityError?: (entityId: string, error: string) => void;

  /** Track reported errors to avoid duplicate notifications */
  #reportedErrors: Set<string> = new Set();

  override getShaderSource(): string {
    return asciiShaderSource;
  }

  override async initialize(): Promise<void> {
    await this.#loadAtlas();
    this.bindGroupLayout = this.createBindGroupLayout();
    this.pipeline = this.createPipeline();
  }

  async #loadAtlas(): Promise<void> {
    try {
      const response = await fetch("/media/ascii-atlas.png");
      if (!response.ok) {
        throw new Error(`Failed to fetch ASCII atlas: ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);

      this.#atlasTexture = this.ctx.device.createTexture({
        label: "ASCII MSDF atlas",
        size: [bitmap.width, bitmap.height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      this.ctx.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: this.#atlasTexture },
        [bitmap.width, bitmap.height],
      );

      this.#atlasSampler = this.ctx.device.createSampler({
        label: "ASCII atlas sampler",
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });

      bitmap.close();
    } catch (error) {
      console.error("Failed to load ASCII atlas:", error);
    }
  }

  override writeVariantUniforms(entity: ShaderCanvasEntity): void {
    const asciiKind = entity.shaderParams.ascii?.kind ?? AsciiKind.standard;
    this.ctx.uintView[7] = ASCII_KIND_INDEX[asciiKind];
  }

  /** Override: 5 bindings (adds atlas texture + atlas sampler) */
  protected override createBindGroupLayout(): GPUBindGroupLayout {
    return this.ctx.device.createBindGroupLayout({
      label: "ASCII shader bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });
  }

  /** Override: includes atlas texture and sampler at bindings 3, 4 */
  override createBindGroup(sourceTextureView: GPUTextureView): GPUBindGroup {
    return this.ctx.device.createBindGroup({
      label: "ASCII shader bind group",
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.ctx.uniformBuffer } },
        { binding: 1, resource: sourceTextureView },
        { binding: 2, resource: this.ctx.sampler },
        { binding: 3, resource: this.#atlasTexture!.createView() },
        { binding: 4, resource: this.#atlasSampler! },
      ],
    });
  }

  override execute(
    entity: ShaderCanvasEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
  ): void {
    if (!this.#atlasTexture || !this.#atlasSampler) {
      const errorMsg = "ASCII atlas not loaded";
      if (!this.#reportedErrors.has(entity.id)) {
        this.#reportedErrors.add(entity.id);
        this.onEntityError?.(entity.id, errorMsg);
      }
      return;
    }
    super.execute(entity, sourceTexture, outputTexture);
  }

  /** Clear error state for an entity (e.g., when entity is removed) */
  clearEntityError(entityId: string): void {
    this.#reportedErrors.delete(entityId);
  }

  override destroy(): void {
    this.#atlasTexture?.destroy();
    this.#atlasTexture = null;
    this.#atlasSampler = null;
    this.#reportedErrors.clear();
    super.destroy();
  }
}
