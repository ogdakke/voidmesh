import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cardsOverlap, OverlapCrossing } from "#renderer/overlap-crossing.ts";
import { overlapLab, overlapDefaults } from "#lib/overlap-lab.ts";
import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("canvas overlap crossings", () => {
  beforeEach(() => {
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
    vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
    overlapLab.configure({ enabled: true, transition: 400, rgbDecay: 800, wakeDecay: 800 });
  });
  afterEach(() => {
    overlapLab.configure(overlapDefaults);
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
    const field = new OverlapCrossing(device);
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
    const field = new OverlapCrossing(device);
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
    const field = new OverlapCrossing(device);
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
    const field = new OverlapCrossing(device);
    const entities = [createTestEntity(), createTestEntity()];
    const action: ActionLayerRenderState = {
      active: true,
      entityIds: new Set([entities[0]!.id]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    overlapLab.configure({
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
    overlapLab.configure({ wakeStrength: 0, wakeWidth: 20 });
    field.update(entities, action, 900, 1, 1);
    expect(upload[1]).toBeCloseTo(1.55);
    expect(upload[3]).toBe(0);
    expect(upload[8]).toBe(7);
    expect(upload[9]).toBe(20);
    field.update(entities, action, 1201, 1, 1);
    expect(field.pending).toBe(false);
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
    const field = new OverlapCrossing(device);
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
    overlapLab.configure({ enabled: false });
    field.update(entities, action, 30, 1, 1);
    expect(field.pending).toBe(false);
    expect(field.order(0, entities[0]!.id)).toBe(0);
    field.destroy();
  });
});
