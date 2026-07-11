import { describe, expect, test, beforeEach, vi } from "vitest";
import type { ColorPalette } from "#types/canvas.ts";

// Mock storage before importing palette-store
vi.mock("#lib/storage.ts", () => ({
  preferences: {
    getSnapToGrid: async () => false,
    setSnapToGrid: async () => {},
    getCustomPalettes: async () => [],
    setCustomPalettes: async () => {},
  },
  storage: {},
}));

// Must import after mocking
const { paletteStore } = await import("#lib/palette-store.ts");

const makePalette = (id: string, name?: string): ColorPalette => ({
  id,
  name: name ?? id,
  shortName: name ?? id,
  colors: [[1, 0, 0, 1]],
});

describe("PaletteStore", () => {
  beforeEach(() => {
    // Reset to empty
    paletteStore.setPalettes([]);
  });

  test("starts empty", () => {
    expect(paletteStore.getPalettes()).toEqual([]);
  });

  test("addPalette appends to list", () => {
    const p = makePalette("cstm_abc");
    paletteStore.addPalette(p);
    expect(paletteStore.getPalettes()).toEqual([p]);
  });

  test("addPalette preserves existing palettes", () => {
    const p1 = makePalette("cstm_a");
    const p2 = makePalette("cstm_b");
    paletteStore.addPalette(p1);
    paletteStore.addPalette(p2);
    expect(paletteStore.getPalettes()).toEqual([p1, p2]);
  });

  test("mergePalettes adds missing IDs in one notification", () => {
    const existing = makePalette("cstm_existing");
    const added = makePalette("cstm_added");
    paletteStore.addPalette(existing);
    let notifications = 0;
    const unsubscribe = paletteStore.subscribe(() => notifications++);

    paletteStore.mergePalettes([existing, added, added, makePalette("")]);

    expect(paletteStore.getPalettes()).toEqual([existing, added]);
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test("updatePalette replaces by ID", () => {
    const original = makePalette("cstm_a", "Original");
    paletteStore.addPalette(original);

    const updated: ColorPalette = { ...original, name: "Updated", colors: [[0, 1, 0, 1]] };
    paletteStore.updatePalette("cstm_a", updated);

    expect(paletteStore.getPalettes()).toHaveLength(1);
    expect(paletteStore.getPalettes()[0]!.name).toBe("Updated");
  });

  test("updatePalette does not affect other palettes", () => {
    const p1 = makePalette("cstm_a");
    const p2 = makePalette("cstm_b");
    paletteStore.addPalette(p1);
    paletteStore.addPalette(p2);

    const updated = { ...p1, name: "Changed" };
    paletteStore.updatePalette("cstm_a", updated);

    expect(paletteStore.getPalettes()[1]).toEqual(p2);
  });

  test("removePalette removes by ID", () => {
    const p = makePalette("cstm_a");
    paletteStore.addPalette(p);
    paletteStore.removePalette("cstm_a");
    expect(paletteStore.getPalettes()).toEqual([]);
  });

  test("removePalette preserves other palettes", () => {
    const p1 = makePalette("cstm_a");
    const p2 = makePalette("cstm_b");
    paletteStore.addPalette(p1);
    paletteStore.addPalette(p2);
    paletteStore.removePalette("cstm_a");
    expect(paletteStore.getPalettes()).toEqual([p2]);
  });

  test("setPalettes replaces entire list (hydration)", () => {
    const p1 = makePalette("cstm_a");
    paletteStore.addPalette(p1);

    const newPalettes = [makePalette("cstm_x"), makePalette("cstm_y")];
    paletteStore.setPalettes(newPalettes);
    expect(paletteStore.getPalettes()).toEqual(newPalettes);
  });

  test("getSnapshot returns new reference after mutation", () => {
    const snap1 = paletteStore.getSnapshot();
    paletteStore.addPalette(makePalette("cstm_a"));
    const snap2 = paletteStore.getSnapshot();
    expect(snap1).not.toBe(snap2);
  });

  test("getSnapshot returns same reference without mutation", () => {
    paletteStore.addPalette(makePalette("cstm_a"));
    const snap1 = paletteStore.getSnapshot();
    const snap2 = paletteStore.getSnapshot();
    expect(snap1).toBe(snap2);
  });

  test("subscribe notifies on mutations", () => {
    let callCount = 0;
    const unsub = paletteStore.subscribe(() => {
      callCount++;
    });

    paletteStore.addPalette(makePalette("cstm_a"));
    expect(callCount).toBe(1);

    paletteStore.updatePalette("cstm_a", makePalette("cstm_a", "New"));
    expect(callCount).toBe(2);

    paletteStore.removePalette("cstm_a");
    expect(callCount).toBe(3);

    unsub();
    paletteStore.addPalette(makePalette("cstm_b"));
    expect(callCount).toBe(3); // No notification after unsubscribe
  });
});
