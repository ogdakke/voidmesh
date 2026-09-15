import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { overlapConfig, type OverlapConfig } from "#lib/config/overlap.config.ts";

type CardGeometry = Pick<ShaderCanvasEntity, "position" | "size" | "rotation">;
interface RenderedCard extends CardGeometry {
  id: string;
  frame: number;
  dx: number;
  dy: number;
}

interface MotionContact {
  mover: RenderedCard;
  cover: RenderedCard;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  directionX: number;
  directionY: number;
  strength: number;
  lastMotion: number;
  travel: number;
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
  readonly #settings: Readonly<OverlapConfig>;
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
  #crossingCount = 0;
  #sceneIndices = new Map<string, number>();
  #poses = new Map<string, RenderedCard>();
  #frame = 0;
  #motionContacts: MotionContact[] = [];
  #motionCount = 0;
  #lastFrameTime = -Infinity;
  #motionEnabled = false;
  #dragWasActive = false;
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

  constructor(device: GPUDevice, settings: Readonly<OverlapConfig> = overlapConfig) {
    this.#settings = settings;
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
  /** Draw the lifted material on both sides of each covering layer.
   * Slice 0 is unsplit, 1 is the resting layer, and contact index + 2 is above
   * that partner. Composition passes this ID through firstVertex / 6.
   */
  appendSlices(
    id: string,
    emit: (anchor: number, slice: number, sourceIndex: number) => void,
  ): void {
    const index = this.#sceneIndices.get(id);
    if (index === undefined) throw new Error("Crossing entity is missing its scene index");
    let split = false;
    for (let i = 0; i < this.#crossingCount / 2; i++) {
      const pair = this.#pairs[i]!;
      if (pair.lifted.id !== id) continue;
      split = true;
      const anchor = this.#sceneIndices.get(pair.cover.id);
      if (anchor === undefined) throw new Error("Crossing partner is missing its scene index");
      emit(anchor, i * 2 + 2, index);
    }
    emit(index, split ? 1 : 0, index);
  }
  get hasSlices(): boolean {
    return this.#crossingCount > 0 && this.#lift > 0 && this.#lift < 1;
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
    effectsEnabled = true,
  ): void {
    const settings = this.#settings;
    const enabled = settings.enabled && effectsEnabled;
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
    const motionEnabled = enabled && settings.dragUnder;
    const dt = now - this.#lastFrameTime;
    this.#lastFrameTime = now;
    if (enabled && (age < 1 || (motionEnabled && (drag?.active || this.#motionCount > 0)))) {
      this.#updatePoses(entities, action, drag, dpr / zoom);
    }
    if (enabled && age < 1) {
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
    if (motionEnabled) this.#updateMotion(entities, drag, now, dt, dpr / zoom);
    else this.#motionCount = 0;
    this.#motionEnabled = motionEnabled;
    this.#dragWasActive = drag?.active === true;
    const crossingCount = enabled && age < 1 ? this.#pairCount * 2 : 0;
    this.#crossingCount = crossingCount;
    if (crossingCount > 0) {
      this.#sceneIndices.clear();
      for (let i = 0; i < entities.length; i++) this.#sceneIndices.set(entities[i]!.id, i);
    }
    const count = crossingCount + this.#motionCount;
    this.#pending = count > 0;
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
    if (crossingCount > 0)
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
    for (let i = 0; i < this.#motionCount; i++) {
      const contact = this.#motionContacts[i]!;
      const sinceMotion = Math.max(0, now - contact.lastMotion);
      const rgbTail = Math.max(0, 1 - sinceMotion / settings.rgbDecay);
      const wakeTail = Math.max(0, 1 - sinceMotion / settings.wakeDecay);
      this.#data[offset] = contact.cover.position.x + contact.x;
      this.#data[offset + 1] = contact.cover.position.y + contact.y;
      this.#data[offset + 2] = contact.width / 2;
      this.#data[offset + 3] = contact.height / 2;
      this.#data[offset + 4] = Math.cos(contact.rotation);
      this.#data[offset + 5] = Math.sin(contact.rotation);
      this.#data[offset + 6] = this.key(contact.cover.id);
      this.#data[offset + 7] = 0; // Motion affects only the upper card; no depth exchange.
      this.#data[offset + 8] = dpr / zoom;
      this.#data[offset + 9] = contact.strength * rgbTail * rgbTail;
      this.#data[offset + 10] = contact.strength * wakeTail * wakeTail;
      this.#data[offset + 11] = contact.travel;
      this.#data[offset + 12] = contact.directionX;
      this.#data[offset + 13] = contact.directionY;
      this.#data[offset + 14] = sinceMotion * 0.08;
      this.#data[offset + 15] = 0;
      offset += 16;
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
          dx: 0,
          dy: 0,
        };
        this.#poses.set(entity.id, pose);
      }
      const previousX = pose.position.x + pose.size.width / 2;
      const previousY = pose.position.y + pose.size.height / 2;
      const consecutive = pose.frame === this.#frame - 1;
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
      pose.dx = consecutive ? pose.position.x + pose.size.width / 2 - previousX : 0;
      pose.dy = consecutive ? pose.position.y + pose.size.height / 2 - previousY : 0;
      pose.rotation = entity.rotation;
      pose.frame = this.#frame;
    }
  }
  #updateMotion(
    entities: readonly ShaderCanvasEntity[],
    drag: DragVisualRenderState | undefined,
    now: number,
    dt: number,
    worldPerCss: number,
  ): void {
    const settings = this.#settings;
    // Expired or deleted contacts release their slots. The last footprint stays
    // attached to the upper card during decay, even after the mover leaves it.
    for (let i = this.#motionCount - 1; i >= 0; i--) {
      const contact = this.#motionContacts[i]!;
      if (
        contact.cover.frame === this.#frame &&
        contact.mover.frame === this.#frame &&
        now - contact.lastMotion < Math.max(settings.rgbDecay, settings.wakeDecay)
      )
        continue;
      this.#motionCount--;
      this.#motionContacts[i] = this.#motionContacts[this.#motionCount]!;
      this.#motionContacts[this.#motionCount] = contact;
    }
    if (
      !drag?.active ||
      !this.#dragWasActive ||
      !this.#motionEnabled ||
      !Number.isFinite(dt) ||
      dt <= 0
    )
      return;
    for (let i = 0; i < entities.length; i++) {
      const mover = this.#poses.get(entities[i]!.id)!;
      if (!drag.entityIds.has(mover.id)) continue;
      const distance = Math.hypot(mover.dx, mover.dy);
      if (distance < 0.001 * worldPerCss) continue;
      const speed = distance / worldPerCss / (dt / 1000);
      const target = 1 - Math.exp(-speed / 300);
      for (let j = i + 1; j < entities.length; j++) {
        const cover = this.#poses.get(entities[j]!.id)!;
        if (
          drag.entityIds.has(cover.id) ||
          this.order(i, mover.id) >= j ||
          !cardsOverlap(mover, cover)
        )
          continue;
        let contact: MotionContact | undefined;
        for (let k = 0; k < this.#motionCount; k++) {
          const candidate = this.#motionContacts[k]!;
          if (candidate.mover.id === mover.id && candidate.cover.id === cover.id) {
            contact = candidate;
            break;
          }
        }
        if (!contact) {
          contact = this.#motionContacts[this.#motionCount];
          if (!contact) {
            contact = {
              mover,
              cover,
              x: 0,
              y: 0,
              width: 0,
              height: 0,
              rotation: 0,
              directionX: 0,
              directionY: 0,
              strength: 0,
              lastMotion: now,
              travel: 0,
            };
            this.#motionContacts.push(contact);
          }
          contact.mover = mover;
          contact.cover = cover;
          contact.strength = 0;
          contact.directionX = mover.dx / distance;
          contact.directionY = mover.dy / distance;
          contact.travel = 0;
          contact.lastMotion = now;
          this.#motionCount++;
        }
        const release = Math.max(
          0,
          1 - (now - contact.lastMotion) / Math.max(settings.rgbDecay, settings.wakeDecay),
        );
        contact.strength *= release * release;
        contact.strength += (target - contact.strength) * (1 - Math.exp(-dt / 55));
        contact.x = mover.position.x + mover.size.width / 2 - cover.position.x;
        contact.y = mover.position.y + mover.size.height / 2 - cover.position.y;
        contact.width = mover.size.width;
        contact.height = mover.size.height;
        contact.rotation = (mover.rotation * Math.PI) / 180;
        // Keep vector magnitude: opposing motion briefly cancels the old flow
        // instead of instantly flipping a full-strength chromatic split.
        const steering = 1 - Math.exp(-dt / 35);
        contact.directionX += (mover.dx / distance - contact.directionX) * steering;
        contact.directionY += (mover.dy / distance - contact.directionY) * steering;
        contact.travel =
          (contact.travel + (distance / worldPerCss) * 0.25) %
          (Math.PI * 2 * settings.wakeWidth * 0.643);
        contact.lastMotion = now;
      }
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
      throw new Error("Overlap contacts exceed the GPU storage binding limit.");
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
    this.#sceneIndices.clear();
    this.#poses.clear();
    this.#motionContacts.length = 0;
    this.#motionCount = 0;
    this.#pairs.length = 0;
  }
}
