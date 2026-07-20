import type { RemotePeerPresence } from "#engine";
import type { Point, RGBA, ShaderCanvasEntity, Viewport } from "#types/canvas.ts";
import labelShaderSource from "./entity-label.wgsl?raw";
import shapeShaderSource from "./collaboration-presence.wgsl?raw";

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
  uniformData: Float32Array;
  width: number;
  height: number;
  name: string;
  color: RGBA;
  devicePixelRatio: number;
  lastSeenFrame: number;
}

interface GroupOutline {
  entities: ShaderCanvasEntity[];
  color: RGBA;
}

export class CollaborationPresencePass {
  readonly #device: GPUDevice;
  readonly #viewportUniformBuffer: GPUBuffer;
  readonly #canvas = new OffscreenCanvas(1, 1);
  readonly #context: OffscreenCanvasRenderingContext2D;
  #shapePipeline: GPURenderPipeline;
  #shapeBindGroup: GPUBindGroup;
  #labelPipeline: GPURenderPipeline;
  #labelBindGroupLayout: GPUBindGroupLayout;
  #sampler: GPUSampler;
  #selectionBuffer: GPUBuffer | null = null;
  #selectionBufferBytes = 0;
  #selectionVertexCount = 0;
  #selectionPresenceVersion = -1;
  #selectionEntityVersion = -1;
  #selectionGeometryVersion = -1;
  #selectionZoom = -1;
  #selectionDpr = -1;
  #frame = 0;
  readonly #labels = new Map<string, LabelEntry>();

