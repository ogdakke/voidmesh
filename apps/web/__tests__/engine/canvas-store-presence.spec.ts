import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { canvasStore } from "#engine";
import { setupCanvasTest } from "../helpers/test-setup.ts";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
  canvasStore.clearDirtyFlags();
});

afterEach(() => cleanup());

describe("canvasStore remote presence", () => {
  test("publishes local cursor state through the imperative presence listener", () => {
    const listener =
      vi.fn<(cursor: { x: number; y: number } | null, selection: ReadonlySet<string>) => void>();
    const unsubscribe = canvasStore.subscribeLocalPresence(listener);

    canvasStore.setLocalCursor({ x: 20, y: 30 });
    canvasStore.setLocalCursor({ x: 20, y: 30 });
    canvasStore.setLocalCursor(null);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenNthCalledWith(2, { x: 20, y: 30 }, expect.any(Set));
    expect(listener).toHaveBeenLastCalledWith(null, expect.any(Set));
    unsubscribe();
  });

  test("keeps cursor motion off React subscriptions and selection geometry versions", () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = canvasStore.subscribe(listener);
    canvasStore.setRemotePeerPresence({
      peerId: "peer",
      name: "Dithered Texel",
      color: [1, 0, 0, 1],
      cursor: { x: 1, y: 2 },
      selectedEntityIds: ["first"],
    });
    const initial = canvasStore.getRenderState();
    const initialVersion = initial.presenceVersion;
    const initialSelectionVersion = initial.presenceSelectionVersion;

    canvasStore.clearDirtyFlags();
    canvasStore.setRemotePeerPresence({
      peerId: "peer",
      name: "Dithered Texel",
      color: [1, 0, 0, 1],
      cursor: { x: 3, y: 4 },
      selectedEntityIds: ["first"],
    });
    const moved = canvasStore.getRenderState();

    expect(listener).not.toHaveBeenCalled();
    expect(moved.presenceVersion).toBe(initialVersion + 1);
    expect(moved.presenceSelectionVersion).toBe(initialSelectionVersion);
    expect(moved.remotePeerPresences[0]?.cursor).toEqual({ x: 3, y: 4 });
    expect(canvasStore.hasRenderChanges()).toBe(true);
    expect(moved.dirty).toBe(true);
    expect(moved.sceneDirty).toBe(false);
    unsubscribe();
  });

  test("invalidates cached selection geometry when identity, selection, or membership changes", () => {
    canvasStore.setRemotePeerPresence({
      peerId: "peer",
      name: "Dithered Texel",
      color: [1, 0, 0, 1],
      cursor: null,
      selectedEntityIds: ["first"],
    });
    const initialVersion = canvasStore.getRenderState().presenceSelectionVersion;

    canvasStore.setRemotePeerPresence({
      peerId: "peer",
      name: "Dithered Texel",
      color: [1, 0, 0, 1],
      cursor: null,
      selectedEntityIds: ["second"],
    });
    expect(canvasStore.getRenderState().presenceSelectionVersion).toBe(initialVersion + 1);

    canvasStore.removeRemotePeerPresence("peer");
    expect(canvasStore.getRenderState().remotePeerPresences).toHaveLength(0);
    expect(canvasStore.getRenderState().presenceSelectionVersion).toBe(initialVersion + 2);
  });
});
