import type { UILayoutIcon } from "./ui-layout.ts";
import { getIconRasterSize, type UIIconCache } from "./ui-icon-cache.ts";
import shaderSource from "./ui-icon.wgsl?raw";

const ICON_RASTER_UPGRADE_THRESHOLD = 1.25;
const MAX_ICONS = 16;

// IconUniforms layout:
// iconCount (u32) + 3x u32 padding = 16 bytes
// icons: MAX_ICONS × IconData (2 × vec4f = 32 bytes) = 512 bytes
// Total: 528 bytes
const ICON_UNIFORMS_SIZE = 16 + MAX_ICONS * 32;

export class UIIconPipeline {
  #device: GPUDevice;
  #pipeline!: GPURenderPipeline;
  #bindGroupLayout!: GPUBindGroupLayout;
  #sampler!: GPUSampler;
  #viewportUniformBuffer: GPUBuffer;
  #canvasFormat: GPUTextureFormat;
  #textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();

  #uniformData = new ArrayBuffer(ICON_UNIFORMS_SIZE);
  #uniformU32View = new Uint32Array(this.#uniformData);
  #uniformF32View = new Float32Array(this.#uniformData);

  #uniformSlots: Array<{
    buffer: GPUBuffer;
    bindGroups: WeakMap<GPUTexture, GPUBindGroup>;
  }> = [];
  #slotCursor = 0;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#canvasFormat = canvasFormat;
    this.#viewportUniformBuffer = viewportUniformBuffer;
  }

  initialize(): void {
    this.#sampler = this.#device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    const shaderModule = this.#device.createShaderModule({
      code: shaderSource,
    });

    this.#pipeline = this.#device.createRenderPipeline({
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.#canvasFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  /** Clean up staging buffers from the previous frame. Call at start of frame. */
  begin(): void {
    this.#slotCursor = 0;
  }

  /**
   * Render icons batched by texture into an existing render pass.
   * Icons sharing the same texture are drawn in a single instanced draw call
   * (up to MAX_ICONS per batch). Skips icons whose textures aren't cached yet.
   */
  render(
    icons: UILayoutIcon[],
    iconCache: UIIconCache,
    pixelScale: number,
    pass: GPURenderPassEncoder,
  ): void {
    // Resolve textures and group icons by GPU texture
    type ResolvedIcon = { icon: UILayoutIcon; texture: GPUTexture };
    const resolved: ResolvedIcon[] = [];

    for (const icon of icons) {
      const textureMatch = iconCache.getBest(icon.svg, icon.width, icon.height, pixelScale);
      if (!textureMatch) {
        iconCache.preload(icon.svg, icon.width, icon.height, pixelScale);
        continue;
      }

      const requestedSize = getIconRasterSize(icon.width, icon.height, pixelScale);
      if (
        !textureMatch.exact &&
        (requestedSize.width > textureMatch.rasterWidth * ICON_RASTER_UPGRADE_THRESHOLD ||
          requestedSize.height > textureMatch.rasterHeight * ICON_RASTER_UPGRADE_THRESHOLD)
      ) {
        iconCache.preload(icon.svg, icon.width, icon.height, pixelScale);
      }

      resolved.push({ icon, texture: textureMatch.texture });
    }

    if (resolved.length === 0) return;

    // Group by texture
    const textureGroups = new Map<GPUTexture, UILayoutIcon[]>();
    for (const { icon, texture } of resolved) {
      let group = textureGroups.get(texture);
      if (!group) {
        group = [];
        textureGroups.set(texture, group);
      }
      group.push(icon);
    }

    pass.setPipeline(this.#pipeline);

    // Draw each texture group in batches of MAX_ICONS
    for (const [texture, group] of textureGroups) {
      for (let batchStart = 0; batchStart < group.length; batchStart += MAX_ICONS) {
        const batchEnd = Math.min(batchStart + MAX_ICONS, group.length);
        const batchCount = batchEnd - batchStart;

        this.#writeIconData(group, batchStart, batchCount);

        const slot = this.#getUniformSlot(this.#slotCursor);
        this.#slotCursor++;
        this.#device.queue.writeBuffer(slot.buffer, 0, this.#uniformData, 0, ICON_UNIFORMS_SIZE);

        pass.setBindGroup(0, this.#getBindGroup(slot, texture));
        pass.draw(6, batchCount);
      }
    }
  }

  #writeIconData(icons: UILayoutIcon[], offset: number, count: number): void {
    const u32 = this.#uniformU32View;
    const f32 = this.#uniformF32View;

    // Header: iconCount + padding (16 bytes = 4 u32s)
    u32[0] = count;
    u32[1] = 0;
    u32[2] = 0;
    u32[3] = 0;

    // Each IconData is 32 bytes = 8 floats
    for (let i = 0; i < count; i++) {
      const icon = icons[offset + i]!;
      const base = 4 + i * 8; // 4 floats header + 8 floats per icon

      // rect: x, y, width, height
      f32[base] = icon.x;
      f32[base + 1] = icon.y;
      f32[base + 2] = icon.width;
      f32[base + 3] = icon.height;

      // tint: r, g, b, a (premultiply opacity into alpha)
      f32[base + 4] = icon.tint.r;
      f32[base + 5] = icon.tint.g;
      f32[base + 6] = icon.tint.b;
      f32[base + 7] = icon.tint.a * icon.opacity;
    }
  }

  #getTextureView(texture: GPUTexture): GPUTextureView {
    const cached = this.#textureViewCache.get(texture);
    if (cached) return cached;
    const view = texture.createView();
    this.#textureViewCache.set(texture, view);
    return view;
  }

  #getUniformSlot(index: number): {
    buffer: GPUBuffer;
    bindGroups: WeakMap<GPUTexture, GPUBindGroup>;
  } {
    const existing = this.#uniformSlots[index];
    if (existing) return existing;

    const slot = {
      buffer: this.#device.createBuffer({
        label: "UI icon uniforms",
        size: ICON_UNIFORMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      bindGroups: new WeakMap<GPUTexture, GPUBindGroup>(),
    };
    this.#uniformSlots.push(slot);
    return slot;
  }

  #getBindGroup(
    slot: { buffer: GPUBuffer; bindGroups: WeakMap<GPUTexture, GPUBindGroup> },
    texture: GPUTexture,
  ): GPUBindGroup {
    const cached = slot.bindGroups.get(texture);
    if (cached) return cached;

    const bindGroup = this.#device.createBindGroup({
      layout: this.#bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: slot.buffer } },
        { binding: 2, resource: this.#getTextureView(texture) },
        { binding: 3, resource: this.#sampler },
      ],
    });
    slot.bindGroups.set(texture, bindGroup);
    return bindGroup;
  }

  destroy(): void {
    for (let i = 0; i < this.#uniformSlots.length; i++) {
      this.#uniformSlots[i]!.buffer.destroy();
    }
    this.#uniformSlots.length = 0;
  }
}
