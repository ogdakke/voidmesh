import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { archiveMediaPath, createVdmshManifest, readHostedArchiveEntities } from "../src/index.ts";

describe("hosted workspace archive format", () => {
  it("reads a bounded hosted entity and creates a v6 manifest", () => {
    const document = new Y.Doc();
    const entities = document.getMap<Y.Map<unknown>>("entities");
    const entity = new Y.Map<unknown>();
    entities.set("entity-1", entity);
    entity.set("identity.name", "Photo");
    entity.set("identity.locked", false);
    entity.set("identity.edited", false);
    entity.set("geometry.position.x", 12);
    entity.set("geometry.position.y", 24);
    entity.set("geometry.size.width", 640);
    entity.set("geometry.size.height", 480);
    entity.set("geometry.originalSize.width", 640);
    entity.set("geometry.originalSize.height", 480);
    entity.set("geometry.rotation", 0);
    entity.set("geometry.zIndex", 1);
    entity.set("appearance.shaderType", "none");
    entity.set("appearance.params.size", 1);
    entity.set("appearance.params.shape", "circle");
    entity.set("asset", {
      byteLength: 3,
      contentType: "image/png",
      id: "asset-1",
      mediaType: "image",
      originalFilename: "photo.png",
    });

    const parsed = readHostedArchiveEntities(document, 1_000);
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

  it("rejects malformed collaborative entity fields", () => {
    const document = new Y.Doc();
    const entity = new Y.Map<unknown>();
    document.getMap<Y.Map<unknown>>("entities").set("entity-1", entity);
    entity.set("identity.name", "Broken");

    expect(() => readHostedArchiveEntities(document)).toThrow(
      "Invalid hosted workspace entity: entity-1",
    );
  });
});
