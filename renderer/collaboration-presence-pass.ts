import type {
  CollaborationPeerPresence,
  Point,
  RGBA,
  ShaderCanvasEntity,
  Viewport,
} from "#types/canvas.ts";
import shapeShaderSource from "./collaboration-presence.wgsl?raw";
import labelShaderSource from "./entity-label.wgsl?raw";

const VERTEX_FLOATS = 6;
const VERTEX_BYTES = VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const LABEL_UNIFORM_BYTES = 32;
const CURSOR_WIDTH = 18;
const CURSOR_HEIGHT = 25;
const LABEL_GAP = 3;
const LABEL_PADDING_X = 7;
const LABEL_PADDING_Y = 4;
const FONT_SIZE = 13;
const MAX_LABEL_WIDTH = 220;
const FONT_FAMILY =
  'ui-rounded, "Arial Rounded MT Bold", "Arial Rounded MT", system-ui, sans-serif';

interface LabelEntry {
  texture: GPUTexture;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  width: number;
  height: number;
  identityKey: string;
}

export class CollaborationPresencePass {
  readonly #device: GPUDevice;
  readonly #format: GPUTextureFormat;
  readonly #viewportUniformBuffer: GPUBuffer;
  readonly #canvas = new OffscreenCanvas(1, 1);
  readonly #context: OffscreenCanvasRenderingContext2D;
  #shapePipeline: GPURenderPipeline | null = null;
  #shapeBindGroup: GPUBindGroup | null = null;
  #labelPipeline: GPURenderPipeline | null = null;
  #labelBindGroupLayout: GPUBindGroupLayout | null = null;
  #sampler: GPUSampler | null = null;
  #selectionBuffer: GPUBuffer | null = null;
  #selectionBufferBytes = 0;
  #selectionVertexCount = 0;
  #selectionPresenceVersion = -1;
  #selectionEntityVersion = -1;
  #selectionGeometryVersion = -1;
  #selectionZoom = -1;
  #selectionDpr = -1;
  readonly #labels = new Map<string, LabelEntry>();

  constructor(device: GPUDevice, format: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#format = format;
    this.#viewportUniformBuffer = viewportUniformBuffer;
    const context = this.#canvas.getContext("2d");
    if (!context) throw new Error("Unable to create collaboration label canvas");
    this.#context = context;
    this.#initialize();
  }

