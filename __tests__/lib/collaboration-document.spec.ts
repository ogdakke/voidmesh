import { describe, expect, it } from "vitest";
import type { ColorPalette } from "#types/canvas.ts";
import { CollaborationDocument } from "#lib/collaboration/document.ts";
import { createCollaborativeEntity } from "#lib/collaboration/protocol.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

function connect(left: CollaborationDocument, right: CollaborationDocument): () => void {
  const unsubscribeLeft = left.onUpdate((update, isRemote) => {
    if (!isRemote) right.applyUpdate(update);
  });
  const unsubscribeRight = right.onUpdate((update, isRemote) => {
    if (!isRemote) left.applyUpdate(update);
  });
  return () => {
    unsubscribeLeft();
    unsubscribeRight();
  };
}

function toCollaborative(id: string) {
  const entity = createTestEntity({ id });
  return {
    entity,
    collaborative: createCollaborativeEntity(entity, {
      transferId: `${id}-transfer`,
      hash: `${id}-hash`,
      mimeType: "image/png",
      byteLength: 10,
      filename: `${id}.png`,
      preview: { codec: "thumbhash-v1", bytes: new Uint8Array([1]) },
    }),
  };
}

describe("CollaborationDocument", () => {
  it("keeps unrelated playback commands stable across other entity updates", () => {
    const document = new CollaborationDocument();
    const entity = createTestEntity({
      id: "playing-video",
      mediaType: "video",
      videoDuration: 10,
    });
    const collaborative = createCollaborativeEntity(entity, {
      transferId: "video-transfer",
      hash: "video-hash",
      mimeType: "video/mp4",
      byteLength: 10,
      filename: "video.mp4",
      preview: { codec: "thumbhash-v1", bytes: new Uint8Array([1]) },
    });
    document.addEntity(collaborative);
    const initialCommandId = document.getEntities()[0]?.playbackCommandId;

    entity.position = { x: 20, y: 30 };
    document.setGeometry(entity);
    expect(document.getEntities()[0]?.playbackCommandId).toBe(initialCommandId);

    document.setPlayback(entity.id, { ...entity.playback!, isPlaying: true }, 10);
    expect(document.getEntities()[0]?.playbackCommandId).not.toBe(initialCommandId);
  });

  it("wraps an advancing loop clock by media duration", () => {
    let now = 1_000;
    const document = new CollaborationDocument({ now: () => now });
    const entity = createTestEntity({
      id: "looping-video",
      mediaType: "video",
      videoDuration: 10,
    });
    if (!entity.playback) throw new Error("Expected playback state");
    entity.playback = { ...entity.playback, isPlaying: true, currentTime: 9, loop: true };
    document.addEntity(
      createCollaborativeEntity(entity, {
        transferId: "loop-transfer",
        hash: "loop-hash",
        mimeType: "video/mp4",
        byteLength: 10,
        filename: "loop.mp4",
        preview: { codec: "thumbhash-v1", bytes: new Uint8Array([1]) },
      }),
    );

    now = 3_500;

    expect(document.getEntities()[0]?.playback).toMatchObject({
      isPlaying: true,
      currentTime: 1.5,
    });
  });

  it("advances remote playback using the measured peer clock offset", () => {
    let leftNow = 11_000;
    let rightNow = 1_000;
    const left = new CollaborationDocument({ sourceId: "left", now: () => leftNow });
    const right = new CollaborationDocument({ sourceId: "right", now: () => rightNow });
    right.setPeerClockOffset("left", 10_000);
    const entity = createTestEntity({
      id: "clocked-video",
      mediaType: "video",
      videoDuration: 30,
    });
    if (!entity.playback) throw new Error("Expected playback state");
    entity.playback = { ...entity.playback, isPlaying: true, currentTime: 4 };
    left.addEntity(
      createCollaborativeEntity(entity, {
        transferId: "clocked-transfer",
        hash: "clocked-hash",
        mimeType: "video/mp4",
        byteLength: 10,
        filename: "clocked.mp4",
        preview: { codec: "thumbhash-v1", bytes: new Uint8Array([1]) },
      }),
    );
    right.applyUpdate(left.encodeState());
    rightNow = 2_500;
    leftNow = 12_500;

    expect(right.getEntities()[0]).toMatchObject({
      playback: { isPlaying: true, currentTime: 5.5 },
      playbackSourceId: "left",
    });
  });

  it("advances animated shader time from a shared clock anchor", () => {
    let leftNow = 11_000;
    let rightNow = 1_000;
    const left = new CollaborationDocument({ sourceId: "left", now: () => leftNow });
    const right = new CollaborationDocument({ sourceId: "right", now: () => rightNow });
    right.setPeerClockOffset("left", 10_000);
    const { entity, collaborative } = toCollaborative("clocked-shader");
    entity.shaderParams.time = 4;
    entity.shaderParams.timeAutoPlay = true;
    collaborative.shaderParams = structuredClone(entity.shaderParams);

    left.addEntity(collaborative);
    right.applyUpdate(left.encodeState());
    rightNow = 2_500;
    leftNow = 12_500;

    expect(right.getEntity(entity.id)).toMatchObject({
      shaderParams: { time: 5.5, timeAutoPlay: true },
      shaderPlaybackSourceId: "left",
    });
  });

  it("keeps scrubbed shader time fixed while paused", () => {
    let now = 1_000;
    const document = new CollaborationDocument({ now: () => now });
    const { entity, collaborative } = toCollaborative("scrubbed-shader");
    document.addEntity(collaborative);
    entity.shaderParams.time = 8.25;
    entity.shaderParams.timeAutoPlay = false;

    document.setShaderPlayback([entity]);
    now = 10_000;

    expect(document.getEntity(entity.id)?.shaderParams).toMatchObject({
      time: 8.25,
      timeAutoPlay: false,
    });
  });

  it("publishes a provisional preview before the content hash is available", () => {
    const left = new CollaborationDocument();
    const right = new CollaborationDocument();
    const disconnect = connect(left, right);
    const { collaborative } = toCollaborative("previewed");
    const { hash: _hash, ...provisionalAsset } = collaborative.asset;

    left.addEntity({ ...collaborative, asset: provisionalAsset });
    expect(right.getEntities()[0]?.asset).toEqual(provisionalAsset);

    left.setAsset("previewed", collaborative.asset);
    expect(right.getEntities()[0]?.asset).toEqual(collaborative.asset);
    disconnect();
  });

  it("converges concurrent geometry and appearance edits without overwriting either", () => {
    const left = new CollaborationDocument({ now: () => 1_000 });
    const right = new CollaborationDocument({ now: () => 1_000 });
    const { entity, collaborative } = toCollaborative("shared");
    left.addEntity(collaborative);
    right.applyUpdate(left.encodeState());

    const leftUpdates: Uint8Array[] = [];
    const rightUpdates: Uint8Array[] = [];
    const unsubscribeLeft = left.onUpdate((update, remote) => {
      if (!remote) leftUpdates.push(update);
    });
    const unsubscribeRight = right.onUpdate((update, remote) => {
      if (!remote) rightUpdates.push(update);
    });

    entity.position = { x: 20, y: 30 };
    left.setGeometry(entity);
    entity.shaderParams = { ...entity.shaderParams, intensity: 2 };
    right.setAppearance(entity);
    for (const update of leftUpdates) right.applyUpdate(update);
    for (const update of rightUpdates) left.applyUpdate(update);

    expect(left.getEntities()).toEqual(right.getEntities());
    expect(left.getEntities()[0]).toMatchObject({
      position: { x: 20, y: 30 },
      shaderParams: { intensity: 2 },
    });
    unsubscribeLeft();
    unsubscribeRight();
  });

  it("converges concurrent edits to separate shader parameter leaves", () => {
    const left = new CollaborationDocument({ now: () => 1_000 });
    const right = new CollaborationDocument({ now: () => 1_000 });
    const { entity, collaborative } = toCollaborative("leaf-edits");
    left.addEntity(collaborative);
    right.applyUpdate(left.encodeState());
    const leftUpdates: Uint8Array[] = [];
    const rightUpdates: Uint8Array[] = [];
    const unsubscribeLeft = left.onUpdate((update, remote) => {
      if (!remote) leftUpdates.push(update);
    });
    const unsubscribeRight = right.onUpdate((update, remote) => {
      if (!remote) rightUpdates.push(update);
    });

    entity.shaderParams = {
      ...entity.shaderParams,
      adjustments: { ...entity.shaderParams.adjustments!, brightness: 0.75 },
    };
    left.setAppearance(entity);
    entity.shaderParams = {
      ...entity.shaderParams,
      adjustments: { ...entity.shaderParams.adjustments!, brightness: 0.5, contrast: 0.9 },
    };
    right.setAppearance(entity);
    for (const update of leftUpdates) right.applyUpdate(update);
    for (const update of rightUpdates) left.applyUpdate(update);

    expect(left.getEntity(entity.id)?.shaderParams.adjustments).toMatchObject({
      brightness: 0.75,
      contrast: 0.9,
    });
    expect(left.getEntities()).toEqual(right.getEntities());
    unsubscribeLeft();
    unsubscribeRight();
  });

  it("reports only changed entity IDs and distinguishes local from remote transactions", () => {
    const left = new CollaborationDocument();
    const right = new CollaborationDocument();
    for (let index = 0; index < 1_000; index++) {
      left.addEntity(toCollaborative(`entity-${index}`).collaborative);
    }
    right.applyUpdate(left.encodeState());
    const changes: Array<{ ids: string[]; remote: boolean }> = [];
    const unsubscribe = right.onChange((change) => {
      if (change.entityIds.size > 0) {
        changes.push({ ids: [...change.entityIds], remote: change.isRemote });
      }
    });
    const target = toCollaborative("entity-500").entity;
    target.position = { x: 42, y: 84 };
    right.setGeometry(target);

    expect(changes.at(-1)).toEqual({ ids: ["entity-500"], remote: false });

    const update = (() => {
      let result: Uint8Array | undefined;
      const stop = left.onUpdate((next, remote) => {
        if (!remote) result = next;
      });
      target.position = { x: 12, y: 24 };
      left.setGeometry(target);
      stop();
      return result!;
    })();
    right.applyUpdate(update);
    expect(changes.at(-1)).toEqual({ ids: ["entity-500"], remote: true });
    unsubscribe();
  });

  it("replicates custom palette metadata independently from entity projection", () => {
    const left = new CollaborationDocument();
    const right = new CollaborationDocument();
    const disconnect = connect(left, right);
    const { collaborative } = toCollaborative("palette-entity");
    collaborative.shaderParams.palette = {
      id: "cstm_shared",
      name: "Shared Sunset",
      shortName: "Sunset",
      colors: [
        [0, 0, 0, 1],
        [1, 0.5, 0, 1],
      ],
    };

    left.addEntity(collaborative);

    expect(right.getPalettes()).toEqual([collaborative.shaderParams.palette]);
    disconnect();
  });

  it("replicates palette deletion and blocks stale entity resurrection until undo", () => {
    const left = new CollaborationDocument();
    const right = new CollaborationDocument();
    const disconnect = connect(left, right);
    const palette: ColorPalette = {
      id: "cstm_deleted",
      name: "Deleted Sunset",
      shortName: "Sunset",
      colors: [
        [0, 0, 0, 1],
        [1, 0.5, 0, 1],
      ],
    };
    left.setPalettes([palette]);
    const stale = toCollaborative("stale-palette-entity").collaborative;
    stale.shaderParams.palette = structuredClone(palette);

    left.removePalette(palette.id!);
    right.addEntity(stale);

    expect(left.getPalettes()).toEqual([]);
    expect(right.getPalettes()).toEqual([]);

    left.restorePalette(palette);

    expect(left.getPalettes()).toEqual([palette]);
    expect(right.getPalettes()).toEqual([palette]);
    disconnect();
  });

  it("synchronizes additions and deletions over an update bridge", () => {
    const left = new CollaborationDocument();
    const right = new CollaborationDocument();
    const disconnect = connect(left, right);

    left.addEntity(toCollaborative("first").collaborative);
    right.addEntity(toCollaborative("second").collaborative);
    left.removeEntities(["first"]);

    expect(left.getEntities().map(({ id }) => id)).toEqual(["second"]);
    expect(right.getEntities().map(({ id }) => id)).toEqual(["second"]);
    disconnect();
  });

  it("publishes duplicate asset completion as one document update", () => {
    const document = new CollaborationDocument();
    const first = toCollaborative("first").collaborative;
    const second = toCollaborative("second").collaborative;
    document.addEntity(first);
    document.addEntity(second);
    const updates: Uint8Array[] = [];
    const unsubscribe = document.onUpdate((update, remote) => {
      if (!remote) updates.push(update);
    });

    document.setAssets([
      { entityId: first.id, asset: { ...first.asset, hash: "shared-hash" } },
      { entityId: second.id, asset: { ...second.asset, hash: "shared-hash" } },
    ]);

    expect(updates).toHaveLength(1);
    expect(document.getEntities().map((entity) => entity.asset.hash)).toEqual([
      "shared-hash",
      "shared-hash",
    ]);
    unsubscribe();
  });
});