  constructor(device: GPUDevice, format: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#viewportUniformBuffer = viewportUniformBuffer;
    const context = this.#canvas.getContext("2d");
    if (!context) throw new Error("Unable to create collaboration label canvas");
    this.#context = context;

    const shapeLayout = device.createBindGroupLayout({
      label: "Collaboration selection layout",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    this.#shapeBindGroup = device.createBindGroup({
      label: "Collaboration selection bind group",
      layout: shapeLayout,
      entries: [{ binding: 0, resource: { buffer: viewportUniformBuffer } }],
    });
    const shapeModule = device.createShaderModule({
      label: "Collaboration selection shader",
      code: shapeShaderSource,
    });
    this.#shapePipeline = device.createRenderPipeline({
      label: "Collaboration selection pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [shapeLayout] }),
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
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.#labelBindGroupLayout = device.createBindGroupLayout({
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
    const labelModule = device.createShaderModule({
      label: "Collaboration cursor label shader",
      code: labelShaderSource,
    });
    this.#labelPipeline = device.createRenderPipeline({
      label: "Collaboration cursor label pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#labelBindGroupLayout] }),
      vertex: { module: labelModule, entryPoint: "vs_main" },
      fragment: {
        module: labelModule,
        entryPoint: "fs_main",
        targets: [
          {
            format,
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

  prepareSelections({
    presences,
    entities,
    entityIndices,
    presenceSelectionVersion,
    entityVersion,
    geometryVersion,
    viewport,
    devicePixelRatio,
  }: {
    presences: readonly RemotePeerPresence[];
    entities: readonly ShaderCanvasEntity[];
    entityIndices: ReadonlyMap<string, number>;
    presenceSelectionVersion: number;
    entityVersion: number;
    geometryVersion: number;
    viewport: Viewport;
    devicePixelRatio: number;
  }): void {
    if (
      this.#selectionPresenceVersion === presenceSelectionVersion &&
      this.#selectionEntityVersion === entityVersion &&
      this.#selectionGeometryVersion === geometryVersion &&
      this.#selectionZoom === viewport.zoom &&
      this.#selectionDpr === devicePixelRatio
    ) {
      return;
    }

    if (presences.some((presence) => presence.selectedEntityIds.length > 0)) {
      this.#rebuildSelectionGeometry(
        presences,
        entities,
        entityIndices,
        viewport.zoom,
        devicePixelRatio,
      );
    } else {
      this.#selectionVertexCount = 0;
    }
    this.#selectionPresenceVersion = presenceSelectionVersion;
    this.#selectionEntityVersion = entityVersion;
    this.#selectionGeometryVersion = geometryVersion;
    this.#selectionZoom = viewport.zoom;
    this.#selectionDpr = devicePixelRatio;
  }

  encode({
    encoder,
    targetView,
    presences,
    viewport,
    devicePixelRatio,
  }: {
    encoder: GPUCommandEncoder;
    targetView: GPUTextureView;
    presences: readonly RemotePeerPresence[];
    viewport: Viewport;
    devicePixelRatio: number;
  }): void {
    this.#frame++;
    const hasCursor = presences.some((presence) => presence.cursor !== null);
    if (this.#selectionVertexCount === 0 && !hasCursor) {
      this.#pruneLabels();
      return;
    }

    const pass = encoder.beginRenderPass({
      label: "Collaboration presence pass",
      colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }],
    });
    if (this.#selectionVertexCount > 0 && this.#selectionBuffer) {
      pass.setPipeline(this.#shapePipeline);
      pass.setBindGroup(0, this.#shapeBindGroup);
      pass.setVertexBuffer(0, this.#selectionBuffer);
      pass.draw(this.#selectionVertexCount);
    }
    if (hasCursor) {
      pass.setPipeline(this.#labelPipeline);
      for (const presence of presences) {
        if (!presence.cursor) continue;
        this.#drawCursorLabel(pass, presence, viewport, devicePixelRatio);
      }
    }
    pass.end();
    this.#pruneLabels();
  }

  destroy(): void {
    this.#selectionBuffer?.destroy();
    this.#selectionBuffer = null;
    for (const entry of this.#labels.values()) {
      entry.texture.destroy();
      entry.uniformBuffer.destroy();
    }
    this.#labels.clear();
  }

  #rebuildSelectionGeometry(
    presences: readonly RemotePeerPresence[],
    entities: readonly ShaderCanvasEntity[],
    entityIndices: ReadonlyMap<string, number>,
    zoom: number,
    dpr: number,
  ): void {
    const colorsByEntity = new Map<string, RGBA[]>();
    const groupsByAnchor = new Map<string, GroupOutline[]>();
    for (const presence of presences) {
      const selected: ShaderCanvasEntity[] = [];
      for (const entityId of presence.selectedEntityIds) {
        const index = entityIndices.get(entityId);
        const entity = index === undefined ? undefined : entities[index];
        if (!entity) continue;
        selected.push(entity);
        let colors = colorsByEntity.get(entityId);
        if (!colors) colorsByEntity.set(entityId, (colors = []));
        colors.push(presence.color);
      }
      if (selected.length > 1) {
        const anchor = selected.reduce((highest, entity) =>
          entity.zIndex > highest.zIndex ? entity : highest,
        );
        let groups = groupsByAnchor.get(anchor.id);
        if (!groups) groupsByAnchor.set(anchor.id, (groups = []));
        groups.push({ entities: selected, color: presence.color });
      }
    }

    const vertices: number[] = [];
    const borderWidth = (2 * dpr) / zoom;
    for (const entity of entities) {
      for (const color of colorsByEntity.get(entity.id) ?? []) {
        appendRotatedOutline(vertices, entity, borderWidth, color);
      }
      for (const group of groupsByAnchor.get(entity.id) ?? []) {
        appendGroupOutline(vertices, group.entities, borderWidth * 0.65, group.color);
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
    presence: RemotePeerPresence,
    viewport: Viewport,
    dpr: number,
  ): void {
    const entry = this.#getLabel(presence, dpr);
    entry.uniformData[0] = presence.cursor!.x;
    entry.uniformData[1] = presence.cursor!.y;
    entry.uniformData[2] = entry.width / viewport.zoom;
    entry.uniformData[3] = entry.height / viewport.zoom;
    entry.uniformData[4] = 1;
    entry.lastSeenFrame = this.#frame;
    this.#device.queue.writeBuffer(entry.uniformBuffer, 0, entry.uniformData);
    pass.setBindGroup(0, entry.bindGroup);
    pass.draw(6);
  }

  #getLabel(presence: RemotePeerPresence, dpr: number): LabelEntry {
    const existing = this.#labels.get(presence.peerId);
    if (
      existing &&
      existing.name === presence.name &&
      existing.devicePixelRatio === dpr &&
      sameRgba(existing.color, presence.color)
    ) {
      return existing;
    }
    existing?.texture.destroy();
    existing?.uniformBuffer.destroy();

    const size = this.#rasterizeLabel(presence, dpr);
    const texture = this.#device.createTexture({
      label: `Collaboration cursor ${presence.peerId}`,
      size: [size.width, size.height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const uniformBuffer = this.#device.createBuffer({
      label: `Collaboration cursor ${presence.peerId} uniforms`,
      size: LABEL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.#device.createBindGroup({
      label: `Collaboration cursor ${presence.peerId} bind group`,
      layout: this.#labelBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: texture.createView() },
        { binding: 3, resource: this.#sampler },
      ],
    });
    this.#device.queue.copyExternalImageToTexture({ source: this.#canvas }, { texture }, [
      size.width,
      size.height,
    ]);
    const entry: LabelEntry = {
      texture,
      uniformBuffer,
      bindGroup,
      uniformData: new Float32Array(LABEL_UNIFORM_BYTES / Float32Array.BYTES_PER_ELEMENT),
      ...size,
      name: presence.name,
      color: [...presence.color],
      devicePixelRatio: dpr,
      lastSeenFrame: this.#frame,
    };
    this.#labels.set(presence.peerId, entry);
    return entry;
  }

  #rasterizeLabel(presence: RemotePeerPresence, dpr: number): { width: number; height: number } {
    const ctx = this.#context;
    const fontSize = FONT_SIZE * dpr;
    ctx.font = `600 ${fontSize}px ${FONT_FAMILY}`;
    const textWidth = Math.min(ctx.measureText(presence.name).width, MAX_LABEL_WIDTH * dpr);
    const labelWidth = textWidth + LABEL_PADDING_X * 2 * dpr;
    const labelHeight = fontSize + LABEL_PADDING_Y * 2 * dpr;
    const width = Math.ceil((CURSOR_WIDTH + LABEL_GAP) * dpr + labelWidth + 3 * dpr);
    const height = Math.ceil(Math.max(CURSOR_HEIGHT * dpr, labelHeight) + 3 * dpr);
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
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

  #pruneLabels(): void {
    for (const [peerId, entry] of this.#labels) {
      if (entry.lastSeenFrame === this.#frame) continue;
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
  appendOutline(
    vertices,
    [
      rotatePoint(-halfWidth, -halfHeight, center, cos, sin),
      rotatePoint(halfWidth, -halfHeight, center, cos, sin),
      rotatePoint(halfWidth, halfHeight, center, cos, sin),
      rotatePoint(-halfWidth, halfHeight, center, cos, sin),
    ],
    thickness,
    color,
  );
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
  appendOutline(
    vertices,
    [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
    thickness,
    [color[0], color[1], color[2], color[3] * 0.7],
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

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(4, value)));
}

function sameRgba(a: RGBA, b: RGBA): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function toCssColor(color: RGBA): string {
  return `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${color[3]})`;
}
