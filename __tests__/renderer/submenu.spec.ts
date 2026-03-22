import { describe, expect, test, vi } from "vitest";
import { SceneNode } from "../../renderer/ui/scene-node.ts";
import { SubmenuController } from "../../renderer/ui/submenu.ts";

function createTriggerNode() {
  const fixedRoot = new SceneNode("box", null, { position: "fixed" });
  fixedRoot.layout = { x: 20, y: 30, width: 240, height: 400 };

  const trigger = new SceneNode("box", null, {});
  trigger.parent = fixedRoot;
  trigger.layout = { x: 20, y: 30, width: 100, height: 32 };
  fixedRoot.children = [trigger];

  return trigger;
}

function createSubmenuNode(
  trigger: SceneNode,
  layout: { x: number; y: number; width: number; height: number },
) {
  const submenu = new SceneNode("box", null, { position: "absolute" });
  submenu.parent = trigger;
  submenu.layout = layout;
  trigger.children = [submenu];
  return submenu;
}

describe("SubmenuController", () => {
  test("stays open through trough toward a right submenu", () => {
    vi.useFakeTimers();
    const controller = new SubmenuController();
    const trigger = createTriggerNode();
    const submenu = createSubmenuNode(trigger, { x: 120, y: 30, width: 120, height: 100 });

    controller.open(trigger);
    vi.advanceTimersByTime(100);
    controller.syncSubmenuNode(submenu);

    expect(controller.handlePointerMove(80, 45, 1)).toBe(true);
    expect(controller.handlePointerMove(122, 45, 1)).toBe(true);
    expect(controller.handlePointerMove(145, 45, 1)).toBe(true);
    vi.useRealTimers();
  });

  test("closes when moving away from a right submenu corridor", () => {
    vi.useFakeTimers();
    const controller = new SubmenuController();
    const trigger = createTriggerNode();
    const submenu = createSubmenuNode(trigger, { x: 120, y: 30, width: 120, height: 100 });

    controller.open(trigger);
    vi.advanceTimersByTime(100);
    controller.syncSubmenuNode(submenu);

    expect(controller.handlePointerMove(80, 45, 1)).toBe(true);
    expect(controller.handlePointerMove(80, 180, 1)).toBe(false);
    vi.useRealTimers();
  });

  test("stays open when a tall submenu is clamped upward by layout", () => {
    vi.useFakeTimers();
    const controller = new SubmenuController();
    const trigger = createTriggerNode();
    const submenu = createSubmenuNode(trigger, { x: 120, y: 4, width: 180, height: 420 });

    controller.open(trigger);
    vi.advanceTimersByTime(100);
    controller.syncSubmenuNode(submenu);

    expect(controller.handlePointerMove(118, 40, 1)).toBe(true);
    expect(controller.handlePointerMove(126, 24, 1)).toBe(true);
    expect(controller.handlePointerMove(136, 16, 1)).toBe(true);
    vi.useRealTimers();
  });
});
