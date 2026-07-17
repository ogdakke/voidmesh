import { config } from "#config";
import { getViewportWorldBounds } from "#lib/canvas-math.ts";
import type {
  EntitySpatialIndex,
  SpatialDebugBucket,
  SpatialDebugCenter,
} from "#lib/entity-spatial-index.ts";
import { getEntityAlphaGrid } from "#lib/alpha-hit-testing.ts";
import { logger } from "#lib/client.logger.ts";
import type { AlphaHitGrid, Bounds, ShaderCanvasEntity, Viewport } from "#types/canvas.ts";
import shaderSource from "./canvas-debug.wgsl?raw";

export type CanvasDebugView = "none" | "alpha" | "spatial" | "all";

interface AlphaGpuEntry {
  cells: GPUBuffer;
}

interface EntityGpuEntry {
  uniform: GPUBuffer;
  grid: AlphaHitGrid;
  bindGroup: GPUBindGroup;
  seen: boolean;
}

const ALPHA_UNIFORM_BYTES = 32;
const SPATIAL_INSTANCE_BYTES = 32;

export class CanvasDebugPass {
  readonly #device: GPUDevice;
  readonly #viewportBuffer: GPUBuffer;
  readonly #alphaLayout: GPUBindGroupLayout;
  readonly #spatialLayout: GPUBindGroupLayout;
  readonly #alphaPipeline: GPURenderPipeline;
  readonly #spatialPipeline: GPURenderPipeline;
  readonly #gridEntries = new Map<AlphaHitGrid, AlphaGpuEntry>();
  readonly #entityEntries = new Map<string, EntityGpuEntry>();
  readonly #buckets: SpatialDebugBucket[] = [];
  readonly #centers: SpatialDebugCenter[] = [];
  readonly #bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #alphaUniformData = new ArrayBuffer(ALPHA_UNIFORM_BYTES);
  readonly #skippedAlphaEntities = new Set<string>();
  #spatialBuffer: GPUBuffer;
  #spatialBindGroup: GPUBindGroup;
  #spatialCapacity = 256;

