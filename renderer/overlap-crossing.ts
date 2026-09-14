import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { overlapLab } from "#lib/overlap-lab.ts";

type CardGeometry = Pick<ShaderCanvasEntity, "position" | "size" | "rotation">;
interface RenderedCard extends CardGeometry {
  id: string;
  frame: number;
}

/** Separating-axis test avoids triggering on empty corners of rotated bounds. */
interface ContactAxis {
  x: number;
  y: number;
  depth: number;
}
export function cardsOverlap(a: CardGeometry, b: CardGeometry, axis?: ContactAxis): boolean {
  const ar = (a.rotation * Math.PI) / 180,
    br = (b.rotation * Math.PI) / 180;
  const ac = Math.cos(ar),
    as = Math.sin(ar),
    bc = Math.cos(br),
    bs = Math.sin(br);
  const dx = b.position.x + b.size.width / 2 - a.position.x - a.size.width / 2;
  const dy = b.position.y + b.size.height / 2 - a.position.y - a.size.height / 2;
  let minimum = Infinity;
  for (let i = 0; i < 4; i++) {
    const x = i === 0 ? ac : i === 1 ? -as : i === 2 ? bc : -bs;
    const y = i === 0 ? as : i === 1 ? ac : i === 2 ? bs : bc;
    const ra =
      (Math.abs(x * ac + y * as) * a.size.width) / 2 +
      (Math.abs(-x * as + y * ac) * a.size.height) / 2;
    const rb =
      (Math.abs(x * bc + y * bs) * b.size.width) / 2 +
      (Math.abs(-x * bs + y * bc) * b.size.height) / 2;
    const projected = dx * x + dy * y;
    const penetration = ra + rb - Math.abs(projected);
    if (penetration <= 0) return false;
    if (axis && penetration < minimum) {
      minimum = penetration;
      const sign = projected < 0 ? -1 : 1;
      axis.x = x * sign;
      axis.y = y * sign;
      axis.depth = penetration;
    }
  }
  return true;
}

