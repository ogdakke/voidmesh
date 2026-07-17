import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  HostedWorkspaceDocument,
  type HostedWorkspaceEntity,
} from "#lib/hosted-workspace-document.ts";
import { ShaderType, Shape } from "#types/canvas.ts";
import { config } from "#config";

function entity(): HostedWorkspaceEntity {
  return {
    asset: {
      byteLength: 42,
      contentType: "image/png",
      id: "asset-1",
      mediaType: "image",
      originalFilename: "source.png",
    },
    edited: false,
    id: "entity-1",
    locked: false,
    name: "Source",
    originalSize: { height: 100, width: 200 },
    playback: {
      currentTime: 2,
      isPlaying: true,
      loop: true,
      muted: true,
      playbackRate: 1,
      volume: 1,
    },
    playbackDuration: 10,
    position: { x: 1, y: 2 },
    rotation: 0,
    shaderParams: {
      ...structuredClone(config.defaults.shaderParams),
      shape: Shape.circle,
      time: 3,
      timeAutoPlay: true,
    },
    shaderType: ShaderType.halftone,
    size: { height: 100, width: 200 },
    zIndex: 1,
  };
}

function synchronize(source: Y.Doc, target: Y.Doc): void {
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
}

describe("HostedWorkspaceDocument", () => {
  it("merges concurrent changes to independent entity fields", () => {
    const leftY = new Y.Doc();
    const rightY = new Y.Doc();
    const left = new HostedWorkspaceDocument({ document: leftY, now: () => 1_000 });
    const right = new HostedWorkspaceDocument({ document: rightY, now: () => 1_000 });
    left.addEntity(entity());
    synchronize(leftY, rightY);

    const moved = left.getEntity("entity-1")!;
    moved.position = { x: 400, y: 500 };
    left.setGeometry(moved);
    const restyled = right.getEntity("entity-1")!;
    restyled.shaderParams.intensity = 0.25;
    right.setAppearance(restyled, false);

    synchronize(leftY, rightY);
    synchronize(rightY, leftY);
    expect(left.getEntity("entity-1")?.position).toEqual({ x: 400, y: 500 });
    expect(left.getEntity("entity-1")?.shaderParams.intensity).toBe(0.25);
    expect(right.getEntity("entity-1")).toEqual(left.getEntity("entity-1"));
  });

  it("projects media and shader playback from authority-aligned anchors", () => {
    let now = 1_000;
    const document = new HostedWorkspaceDocument({ document: new Y.Doc(), now: () => now });
    document.addEntity(entity());
    now = 5_000;

    const projected = document.getEntity("entity-1")!;
    expect(projected.playback?.currentTime).toBe(6);
    expect(projected.shaderParams.time).toBe(7);

    document.setPlayback("entity-1", { ...projected.playback!, currentTime: 9 }, 10);
    now = 8_000;
    expect(document.getEntity("entity-1")?.playback?.currentTime).toBe(2);
  });

  it("undoes only local Yjs transactions and projects the undo result", () => {
    const localY = new Y.Doc();
    const remoteY = new Y.Doc();
    const local = new HostedWorkspaceDocument({ document: localY, now: () => 1_000 });
    const remote = new HostedWorkspaceDocument({ document: remoteY, now: () => 1_000 });
    local.addEntity(entity());
    synchronize(localY, remoteY);
    local.undo.clear();
    remote.undo.clear();

    const moved = local.getEntity("entity-1")!;
    moved.position = { x: 40, y: 50 };
    local.setGeometry(moved);

    const renamed = remote.getEntity("entity-1")!;
    renamed.name = "Collaborator rename";
    remote.setIdentity(renamed);
    Y.applyUpdate(localY, Y.encodeStateAsUpdate(remoteY), Symbol("remote"));

    const projected: string[] = [];
    const unsubscribe = local.onChange((change) => {
      if (change.shouldProject) projected.push(...change.entityIds);
    });
    local.undo.undo();

    expect(local.getEntity("entity-1")?.position).toEqual({ x: 1, y: 2 });
    expect(local.getEntity("entity-1")?.name).toBe("Collaborator rename");
    expect(local.undo.canRedo()).toBe(true);
    expect(projected).toContain("entity-1");
    unsubscribe();
  });
});
