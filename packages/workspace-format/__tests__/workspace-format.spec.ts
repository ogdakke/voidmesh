import { describe, expect, it } from "vitest";
import { archiveMediaPath, createVdmshManifest, readHostedArchiveEntities } from "../src/index.ts";

function snapshot() {
  return {
    entities: [
      {
        asset: {
          byteLength: 3,
          contentType: "image/png",
          id: "asset-1",
          mediaType: "image",
          originalFilename: "photo.png",
        },
        edited: false,
        generation: 0,
        id: "entity-1",
        locked: false,
        name: "Photo",
        originalSize: { height: 480, width: 640 },
        position: { x: 12, y: 24 },
        revisions: { appearance: 0, asset: 0, geometry: 0, identity: 0, layering: 0 },
        rotation: 0,
        shaderParams: { shape: "circle", size: 1 },
        shaderType: "none",
        size: { height: 480, width: 640 },
        zIndex: 1,
      },
    ],
    playback: [],
    roomSequence: 1,
    schemaVersion: 1,
    workspaceId: "workspace-1",
  };
}

describe("hosted workspace archive format", () => {
  it("reads a bounded scene snapshot and creates a v6 manifest", () => {
    const parsed = readHostedArchiveEntities(snapshot(), 1_000);
    const manifest = createVdmshManifest(parsed, {
      offset: { x: 5, y: -10 },
      zoom: 1.5,
    });

    expect(parsed).toHaveLength(1);
    expect(manifest).toMatchObject({
      entities: [
        {
          id: "entity-1",
          mediaFile: "media/assets/asset-1.png",
          mediaType: "image",
        },
      ],
      type: "studio-canvas",
      version: 6,
      viewport: { offset: { x: 5, y: -10 }, zoom: 1.5 },
    });
    expect(archiveMediaPath(parsed[0]!.asset)).toBe("media/assets/asset-1.png");
  });

  it("rejects malformed scene entity fields", () => {
    const malformed = snapshot();
    malformed.entities[0]!.name = "";
    expect(() => readHostedArchiveEntities(malformed)).toThrow("Invalid hosted workspace entity");
  });
});
