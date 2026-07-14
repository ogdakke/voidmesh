import { describe, expect, it, vi } from "vitest";
import { CanvasStore } from "#engine";

describe("CanvasStore collaboration presence", () => {
  it("tracks cursor-only and selection presence versions independently", () => {
    const store = new CanvasStore();
    store.setRemotePeerPresence({
      peerId: "peer",
      name: "Dithered Texel",
      color: [1, 0, 0, 1],
      cursor: { x: 1, y: 2 },
      selectedEntityIds: ["first"],
    });
    const initial = store.getRenderState();
    expect(initial.presenceVersion).toBe(1);
    expect(initial.presenceSelectionVersion).toBe(1);

    store.clearDirtyFlags();
    store.setRemotePeerPresence({
      peerId: "peer",
      name: "Dithered Texel",
      color: [1, 0, 0, 1],
      cursor: { x: 3, y: 4 },
      selectedEntityIds: ["first"],
    });
    const moved = store.getRenderState();
    expect(moved.presenceVersion).toBe(2);
    expect(moved.presenceSelectionVersion).toBe(1);
    expect(store.hasRenderChanges()).toBe(true);
  });

  it("publishes local cursor and selection through the imperative listener", () => {
    const store = new CanvasStore();
    const listener =
      vi.fn<(cursor: { x: number; y: number } | null, selection: ReadonlySet<string>) => void>();
    const unsubscribe = store.subscribeLocalPresence(listener);
    store.setLocalCursor({ x: 20, y: 30 });
    store.setLocalCursor({ x: 20, y: 30 });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({ x: 20, y: 30 }, expect.any(Set));
    unsubscribe();
  });
});
