import { describe, expect, it } from "vitest";
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
    const left = new CollaborationDocument();
    const right = new CollaborationDocument();
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
});
