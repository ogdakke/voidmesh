import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cardsOverlap, OverlapCrossing } from "#renderer/overlap-crossing.ts";
import { overlapConfig, type OverlapConfig } from "#lib/config/overlap.config.ts";

let settings: OverlapConfig;
import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("canvas overlap crossings", () => {
  beforeEach(() => {
    settings = { ...overlapConfig };
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
    vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
    Object.assign(settings, {
      enabled: true,
      dragUnder: false,
      transition: 400,
      rgbDecay: 800,
      wakeDecay: 800,
    });
  });
  afterEach(() => {
    Object.assign(settings, overlapConfig);
    vi.unstubAllGlobals();
  });
  test("rejects separated rotated cards even when their axis-aligned bounds overlap", () => {
    const a = createTestEntity({ size: { width: 200, height: 10 }, rotation: 45 });
    const b = createTestEntity({
      size: { width: 200, height: 10 },
      rotation: 45,
      position: { x: 0, y: 30 },
    });
    expect(cardsOverlap(a, b)).toBe(false);
    expect(cardsOverlap(a, createTestEntity({ position: { x: 50, y: 0 } }))).toBe(true);
  });
  test("only crosses covering entities; crosses in stack order and retains a return tail", () => {
    const uploads: Float32Array[] = [];
    const buffer = { destroy: vi.fn<GPUBuffer["destroy"]>() };
    const device = {
      limits: { maxStorageBufferBindingSize: 1024 * 1024 },
      createBuffer: () => buffer,
      createBindGroup: () => ({}),
      createBindGroupLayout: () => ({}),
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, source: ArrayBuffer) =>
          uploads.push(new Float32Array(source).slice()),
      },
    } as unknown as GPUDevice;
    const field = new OverlapCrossing(device, settings);
    const below = createTestEntity({ id: "below" });
    const lifted = createTestEntity({ id: "lifted" });
    const cover = createTestEntity({ id: "cover", position: { x: 40, y: 30 } });
    const entities = [below, lifted, cover];
    const action: ActionLayerRenderState = {
      active: true,
      entityIds: new Set([lifted.id]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    field.update(entities, action, 0, 1, 1);
    expect(uploads.at(-1)![0]).toBe(2);
    expect(uploads.at(-1)![18]).toBe(field.key(lifted.id));
    expect(uploads.at(-1)![34]).toBe(field.key(cover.id));
    expect(field.order(1, lifted.id)).toBeLessThan(2);
    field.update(entities, action, 220, 1, 1);
    expect(field.order(1, lifted.id)).toBeGreaterThan(2);
    field.update(entities, action, 1300, 1, 1);
    expect(field.pending).toBe(false);
    action.returning = true;
    field.update(entities, action, 1500, 1, 1);
    expect(field.order(1, lifted.id)).toBeGreaterThan(2);
    expect(uploads.at(-1)![19]).toBe(1);
    expect(uploads.at(-1)![5]).toBe(-1);
    field.update(entities, action, 1720, 1, 1);
    expect(field.order(1, lifted.id)).toBeGreaterThan(2);
    field.update(entities, action, 1800, 1, 1);
    expect(field.order(1, lifted.id)).toBeLessThan(2);
    action.active = false;
    action.returning = false;
    field.update(entities, action, 1950, 1, 1);
    expect(field.pending).toBe(true);
    field.update(entities, action, 2750, 1, 1);
    expect(field.pending).toBe(false);
    expect(uploads.at(-1)![0]).toBe(0);
    field.destroy();
    expect(buffer.destroy).toHaveBeenCalled();
  });
  test("a quick reversal preserves depth and selected cards keep their relative order", () => {
    const device = {
      limits: { maxStorageBufferBindingSize: 1024 * 1024 },
      createBuffer: () => ({ destroy() {} }),
      createBindGroup: () => ({}),
      createBindGroupLayout: () => ({}),
      queue: { writeBuffer() {} },
    } as unknown as GPUDevice;
    const field = new OverlapCrossing(device, settings);
    const entities = [
      createTestEntity(),
      createTestEntity(),
      createTestEntity(),
      createTestEntity(),
    ];
    const action: ActionLayerRenderState = {
      active: true,
      returning: false,
      entityIds: new Set([entities[0]!.id, entities[2]!.id]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    field.update(entities, action, 0, 1, 1);
    field.update(entities, action, 100, 1, 1);
    const before = field.order(0, entities[0]!.id);
    expect(before).toBeLessThan(1);
    action.returning = true;
    field.update(entities, action, 100, 1, 1);
    expect(field.order(0, entities[0]!.id)).toBe(before);
    field.update(entities, action, 180, 1, 1);
    expect(field.order(0, entities[0]!.id)).toBeLessThan(before);
    expect(field.order(0, entities[0]!.id)).toBeLessThan(field.order(2, entities[2]!.id));
    field.destroy();
  });
  test("drag return follows a moving group, discovers neighbors and survives geometry commit", () => {
    let upload = new Float32Array();
    const device = {
      limits: { maxStorageBufferBindingSize: 1024 * 1024 },
      createBuffer: () => ({ destroy() {} }),
      createBindGroup: () => ({}),
      createBindGroupLayout: () => ({}),
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, source: ArrayBuffer) => {
          upload = new Float32Array(source).slice();
        },
      },
    } as unknown as GPUDevice;
    const field = new OverlapCrossing(device, settings);
    const card = (id: string, x: number) =>
      createTestEntity({ id, position: { x, y: 0 }, size: { width: 100, height: 100 } });
    const entities = [
      card("a", 0),
      card("b", 20),
      card("near", 50),
      card("next", 190),
      card("next2", 210),
    ];
    const ids = new Set(["a", "b"]);
    const action: ActionLayerRenderState = {
      active: true,
      entityIds: ids,
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    const drag: DragVisualRenderState = {
      active: true,
      isDragPhase: true,
      entityIds: ids,
      scale: 0.9,
      offset: { x: 150, y: 0 },
      appliesToSelection: true,
    };
    field.update(entities, action, 0, 2, 2);
    expect(upload[0]).toBe(4); // Both selected cards cross the first neighbor only.
    field.update(entities, action, 500, 2, 2);
    action.returning = true;
    field.update(entities, action, 500, 2, 2, drag);
    expect(upload[5]).toBe(-1);
    expect(upload[0]).toBe(8); // Two selected cards, two new neighbors, reciprocal fields.
    expect(upload[28]).toBe(200); // Dragged a's rendered center, including transient offset.
    expect(upload[30]).toBe(45); // Scale applied about the center.
    expect(field.order(0, "a")).toBeGreaterThan(4);
    drag.offset.x = 170;
    field.update(entities, action, 750, 2, 2, drag);
    expect(upload[28]).toBe(220);
    field.update(entities, action, 900, 2, 2, drag);
    expect(field.order(0, "a")).toBe(0);
    // Release commits transient positions by replacing entity objects.
    entities[0] = card("a", 170);
    entities[1] = card("b", 190);
    drag.offset.x = 0;
    action.active = false;
    action.returning = false;
    field.update(entities, action, 950, 2, 2, drag);
    expect(upload[28]).toBe(220);
    expect(field.pending).toBe(true);
    entities.splice(3, 2); // Deleted neighbors cannot leave phantom fields.
    field.update(entities, action, 1000, 2, 2, drag);
    expect(upload[0]).toBe(0);
    field.destroy();
  });

  test("RGB and wake controls upload independently and the longer tail stays scheduled", () => {
    let upload = new Float32Array();
    const device = {
      limits: { maxStorageBufferBindingSize: 1024 * 1024 },
      createBuffer: () => ({ destroy() {} }),
      createBindGroup: () => ({}),
      createBindGroupLayout: () => ({}),
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, source: ArrayBuffer) => {
          upload = new Float32Array(source).slice();
        },
      },
    } as unknown as GPUDevice;
    const field = new OverlapCrossing(device, settings);
    const entities = [createTestEntity(), createTestEntity()];
    const action: ActionLayerRenderState = {
      active: true,
      entityIds: new Set([entities[0]!.id]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    Object.assign(settings, {
      rgbStrength: 1.55,
      wakeStrength: 0.3,
      rgbDecay: 200,
      wakeDecay: 800,
      rgbSplit: 7,
      wakeWidth: 14,
    });
    field.update(entities, action, 0, 1, 1);
    field.update(entities, action, 800, 1, 1);
    expect(upload[1]).toBeCloseTo(1.55);
    expect(upload[2]).toBe(1); // RGB has finished.
    expect(upload[3]).toBeCloseTo(0.3);
    expect(upload[7]).toBe(0.5); // Wake still has half its decay remaining.
    expect(Array.from(upload.slice(8, 10))).toEqual([7, 14]);
    expect(field.pending).toBe(true);
    Object.assign(settings, { wakeStrength: 0, wakeWidth: 20 });
    field.update(entities, action, 900, 1, 1);
    expect(upload[1]).toBeCloseTo(1.55);
    expect(upload[3]).toBe(0);
    expect(upload[8]).toBe(7);
    expect(upload[9]).toBe(20);
    field.update(entities, action, 1201, 1, 1);
    expect(field.pending).toBe(false);
    field.destroy();
  });

  test("drag-under affects only upper neighbors, responds to speed, and fades when paused", () => {
    const { field, latest, entities, action, drag } = motionFixture();
    Object.assign(settings, { dragUnder: true, rgbDecay: 200, wakeDecay: 600 });
    field.update(entities, action, 0, 1, 1, drag);
    expect(field.pending).toBe(false);
    drag.offset.x = 1;
    field.update(entities, action, 16, 1, 1, drag);
    expect(latest()[0]).toBe(2); // Two upper cards, no effect on the mover.
    expect(latest()[18]).toBe(field.key("upper-a"));
    expect(latest()[34]).toBe(field.key("upper-b"));
    expect(latest()[19]).toBe(0); // Motion fields never exchange depth.
    const slow = latest()[21]!;
    drag.offset.x = 17;
    field.update(entities, action, 32, 1, 1, drag);
    expect(latest()[21]).toBeGreaterThan(slow);
    expect(field.order(0, "moving")).toBe(0);
    const moving = latest()[22]!;
    field.update(entities, action, 250, 1, 1, drag);
    expect(latest()[21]).toBe(0); // RGB tail completed; wake continues.
    expect(latest()[22]).toBeGreaterThan(0);
    expect(latest()[22]).toBeLessThan(moving);
    field.update(entities, action, 633, 1, 1, drag);
    expect(field.pending).toBe(false);
    field.destroy();
  });

  test("steers RGB through reversals without immediately flipping the old flow", () => {
    settings.dragUnder = true;
    const { field, latest, entities, action, drag } = motionFixture();
    field.update(entities, action, 0, 1, 1, drag);
    drag.offset.x = 16;
    field.update(entities, action, 16, 1, 1, drag);
    expect(latest()[24]).toBeCloseTo(1);
    expect(latest()[25]).toBeCloseTo(0);
    drag.offset.x = 0;
    field.update(entities, action, 32, 1, 1, drag);
    expect(latest()[24]).toBeGreaterThan(0);
    expect(latest()[24]).toBeLessThan(0.4);
    drag.offset.x = -16;
    field.update(entities, action, 48, 1, 1, drag);
    expect(latest()[24]).toBeLessThan(0);
    const direction = latest()[24];
    field.update(entities, action, 100, 1, 1, drag);
    expect(latest()[24]).toBe(direction); // Decay continues in the last travel direction.
    field.destroy();
  });

  test("drag-under tracks group offsets, retains the last footprint, and clears when disabled", () => {
    const { field, latest, entities, action, drag } = motionFixture();
    Object.assign(settings, { dragUnder: true });
    drag.entityIds = new Set(["moving", "upper-a"]);
    field.update(entities, action, 0, 1, 1, drag);
    drag.offset.x = 10;
    field.update(entities, action, 16, 1, 1, drag);
    expect(latest()[0]).toBe(2); // Both group members influence upper-b, never each other.
    expect(latest()[18]).toBe(field.key("upper-b"));
    expect(latest()[34]).toBe(field.key("upper-b"));
    const footprint = latest()[12];
    drag.offset.x = 400;
    field.update(entities, action, 32, 1, 1, drag);
    expect(latest()[12]).toBe(footprint); // Leaving keeps the old imprint while it decays.
    Object.assign(settings, { dragUnder: false });
    field.update(entities, action, 48, 1, 1, drag);
    expect(latest()[0]).toBe(0);
    expect(field.pending).toBe(false);
    field.destroy();
  });

  test("ordinary dragging does not create overlap effects by default", () => {
    const { field, latest, entities, action, drag } = motionFixture();
    expect(overlapConfig.dragUnder).toBe(false);
    field.update(entities, action, 0, 1, 1, drag);
    drag.offset.x = 10;
    field.update(entities, action, 16, 1, 1, drag);
    expect(field.pending).toBe(false);

    // The remaining assertions exercise the dormant path's motion bookkeeping.
    Object.assign(settings, { dragUnder: true });
    field.update(entities, action, 32, 1, 1, drag);
    field.update(entities, action, 48, 2, 2, drag);
    expect(field.pending).toBe(false);
    drag.offset.x = 20;
    field.update(entities, action, 64, 2, 2, drag);
    const energy = latest()[21]!;
    entities[0] = { ...entities[0]!, position: { x: 20, y: 0 } };
    drag.offset.x = 0;
    field.update(entities, action, 80, 2, 2, drag);
    expect(latest()[21]).toBeLessThan(energy); // No spurious movement on commit.
    field.destroy();
  });

  test("changing the user preference clears a live desktop drag-under field", () => {
    const { field, latest, entities, action, drag } = motionFixture();
    settings.dragUnder = true;
    field.update(entities, action, 0, 1, 1, drag, true);
    drag.offset.x = 10;
    field.update(entities, action, 16, 1, 1, drag, true);
    expect(field.pending).toBe(true);
    field.update(entities, action, 32, 1, 1, drag, false);
    expect(field.enabled).toBe(false);
    expect(field.pending).toBe(false);
    expect(latest()[0]).toBe(0);
    field.destroy();
  });

  test("off and cancellation clear the contact field", () => {
    const device = {
      limits: { maxStorageBufferBindingSize: 1024 * 1024 },
      createBuffer: () => ({ destroy() {} }),
      createBindGroup: () => ({}),
      createBindGroupLayout: () => ({}),
      queue: { writeBuffer() {} },
    } as unknown as GPUDevice;
    const field = new OverlapCrossing(device, settings);
    const entities = [createTestEntity(), createTestEntity()];
    const action: ActionLayerRenderState = {
      active: true,
      entityIds: new Set([entities[0]!.id]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    field.update(entities, action, 0, 1, 1);
    action.active = false;
    field.update(entities, action, 10, 1, 1);
    expect(field.pending).toBe(false);
    action.active = true;
    field.update(entities, action, 20, 1, 1);
    Object.assign(settings, { enabled: false });
    field.update(entities, action, 30, 1, 1);
    expect(field.pending).toBe(false);
    expect(field.order(0, entities[0]!.id)).toBe(0);
    field.destroy();
  });

  test("indexes only each participant's contacts in stack order and clears stale membership", () => {
    let upload = new ArrayBuffer(0);
    const device = {
      limits: { maxStorageBufferBindingSize: 1024 * 1024 },
      createBuffer: () => ({ destroy() {} }),
      createBindGroup: () => ({}),
      createBindGroupLayout: () => ({}),
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, source: ArrayBuffer) => {
          upload = source.slice(0);
        },
      },
    } as unknown as GPUDevice;
    const field = new OverlapCrossing(device, settings);
    const entities = ["lifted", "cover-a", "cover-b", "unrelated"].map((id) =>
      createTestEntity({ id, position: { x: id === "unrelated" ? 1000 : 0, y: 0 } }),
    );
    const action: ActionLayerRenderState = {
      active: true,
      entityIds: new Set(["lifted"]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    // Reserve an unrelated key before upload; new keys after upload must also be safe.
    field.key("unrelated");
    const membership = (id: string): number[] => {
      const words = new Uint32Array(upload);
      const key = field.key(id);
      if (key >= words[10]!) return [];
      const offset = words[11]! + key * 2;
      return Array.from(words.slice(words[offset]!, words[offset]! + words[offset + 1]!));
    };
    field.update(entities, action, 0, 1, 1);
    expect(membership("lifted")).toEqual([0, 2]);
    expect(membership("cover-a")).toEqual([1]);
    expect(membership("cover-b")).toEqual([3]);
    expect(membership("unrelated")).toEqual([]);
    expect(membership("new-key")).toEqual([]);
    entities[1] = createTestEntity({ id: "cover-a", position: { x: 1000, y: 0 } });
    field.update(entities, action, 100, 1, 1);
    expect(membership("lifted")).toEqual([0]);
    expect(membership("cover-a")).toEqual([]);
    expect(membership("cover-b")).toEqual([1]);
    field.update(entities, { ...action, active: false }, 200, 1, 1);
    expect(new Float32Array(upload)[0]).toBe(0);
    field.destroy();
  });

  test.each([0, 35, -45])(
    "slice pruning preserves the per-pixel partition at rotation %s",
    (rotation) => {
      let upload = new Float32Array();
      const device = {
        limits: { maxStorageBufferBindingSize: 1024 * 1024 },
        createBuffer: () => ({ destroy() {} }),
        createBindGroup: () => ({}),
        createBindGroupLayout: () => ({}),
        queue: {
          writeBuffer: (_buffer: unknown, _offset: number, source: ArrayBuffer) => {
            upload = new Float32Array(source).slice();
          },
        },
      } as unknown as GPUDevice;
      const field = new OverlapCrossing(device, settings);
      const entities = Array.from({ length: 12 }, (_, index) =>
        createTestEntity({
          id: `card-${index}`,
          size: { width: 240, height: 180 },
          position: { x: index * 5, y: index * 3 },
          rotation: index === 0 ? rotation : (index % 2) * 12,
        }),
      );
      const action: ActionLayerRenderState = {
        active: true,
        entityIds: new Set(["card-0"]),
        entityOffset: { x: 0, y: -12 },
        blurIntensity: 1,
      };
      let pruned = false;
      for (const now of [0, 20, 60, 100, 160, 220, 280, 360, 400, 900]) {
        action.returning = rotation < 0 && now >= 220;
        field.update(entities, action, now, 2, 3);
        const emitted = new Map<number, number>();
        field.appendSlices("card-0", (anchor, slice) => {
          const original = anchor === 0 ? 1 : (anchor - 0.5 - 1) * 2 + 2;
          emitted.set(original, slice);
        });
        pruned ||= emitted.size < 12;
        const lift = upload[4]!;
        const angle = (rotation * Math.PI) / 180;
        for (let y = -3; y <= 183; y += 6)
          for (let x = -3; x <= 243; x += 6) {
            const worldX = (x - 120) * Math.cos(angle) - (y - 90) * Math.sin(angle) + 120;
            const worldY = (x - 120) * Math.sin(angle) + (y - 90) * Math.cos(angle) + 90 - 18;
            let previous = 1;
            let previousSlice = 1;
            for (let i = 0; i < upload[0]!; i += 2) {
              const offset = 12 + i * 16;
              const axisX = upload[offset + 12]!,
                axisY = upload[offset + 13]!;
              const dx = worldX - upload[offset + 14]!,
                dy = worldY - upload[offset + 15]!;
              const along = (dx * axisX + dy * axisY) / upload[offset + 11]!;
              const across = (-dx * axisY + dy * axisX) / upload[offset + 11]!;
              const depth = upload[offset + 9]!;
              const width = Math.min(0.14, Math.min(depth, 1 - depth) * 0.8);
              const ripple = 0.12 * Math.sin(across * 8 - lift * 6) * Math.min(upload[3]!, 1);
              const travel = lift - depth + (along + ripple) * 4 * lift * (1 - lift) * 0.28;
              const t = Math.max(0, Math.min(1, (travel + width) / (2 * width)));
              const passage = Math.min(previous, t * t * (3 - 2 * t));
              const weight = previous - passage;
              expect(weight).toBe(
                !emitted.has(previousSlice) ? 0 : emitted.get(previousSlice) === 0 ? 1 : weight,
              );
              previous = passage;
              previousSlice = i + 2;
            }
            expect(previous).toBe(
              !emitted.has(previousSlice) ? 0 : emitted.get(previousSlice) === 0 ? 1 : previous,
            );
          }
      }
      expect(pruned).toBe(true);
      field.destroy();
    },
  );

  test("fails explicitly at the storage limit without destroying the previous allocation", () => {
    const buffer = { destroy: vi.fn<GPUBuffer["destroy"]>() };
    const device = {
      limits: { maxStorageBufferBindingSize: 128 },
      createBuffer: vi.fn<() => typeof buffer>(() => buffer),
      createBindGroup: () => ({}),
      createBindGroupLayout: () => ({}),
      queue: { writeBuffer() {} },
    } as unknown as GPUDevice;
    const field = new OverlapCrossing(device, settings);
    const entities = [createTestEntity(), createTestEntity()];
    const action: ActionLayerRenderState = {
      active: true,
      entityIds: new Set([entities[0]!.id]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    expect(() => field.update(entities, action, 0, 1, 1)).toThrow("GPU storage binding limit");
    expect(device.createBuffer).toHaveBeenCalledOnce();
    expect(buffer.destroy).not.toHaveBeenCalled();
    field.destroy();
  });
});

function motionFixture() {
  let upload = new Float32Array();
  const device = {
    limits: { maxStorageBufferBindingSize: 1024 * 1024 },
    createBuffer: () => ({ destroy() {} }),
    createBindGroup: () => ({}),
    createBindGroupLayout: () => ({}),
    queue: {
      writeBuffer: (_buffer: unknown, _offset: number, source: ArrayBuffer) => {
        upload = new Float32Array(source).slice();
      },
    },
  } as unknown as GPUDevice;
  const entities = ["moving", "upper-a", "upper-b"].map((id) =>
    createTestEntity({ id, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } }),
  );
  const action: ActionLayerRenderState = {
    active: false,
    entityIds: new Set(),
    entityOffset: { x: 0, y: 0 },
    blurIntensity: 0,
  };
  const drag: DragVisualRenderState = {
    active: true,
    isDragPhase: true,
    entityIds: new Set(["moving"]),
    scale: 1,
    offset: { x: 0, y: 0 },
    appliesToSelection: true,
  };
  return {
    field: new OverlapCrossing(device, settings),
    latest: () => upload,
    entities,
    action,
    drag,
  };
}
