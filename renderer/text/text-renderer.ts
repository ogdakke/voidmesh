import { Font } from "text-shaper";
import { prepareText } from "./slug.ts";
import vertexShaderSource from "./text-vertex.wgsl?raw";
import fragmentShaderSource from "./text-fragment.wgsl?raw";

const TEX_WIDTH = 4096;
const TEXT_UNIFORM_FLOATS = 20;

interface TextViewport {
  offsetX: number;
  offsetY: number;
  zoom: number;
  width: number;
  height: number;
}

interface TextItem {
  text: string | null;
  slugData?: ReturnType<typeof prepareText>;
  worldX: number;
  worldY: number;
  fontSize: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * GPU text renderer using the Slug algorithm.
 * Renders resolution-independent vector text directly in the WebGPU pipeline.
 *
 * Usage per frame:
 *   textRenderer.begin()
 *   textRenderer.drawText("Label", worldX, worldY, 14, 1, 1, 1, 1)
 *   textRenderer.flush(encoder, swapchainView)
 */
export class TextRenderer {
  #device: GPUDevice;
  #canvasFormat: GPUTextureFormat;

  #pipeline: GPURenderPipeline | null = null;
  #bindGroupLayout: GPUBindGroupLayout | null = null;
  #font: Font | null = null;
  #ready = false;
  #viewport: TextViewport | null = null;

  // Per-frame text queue
  #queue: TextItem[] = [];

  // GPU resources kept alive between begin() and next begin()
  // (destroyed at the start of the next frame, after submit has completed)
  #pendingDestroy: Array<GPUBuffer | GPUTexture> = [];

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.#device = device;
    this.#canvasFormat = canvasFormat;
  }