  encode({
    encoder,
    targetView,
    presences,
    entities,
    presenceSelectionVersion,
    entityVersion,
    geometryVersion,
    viewport,
  }: {
    encoder: GPUCommandEncoder;
    targetView: GPUTextureView;
    presences: readonly CollaborationPeerPresence[];
    entities: readonly ShaderCanvasEntity[];
    presenceSelectionVersion: number;
    entityVersion: number;
    geometryVersion: number;
    viewport: Viewport;
  }): void {
    if (presences.length === 0 || !this.#shapePipeline || !this.#labelPipeline) {
      this.#pruneLabels(new Set());
      return;
    }
    const dpr = devicePixelRatio || 1;
    if (
      this.#selectionPresenceVersion !== presenceSelectionVersion ||
      this.#selectionEntityVersion !== entityVersion ||
      this.#selectionGeometryVersion !== geometryVersion ||
      this.#selectionZoom !== viewport.zoom ||
      this.#selectionDpr !== dpr
    ) {
      this.#rebuildSelectionGeometry(presences, entities, viewport);
      this.#selectionPresenceVersion = presenceSelectionVersion;
      this.#selectionEntityVersion = entityVersion;
      this.#selectionGeometryVersion = geometryVersion;
      this.#selectionZoom = viewport.zoom;
      this.#selectionDpr = dpr;
    }

    const visibleCursors = presences.filter((presence) => presence.cursor !== null);
    if (this.#selectionVertexCount === 0 && visibleCursors.length === 0) return;
    const pass = encoder.beginRenderPass({
      label: "Collaboration presence pass",
      colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }],
    });
    if (this.#selectionVertexCount > 0 && this.#selectionBuffer) {
      pass.setPipeline(this.#shapePipeline);
      pass.setBindGroup(0, this.#shapeBindGroup!);
      pass.setVertexBuffer(0, this.#selectionBuffer);
      pass.draw(this.#selectionVertexCount);
    }

    const livePeerIds = new Set<string>();
    for (const presence of visibleCursors) {
      livePeerIds.add(presence.peerId);
      this.#drawCursorLabel(pass, presence, viewport);
    }
    pass.end();
    this.#pruneLabels(livePeerIds);
  }

  destroy(): void {
    this.#selectionBuffer?.destroy();
    this.#selectionBuffer = null;
    for (const entry of this.#labels.values()) {
      entry.texture.destroy();
      entry.uniformBuffer.destroy();
    }
    this.#labels.clear();
    this.#shapePipeline = null;
    this.#shapeBindGroup = null;
    this.#labelPipeline = null;
    this.#labelBindGroupLayout = null;
    this.#sampler = null;
  }

  #initialize(): void {
    const shapeLayout = this.#device.createBindGroupLayout({
      label: "Collaboration selection layout",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    this.#shapeBindGroup = this.#device.createBindGroup({
      label: "Collaboration selection bind group",
      layout: shapeLayout,
      entries: [{ binding: 0, resource: { buffer: this.#viewportUniformBuffer } }],
    });
    const shapeModule = this.#device.createShaderModule({
      label: "Collaboration selection shader",
      code: shapeShaderSource,
    });
    this.#shapePipeline = this.#device.createRenderPipeline({
      label: "Collaboration selection pipeline",
      layout: this.#device.createPipelineLayout({ bindGroupLayouts: [shapeLayout] }),
      vertex: {
        module: shapeModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: VERTEX_BYTES,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module: shapeModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#format, blend: alphaBlend() }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.#sampler = this.#device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.#labelBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Collaboration cursor label layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const labelModule = this.#device.createShaderModule({
      label: "Collaboration cursor label shader",
      code: labelShaderSource,
    });
    this.#labelPipeline = this.#device.createRenderPipeline({
      label: "Collaboration cursor label pipeline",
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#labelBindGroupLayout],
      }),
      vertex: { module: labelModule, entryPoint: "vs_main" },
      fragment: {
        module: labelModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.#format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  #rebuildSelectionGeometry(
    presences: readonly CollaborationPeerPresence[],
    entities: readonly ShaderCanvasEntity[],
    viewport: Viewport,
  ): void {
    const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
    const vertices: number[] = [];
    const borderWidth = (2 * (devicePixelRatio || 1)) / viewport.zoom;
    for (const presence of presences) {
      const selected: ShaderCanvasEntity[] = [];
      for (const entityId of presence.selectedEntityIds) {
        const entity = entitiesById.get(entityId);
        if (!entity) continue;
        selected.push(entity);
        appendRotatedOutline(vertices, entity, borderWidth, presence.color);
      }
      if (selected.length > 1) {
        appendGroupOutline(vertices, selected, borderWidth * 0.65, presence.color);
      }
    }
    const data = new Float32Array(vertices);
    this.#selectionVertexCount = data.length / VERTEX_FLOATS;
    if (data.byteLength === 0) return;
    if (!this.#selectionBuffer || this.#selectionBufferBytes < data.byteLength) {
      this.#selectionBuffer?.destroy();
      this.#selectionBufferBytes = nextPowerOfTwo(data.byteLength);
      this.#selectionBuffer = this.#device.createBuffer({
        label: "Collaboration selection vertices",
        size: this.#selectionBufferBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.#device.queue.writeBuffer(this.#selectionBuffer, 0, data);
  }

  #drawCursorLabel(
    pass: GPURenderPassEncoder,
    presence: CollaborationPeerPresence,
    viewport: Viewport,
  ): void {
    if (!presence.cursor || !this.#labelPipeline) return;
    const entry = this.#getLabel(presence);
    const data = new Float32Array(LABEL_UNIFORM_BYTES / 4);
    data[0] = presence.cursor.x;
    data[1] = presence.cursor.y;
    data[2] = entry.width / viewport.zoom;
    data[3] = entry.height / viewport.zoom;
    data[4] = 1;
    this.#device.queue.writeBuffer(entry.uniformBuffer, 0, data);
    pass.setPipeline(this.#labelPipeline);
    pass.setBindGroup(0, entry.bindGroup);
    pass.draw(6);
  }

  #getLabel(presence: CollaborationPeerPresence): LabelEntry {
    const dpr = devicePixelRatio || 1;
    const identityKey = `${presence.name}:${presence.color.join(",")}:${dpr}`;
    const existing = this.#labels.get(presence.peerId);
    if (existing?.identityKey === identityKey) return existing;
    existing?.texture.destroy();
    existing?.uniformBuffer.destroy();
    const size = this.#rasterizeLabel(presence, dpr);
    const texture = this.#device.createTexture({
      label: `Collaboration cursor ${presence.peerId}`,
      size: [size.width, size.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const uniformBuffer = this.#device.createBuffer({
      label: `Collaboration cursor ${presence.peerId} uniforms`,
      size: LABEL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.#device.createBindGroup({
      label: `Collaboration cursor ${presence.peerId} bind group`,
      layout: this.#labelBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: texture.createView() },
        { binding: 3, resource: this.#sampler! },
      ],
    });
    this.#device.queue.copyExternalImageToTexture({ source: this.#canvas }, { texture }, [
      size.width,
      size.height,
    ]);
    const entry = { texture, uniformBuffer, bindGroup, ...size, identityKey };
    this.#labels.set(presence.peerId, entry);
    return entry;
  }

  #rasterizeLabel(
    presence: CollaborationPeerPresence,
    dpr: number,
  ): { width: number; height: number } {
    const ctx = this.#context;
    const fontSize = FONT_SIZE * dpr;
    ctx.font = `600 ${fontSize}px ${FONT_FAMILY}`;
    const textWidth = Math.min(ctx.measureText(presence.name).width, MAX_LABEL_WIDTH * dpr);
    const labelWidth = textWidth + LABEL_PADDING_X * 2 * dpr;
    const labelHeight = fontSize + LABEL_PADDING_Y * 2 * dpr;
    const width = Math.ceil((CURSOR_WIDTH + LABEL_GAP) * dpr + labelWidth + 3 * dpr);
    const height = Math.ceil(Math.max(CURSOR_HEIGHT * dpr, labelHeight) + 3 * dpr);
    this.#canvas.width = width;
    this.#canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.font = `600 ${fontSize}px ${FONT_FAMILY}`;
    const color = toCssColor(presence.color);

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
    ctx.shadowBlur = 2 * dpr;
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    ctx.moveTo(1.5 * dpr, 1.5 * dpr);
    ctx.lineTo(16 * dpr, 14 * dpr);
    ctx.lineTo(9.5 * dpr, 15.5 * dpr);
    ctx.lineTo(13 * dpr, 23 * dpr);
    ctx.lineTo(9 * dpr, 24.5 * dpr);
    ctx.lineTo(5.5 * dpr, 17 * dpr);
    ctx.lineTo(1.5 * dpr, 22 * dpr);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const labelX = (CURSOR_WIDTH + LABEL_GAP) * dpr;
    const labelY = 2 * dpr;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(labelX, labelY, labelWidth, labelHeight, labelHeight / 2);
    ctx.fill();
    ctx.fillStyle = "white";
    ctx.textBaseline = "middle";
    ctx.fillText(
      presence.name,
      labelX + LABEL_PADDING_X * dpr,
      labelY + labelHeight / 2,
      MAX_LABEL_WIDTH * dpr,
    );
    return { width, height };
  }

  #pruneLabels(livePeerIds: ReadonlySet<string>): void {
    for (const [peerId, entry] of this.#labels) {
      if (livePeerIds.has(peerId)) continue;
      entry.texture.destroy();
      entry.uniformBuffer.destroy();
      this.#labels.delete(peerId);
    }
  }
}