  constructor(device: GPUDevice, format: GPUTextureFormat, viewportBuffer: GPUBuffer) {
    this.#device = device;
    this.#viewportBuffer = viewportBuffer;
    const module = device.createShaderModule({ label: "Canvas debug shader", code: shaderSource });
    this.#alphaLayout = device.createBindGroupLayout({
      label: "Alpha grid debug layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    this.#spatialLayout = device.createBindGroupLayout({
      label: "Spatial debug layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const blend: GPUBlendState = {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    this.#alphaPipeline = device.createRenderPipeline({
      label: "Alpha grid debug pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#alphaLayout] }),
      vertex: { module, entryPoint: "vs_alpha" },
      fragment: { module, entryPoint: "fs_alpha", targets: [{ format, blend }] },
    });
    this.#spatialPipeline = device.createRenderPipeline({
      label: "Spatial debug pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout({ entries: [] }), this.#spatialLayout],
      }),
      vertex: { module, entryPoint: "vs_spatial" },
      fragment: { module, entryPoint: "fs_spatial", targets: [{ format, blend }] },
    });
    this.#spatialBuffer = this.#createSpatialBuffer(this.#spatialCapacity);
    this.#spatialBindGroup = this.#createSpatialBindGroup();
  }

  encode(options: {
    encoder: GPUCommandEncoder;
    targetView: GPUTextureView;
    view: CanvasDebugView;
    viewport: Viewport;
    width: number;
    height: number;
    entities: readonly ShaderCanvasEntity[];
    spatialIndex: EntitySpatialIndex;
  }): void {
    const alpha = options.view === "alpha" || options.view === "all";
    const spatial = options.view === "spatial" || options.view === "all";
    if (!alpha && !spatial) return;
    const pass = options.encoder.beginRenderPass({
      label: "Canvas debug pass",
      colorAttachments: [{ view: options.targetView, loadOp: "load", storeOp: "store" }],
    });
    if (alpha) this.#drawAlpha(pass, options.entities);
    if (spatial) {
      getViewportWorldBounds(options.viewport, options.width, options.height, 0, this.#bounds);
      this.#drawSpatial(pass, options.spatialIndex, options.viewport.zoom);
    }
    pass.end();
  }

  destroy(): void {
    for (const entry of this.#gridEntries.values()) entry.cells.destroy();
    for (const entry of this.#entityEntries.values()) entry.uniform.destroy();
    this.#spatialBuffer.destroy();
    this.#gridEntries.clear();
    this.#entityEntries.clear();
  }

  #drawAlpha(pass: GPURenderPassEncoder, entities: readonly ShaderCanvasEntity[]): void {
    for (const entry of this.#entityEntries.values()) entry.seen = false;
    pass.setPipeline(this.#alphaPipeline);
    for (const entity of entities) {
      const grid = getEntityAlphaGrid(entity);
      if (!grid) continue;
      if (grid.cells.length > config.hitTesting.alphaGrid.debugMaxCellsPerEntity) {
        if (!this.#skippedAlphaEntities.has(entity.id)) {
          this.#skippedAlphaEntities.add(entity.id);
          logger.debug(
            `[canvas-debug] skipped alpha grid for ${entity.id}: ${grid.cells.length} cells`,
          );
        }
        continue;
      }
      this.#skippedAlphaEntities.delete(entity.id);
      const entry = this.#getEntityEntry(entity.id, grid);
      entry.seen = true;
      const floats = new Float32Array(this.#alphaUniformData);
      const uints = new Uint32Array(this.#alphaUniformData);
      floats[0] = entity.position.x;
      floats[1] = entity.position.y;
      floats[2] = entity.size.width;
      floats[3] = entity.size.height;
      floats[4] = (entity.rotation * Math.PI) / 180;
      uints[5] = grid.cols;
      uints[6] = grid.rows;
      this.#device.queue.writeBuffer(entry.uniform, 0, this.#alphaUniformData);
      pass.setBindGroup(0, entry.bindGroup);
      pass.draw(6);
    }
    for (const [id, entry] of this.#entityEntries) {
      if (entry.seen) continue;
      entry.uniform.destroy();
      this.#entityEntries.delete(id);
    }
  }

  #getEntityEntry(id: string, grid: AlphaHitGrid): EntityGpuEntry {
    const current = this.#entityEntries.get(id);
    if (current?.grid === grid) return current;
    current?.uniform.destroy();
    let gridEntry = this.#gridEntries.get(grid);
    if (!gridEntry) {
      const values = Uint32Array.from(grid.cells);
      const cells = this.#device.createBuffer({
        label: "Alpha grid debug cells",
        size: Math.max(4, values.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#device.queue.writeBuffer(cells, 0, values);
      gridEntry = { cells };
      this.#gridEntries.set(grid, gridEntry);
    }
    const uniform = this.#device.createBuffer({
      label: `Alpha grid debug entity ${id}`,
      size: ALPHA_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.#device.createBindGroup({
      label: `Alpha grid debug bind group ${id}`,
      layout: this.#alphaLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportBuffer } },
        { binding: 1, resource: { buffer: uniform } },
        { binding: 2, resource: { buffer: gridEntry.cells } },
      ],
    });
    const entry = { uniform, grid, bindGroup, seen: true };
    this.#entityEntries.set(id, entry);
    return entry;
  }

  #drawSpatial(pass: GPURenderPassEncoder, index: EntitySpatialIndex, zoom: number): void {
    index.collectDebugGeometry(this.#bounds, this.#buckets, this.#centers);
    const count = this.#buckets.length + this.#centers.length;
    if (count === 0) return;
    this.#ensureSpatialCapacity(count);
    const data = new ArrayBuffer(count * SPATIAL_INSTANCE_BYTES);
    const floats = new Float32Array(data);
    const uints = new Uint32Array(data);
    let cursor = 0;
    for (const bucket of this.#buckets) {
      const base = cursor++ * 8;
      floats[base] = bucket.cellX * bucket.cellSize;
      floats[base + 1] = bucket.cellY * bucket.cellSize;
      floats[base + 2] = bucket.cellSize;
      floats[base + 3] = bucket.cellSize;
      floats[base + 4] = bucket.cellSize;
      uints[base + 5] = 0;
    }
    for (const center of this.#centers) {
      const base = cursor++ * 8;
      const size = 7 / Math.max(zoom, 0.001);
      floats[base] = center.x - size / 2;
      floats[base + 1] = center.y - size / 2;
      floats[base + 2] = size;
      floats[base + 3] = size;
      floats[base + 4] = center.cellSize;
      uints[base + 5] = 1;
    }
    this.#device.queue.writeBuffer(this.#spatialBuffer, 0, data);
    pass.setPipeline(this.#spatialPipeline);
    pass.setBindGroup(1, this.#spatialBindGroup);
    pass.draw(6, count);
  }

  #ensureSpatialCapacity(count: number): void {
    if (count <= this.#spatialCapacity) return;
    while (this.#spatialCapacity < count) this.#spatialCapacity *= 2;
    this.#spatialBuffer.destroy();
    this.#spatialBuffer = this.#createSpatialBuffer(this.#spatialCapacity);
    this.#spatialBindGroup = this.#createSpatialBindGroup();
  }

  #createSpatialBuffer(capacity: number): GPUBuffer {
    return this.#device.createBuffer({
      label: "Spatial debug instances",
      size: capacity * SPATIAL_INSTANCE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  #createSpatialBindGroup(): GPUBindGroup {
    return this.#device.createBindGroup({
      label: "Spatial debug bind group",
      layout: this.#spatialLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportBuffer } },
        { binding: 1, resource: { buffer: this.#spatialBuffer } },
      ],
    });
  }
}