  async initialize(): Promise<void> {
    const fontData = await fetch("/Inter.ttf").then((r) => r.arrayBuffer());
    this.#font = Font.load(fontData);

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Text bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "unfilterable-float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint" },
        },
      ],
    });

    const vertexModule = this.#device.createShaderModule({
      label: "Text vertex shader",
      code: vertexShaderSource,
    });
    const fragmentModule = this.#device.createShaderModule({
      label: "Text fragment shader",
      code: fragmentShaderSource,
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Text render pipeline",
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#bindGroupLayout],
      }),
      vertex: {
        module: vertexModule,
        entryPoint: "main",
        buffers: [
          {
            arrayStride: 80,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" as const },
              { shaderLocation: 1, offset: 16, format: "float32x4" as const },
              { shaderLocation: 2, offset: 32, format: "float32x4" as const },
              { shaderLocation: 3, offset: 48, format: "float32x4" as const },
              { shaderLocation: 4, offset: 64, format: "float32x4" as const },
            ],
          },
        ],
      },
      fragment: {
        module: fragmentModule,
        entryPoint: "main",
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
      primitive: { topology: "triangle-list" },
    });

    this.#ready = true;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  /** The loaded font instance, or null if not yet initialized. */
  get font(): Font | null {
    return this.#font;
  }

  setViewport(viewport: TextViewport): void {
    this.#viewport = viewport;
  }

  /** Clear the text queue for a new frame and release previous frame's GPU resources. */
  begin(): void {
    // Destroy resources from the previous frame (submit has completed by now)
    for (const resource of this.#pendingDestroy) {
      resource.destroy();
    }
    this.#pendingDestroy.length = 0;
    this.#queue.length = 0;
  }

  /** Queue text to be drawn at a world-space position. */
  drawText(
    textOrSlugData: string | ReturnType<typeof prepareText>,
    worldX: number,
    worldY: number,
    fontSize: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if (!this.#ready) return;
    if (typeof textOrSlugData === "string") {
      if (textOrSlugData.length === 0) return;
      this.#queue.push({ text: textOrSlugData, worldX, worldY, fontSize, r, g, b, a });
    } else {
      this.#queue.push({
        text: null,
        slugData: textOrSlugData,
        worldX,
        worldY,
        fontSize,
        r,
        g,
        b,
        a,
      });
    }
  }

  /** Build GPU buffers from queued text and encode render passes. */
  flush(encoder: GPUCommandEncoder, swapchainView: GPUTextureView): void {
    if (
      !this.#ready ||
      !this.#font ||
      !this.#pipeline ||
      !this.#bindGroupLayout ||
      this.#queue.length === 0
    )
      return;

    for (const item of this.#queue) {
      this.#renderItem(encoder, swapchainView, item);
    }
    this.#queue.length = 0;
  }

  #renderItem(encoder: GPUCommandEncoder, swapchainView: GPUTextureView, item: TextItem): void {
    const font = this.#font!;
    const slugData = item.slugData ?? prepareText(font, item.text!, item.fontSize);
    if (slugData.indices.length === 0) return;

    if (!this.#viewport) return;

    const scale = font.scaleForSize(item.fontSize);
    const totalWidth = slugData.totalAdvance * scale;
    const descender = font.descender * scale; // negative value

    // Position: centered horizontally on worldX
    const offsetX = item.worldX - totalWidth / 2;
    // Keep the vendor Y-up local glyph space intact and bake the placement into the
    // Slug MVP matrix. worldY denotes the bottom text edge in world-space coordinates.
    const offsetY = item.worldY + descender;

    // Copy reference vertex data and inject custom color only.
    const verts = new Float32Array(slugData.vertices.length);
    for (let i = 0; i < slugData.vertices.length; i += 20) {
      verts[i] = slugData.vertices[i]!;
      verts[i + 1] = slugData.vertices[i + 1]!;
      verts[i + 2] = slugData.vertices[i + 2]!;
      verts[i + 3] = slugData.vertices[i + 3]!;
      verts[i + 4] = slugData.vertices[i + 4]!;
      verts[i + 5] = slugData.vertices[i + 5]!;
      verts[i + 6] = slugData.vertices[i + 6]!;
      verts[i + 7] = slugData.vertices[i + 7]!;
      verts[i + 8] = slugData.vertices[i + 8]!;
      verts[i + 9] = slugData.vertices[i + 9]!;
      verts[i + 10] = slugData.vertices[i + 10]!;
      verts[i + 11] = slugData.vertices[i + 11]!;
      verts[i + 12] = slugData.vertices[i + 12]!;
      verts[i + 13] = slugData.vertices[i + 13]!;
      verts[i + 14] = slugData.vertices[i + 14]!;
      verts[i + 15] = slugData.vertices[i + 15]!;
      verts[i + 16] = item.r;
      verts[i + 17] = item.g;
      verts[i + 18] = item.b;
      verts[i + 19] = item.a;
    }

    const sx = (2 * this.#viewport.zoom) / this.#viewport.width;
    const sy = (-2 * this.#viewport.zoom) / this.#viewport.height;
    const tx = sx * offsetX - this.#viewport.offsetX * sx - 1;
    const ty = sy * offsetY - this.#viewport.offsetY * sy + 1;

    const uniformData = new Float32Array(TEXT_UNIFORM_FLOATS);
    uniformData.set(
      [
        sx,
        0,
        0,
        tx,
        0,
        -sy,
        0,
        ty,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        this.#viewport.width,
        this.#viewport.height,
        0,
        0,
      ],
      0,
    );

    const uniformBuffer = this.#device.createBuffer({
      label: "Text uniforms",
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const vertexBuffer = this.#device.createBuffer({
      label: "Text vertex buffer",
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(vertexBuffer, 0, verts);

    const indexBuffer = this.#device.createBuffer({
      label: "Text index buffer",
      size: slugData.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(indexBuffer, 0, slugData.indices);

    const curveTexture = this.#device.createTexture({
      label: "Text curve texture",
      size: { width: TEX_WIDTH, height: slugData.curveTexHeight },
      format: "rgba32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture: curveTexture },
      slugData.curveTexData,
      { bytesPerRow: TEX_WIDTH * 16 },
      { width: TEX_WIDTH, height: slugData.curveTexHeight },
    );

    const bandTexture = this.#device.createTexture({
      label: "Text band texture",
      size: { width: TEX_WIDTH, height: slugData.bandTexHeight },
      format: "rgba32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture: bandTexture },
      slugData.bandTexData,
      { bytesPerRow: TEX_WIDTH * 16 },
      { width: TEX_WIDTH, height: slugData.bandTexHeight },
    );

    const bindGroup = this.#device.createBindGroup({
      label: "Text bind group",
      layout: this.#bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: curveTexture.createView() },
        { binding: 2, resource: bandTexture.createView() },
      ],
    });

    // Render text glyphs
    const pass = encoder.beginRenderPass({
      label: "Text render pass",
      colorAttachments: [
        {
          view: swapchainView,
          loadOp: "load" as const,
          storeOp: "store" as const,
        },
      ],
    });
    pass.setPipeline(this.#pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, "uint32");
    pass.drawIndexed(slugData.indices.length);
    pass.end();

    // Defer destruction — resources must stay alive until after submit()
    this.#pendingDestroy.push(uniformBuffer, vertexBuffer, indexBuffer, curveTexture, bandTexture);
  }

  destroy(): void {
    for (const resource of this.#pendingDestroy) {
      resource.destroy();
    }
    this.#pendingDestroy.length = 0;
    this.#pipeline = null;
    this.#bindGroupLayout = null;
    this.#font = null;
    this.#ready = false;
  }
}