function appendRotatedOutline(
  vertices: number[],
  entity: ShaderCanvasEntity,
  thickness: number,
  color: RGBA,
): void {
  const center = {
    x: entity.position.x + entity.size.width / 2,
    y: entity.position.y + entity.size.height / 2,
  };
  const radians = (entity.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = entity.size.width / 2;
  const halfHeight = entity.size.height / 2;
  const corners = [
    rotatePoint(-halfWidth, -halfHeight, center, cos, sin),
    rotatePoint(halfWidth, -halfHeight, center, cos, sin),
    rotatePoint(halfWidth, halfHeight, center, cos, sin),
    rotatePoint(-halfWidth, halfHeight, center, cos, sin),
  ];
  appendOutline(vertices, corners, thickness, color);
}

function appendGroupOutline(
  vertices: number[],
  entities: readonly ShaderCanvasEntity[],
  thickness: number,
  color: RGBA,
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const entity of entities) {
    const center = {
      x: entity.position.x + entity.size.width / 2,
      y: entity.position.y + entity.size.height / 2,
    };
    const radians = (entity.rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    for (const [x, y] of [
      [-entity.size.width / 2, -entity.size.height / 2],
      [entity.size.width / 2, -entity.size.height / 2],
      [entity.size.width / 2, entity.size.height / 2],
      [-entity.size.width / 2, entity.size.height / 2],
    ] as const) {
      const point = rotatePoint(x, y, center, cos, sin);
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  const faded = [color[0], color[1], color[2], color[3] * 0.7] as RGBA;
  appendOutline(
    vertices,
    [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
    thickness,
    faded,
  );
}

function appendOutline(
  vertices: number[],
  corners: readonly Point[],
  thickness: number,
  color: RGBA,
): void {
  for (let index = 0; index < corners.length; index++) {
    const start = corners[index]!;
    const end = corners[(index + 1) % corners.length]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length === 0) continue;
    const nx = (-(end.y - start.y) / length) * (thickness / 2);
    const ny = ((end.x - start.x) / length) * (thickness / 2);
    appendQuad(
      vertices,
      { x: start.x + nx, y: start.y + ny },
      { x: end.x + nx, y: end.y + ny },
      { x: end.x - nx, y: end.y - ny },
      { x: start.x - nx, y: start.y - ny },
      color,
    );
  }
}

function appendQuad(output: number[], a: Point, b: Point, c: Point, d: Point, color: RGBA): void {
  appendVertex(output, a, color);
  appendVertex(output, b, color);
  appendVertex(output, c, color);
  appendVertex(output, a, color);
  appendVertex(output, c, color);
  appendVertex(output, d, color);
}

function appendVertex(output: number[], point: Point, color: RGBA): void {
  output.push(point.x, point.y, color[0], color[1], color[2], color[3]);
}

function rotatePoint(x: number, y: number, center: Point, cos: number, sin: number): Point {
  return { x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos };
}

function alphaBlend(): GPUBlendState {
  return {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  };
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(4, value)));
}

function toCssColor(color: RGBA): string {
  return `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${color[3]})`;
}