export class OverlapCrossing {
  readonly layout: GPUBindGroupLayout;
  bindGroup: GPUBindGroup;
  #device: GPUDevice;
  #buffer: GPUBuffer;
  #data = new Float32Array(32);
  #keys = new Map<string, number>();
  #nextKey = 1;
  #pairs: {
    lifted: RenderedCard;
    cover: RenderedCard;
    axisX: number;
    axisY: number;
    crossingDepth: number;
  }[] = [];
  #pairCount = 0;
  #poses = new Map<string, RenderedCard>();
  #frame = 0;
  readonly #contactAxis = { x: 0, y: 0, depth: 0 };
  #lift = 0;
  #liftFrom = 0;
  #liftTarget = 1;
  #sceneCount = 0;
  #entityIds: ReadonlySet<string> = new Set();
  #active = false;
  #returning = false;
  #started = -Infinity;
  #rgbDecay = 400;
  #wakeDecay = 400;
  #transition = 200;
  #direction = 1;
  #pending = false;
  #enabled = false;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.layout = device.createBindGroupLayout({
      label: "Overlap fields",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
    });
    this.#buffer = this.#createBuffer();
    this.bindGroup = this.#createBindGroup();
  }
  key(id: string): number {
    let key = this.#keys.get(id);
    if (key === undefined) {
      if (this.#nextKey > 16777215) throw new Error("Overlap entity key range exhausted.");
      key = this.#nextKey++;
      this.#keys.set(id, key);
    }
    return key;
  }
  forget(id: string): void {
    this.#keys.delete(id);
    this.#poses.delete(id);
  }
  /** Interpolate each selected entity through the stack, preserving selection order. */
  order(index: number, id: string): number {
    if (!this.#enabled || !this.#active || !this.#entityIds.has(id)) return index;
    return index + (this.#targetOrder(index) - index) * this.#lift;
  }
  #targetOrder(index: number): number {
    return this.#sceneCount + 1 + index / (this.#sceneCount + 1);
  }
  #motionAt(now: number): number {
    const t = Math.min(1, Math.max(0, (now - this.#started) / this.#transition));
    const eased = t * t * (3 - 2 * t);
    return this.#liftFrom + (this.#liftTarget - this.#liftFrom) * eased;
  }
  get enabled(): boolean {
    return this.#enabled;
  }
  get pending(): boolean {
    return this.#pending;
  }

  update(
    entities: readonly ShaderCanvasEntity[],
    action: ActionLayerRenderState,
    now: number,
    zoom: number,
    dpr: number,
    drag?: DragVisualRenderState,
  ): void {
    const settings = overlapLab.getSnapshot();
    const enabled = settings.enabled;
    const returning = action.returning === true;
    const trigger =
      enabled &&
      action.active &&
      (!this.#active || !this.#enabled || returning !== this.#returning);
    this.#sceneCount = entities.length;
    if (action.active) this.#entityIds = action.entityIds;
    if (trigger) {
      this.#liftFrom = this.#active && this.#enabled ? this.#motionAt(now) : returning ? 1 : 0;
      this.#liftTarget = returning ? 0 : 1;
      this.#pairCount = 0;
      this.#started = now;
      this.#rgbDecay = settings.rgbDecay;
      this.#wakeDecay = settings.wakeDecay;
      this.#transition = settings.transition;
      this.#direction = returning ? -1 : 1;
    }
    if (!action.active && this.#active && !this.#returning) this.#started = -Infinity;
    this.#active = action.active;
    this.#returning = returning;
    this.#enabled = enabled;
    const elapsed = Math.max(0, now - this.#started);
    const tail = Math.max(0, elapsed - this.#transition);
    const rgbAge = Math.min(1, tail / this.#rgbDecay);
    const wakeAge = Math.min(1, tail / this.#wakeDecay);
    const age = Math.min(rgbAge, wakeAge);
    const crossing = Math.min(1, elapsed / this.#transition);
    this.#lift = this.#motionAt(now);
    if (enabled && age < 1) {
      this.#updatePoses(entities, action, drag, dpr / zoom);
      if (elapsed <= this.#transition) this.#findContacts(entities);
      // Retain the last contacts during decay, but follow current geometry and
      // discard removed entities. Committing a transient drag keeps this pose.
      let live = 0;
      for (let i = 0; i < this.#pairCount; i++) {
        const pair = this.#pairs[i]!;
        if (pair.lifted.frame !== this.#frame || pair.cover.frame !== this.#frame) continue;
        if (cardsOverlap(pair.lifted, pair.cover, this.#contactAxis)) {
          pair.axisX = this.#contactAxis.x;
          pair.axisY = this.#contactAxis.y;
        }
        const spare = this.#pairs[live]!;
        this.#pairs[live++] = pair;
        this.#pairs[i] = spare;
      }
      this.#pairCount = live;
    }
    this.#pending = enabled && age < 1 && this.#pairCount > 0;
    const count = this.#pending ? this.#pairCount * 2 : 0;
    if (count === 0 && this.#data[0] === 0) return;
    const needed = 12 + count * 16;
    if (needed > this.#data.length) {
      this.#data = new Float32Array(2 ** Math.ceil(Math.log2(needed)));
      this.#buffer.destroy();
      this.#buffer = this.#createBuffer();
      this.bindGroup = this.#createBindGroup();
    }
    this.#data[0] = count;
    this.#data[1] = settings.rgbStrength;
    this.#data[2] = rgbAge;
    this.#data[3] = settings.wakeStrength;
    this.#data[4] = this.#lift;
    this.#data[5] = this.#direction;
    this.#data[6] = crossing;
    this.#data[7] = wakeAge;
    this.#data[8] = settings.rgbSplit;
    this.#data[9] = settings.wakeWidth;
    let offset = 12;
    if (this.#pending)
      for (let i = 0; i < this.#pairCount; i++) {
        const pair = this.#pairs[i]!;
        for (let side = 0; side < 2; side++) {
          const own = side === 0 ? pair.lifted : pair.cover;
          const other = side === 0 ? pair.cover : pair.lifted;
          this.#data[offset] = other.position.x + other.size.width / 2;
          this.#data[offset + 1] = other.position.y + other.size.height / 2;
          this.#data[offset + 2] = other.size.width / 2;
          this.#data[offset + 3] = other.size.height / 2;
          const angle = (other.rotation * Math.PI) / 180;
          this.#data[offset + 4] = Math.cos(angle);
          this.#data[offset + 5] = Math.sin(angle);
          this.#data[offset + 6] = this.key(own.id);
          this.#data[offset + 7] = side === 0 ? 1 : -1;
          this.#data[offset + 8] = dpr / zoom;
          this.#data[offset + 9] = pair.crossingDepth;
          this.#data[offset + 10] = this.key(other.id);
          this.#data[offset + 11] = Math.max(
            1,
            Math.min(
              pair.lifted.size.width,
              pair.lifted.size.height,
              pair.cover.size.width,
              pair.cover.size.height,
            ),
          );
          const away = side === 0 ? -1 : 1;
          this.#data[offset + 12] = pair.axisX * away;
          this.#data[offset + 13] = pair.axisY * away;
          this.#data[offset + 14] =
            (pair.lifted.position.x +
              pair.lifted.size.width / 2 +
              pair.cover.position.x +
              pair.cover.size.width / 2) /
            2;
          this.#data[offset + 15] =
            (pair.lifted.position.y +
              pair.lifted.size.height / 2 +
              pair.cover.position.y +
              pair.cover.size.height / 2) /
            2;
          offset += 16;
        }
      }
    this.#device.queue.writeBuffer(this.#buffer, 0, this.#data.buffer, 0, Math.max(16, needed * 4));
  }
  #updatePoses(
    entities: readonly ShaderCanvasEntity[],
    action: ActionLayerRenderState,
    drag: DragVisualRenderState | undefined,
    worldPerCss: number,
  ): void {
    this.#frame++;
    for (const entity of entities) {
      let pose = this.#poses.get(entity.id);
      if (!pose) {
        pose = {
          id: entity.id,
          position: { x: 0, y: 0 },
          size: { width: 0, height: 0 },
          rotation: 0,
          frame: 0,
        };
        this.#poses.set(entity.id, pose);
      }
      const inAction = action.active && action.entityIds.has(entity.id);
      const inDrag = drag?.active && drag.entityIds.has(entity.id);
      const scale = inDrag ? drag.scale : 1;
      pose.size.width = entity.size.width * scale;
      pose.size.height = entity.size.height * scale;
      pose.position.x =
        entity.position.x +
        (entity.size.width - pose.size.width) / 2 +
        (inAction ? action.entityOffset.x * worldPerCss : 0) +
        (inDrag && drag.appliesToSelection ? drag.offset.x : 0);
      pose.position.y =
        entity.position.y +
        (entity.size.height - pose.size.height) / 2 +
        (inAction ? action.entityOffset.y * worldPerCss : 0) +
        (inDrag && drag.appliesToSelection ? drag.offset.y : 0);
      pose.rotation = entity.rotation;
      pose.frame = this.#frame;
    }
  }
  #findContacts(entities: readonly ShaderCanvasEntity[]): void {
    this.#pairCount = 0;
    // Refresh while crossing so movement can enter or leave several neighbors.
    // Reuse pair records; selected entities never collide with their own group.
    for (let i = 0; i < entities.length; i++) {
      const lifted = this.#poses.get(entities[i]!.id)!;
      if (!this.#entityIds.has(lifted.id)) continue;
      for (let j = i + 1; j < entities.length; j++) {
        const cover = this.#poses.get(entities[j]!.id)!;
        if (this.#entityIds.has(cover.id) || !cardsOverlap(lifted, cover, this.#contactAxis))
          continue;
        let pair = this.#pairs[this.#pairCount];
        if (!pair) {
          pair = { lifted, cover, axisX: 0, axisY: 0, crossingDepth: 0 };
          this.#pairs.push(pair);
        }
        pair.lifted = lifted;
        pair.cover = cover;
        pair.axisX = this.#contactAxis.x;
        pair.axisY = this.#contactAxis.y;
        pair.crossingDepth = (j - i) / (this.#targetOrder(i) - i);
        this.#pairCount++;
      }
    }
  }
  #createBuffer(): GPUBuffer {
    if (this.#data.byteLength > this.#device.limits.maxStorageBufferBindingSize)
      throw new Error("Overlap lab exceeds the GPU storage binding limit.");
    return this.#device.createBuffer({
      label: "Overlap fields",
      size: this.#data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }
  #createBindGroup(): GPUBindGroup {
    return this.#device.createBindGroup({
      layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: this.#buffer } }],
    });
  }
  destroy(): void {
    this.#buffer.destroy();
    this.#keys.clear();
    this.#poses.clear();
    this.#pairs.length = 0;
  }
}
