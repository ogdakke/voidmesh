import { describe, expect, test } from "vitest";
import { SceneNode } from "../../renderer/ui/scene-node.ts";

describe("SceneNode", () => {
  test("propagates render version bumps to ancestor nodes", () => {
    const root = new SceneNode("box", null, {});
    const parent = new SceneNode("box", null, {});
    const child = new SceneNode("box", null, {});

    root.children = [parent];
    parent.parent = root;
    parent.children = [child];
    child.parent = parent;

    const rootVersion = root.renderVersion;
    const parentVersion = parent.renderVersion;
    const childVersion = child.renderVersion;

    child.bumpRenderVersion();

    expect(child.renderVersion).toBe(childVersion + 1);
    expect(parent.renderVersion).toBe(parentVersion + 1);
    expect(root.renderVersion).toBe(rootVersion + 1);
  });
});
