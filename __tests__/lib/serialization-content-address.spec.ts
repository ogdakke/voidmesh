import { describe, expect, test } from "vitest";
import { contentMediaPath, renameMediaPaths } from "#lib/serialization/content-address.ts";
import type { StudioManifest } from "#lib/serialization/types.ts";

describe("content-addressed media paths", () => {
  test("names media by SHA-256, keeping the extension", async () => {
    const bytes = new TextEncoder().encode("abc");
    expect(await contentMediaPath("media/assets/a-1.PNG", bytes)).toBe(
      "media/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.png",
    );
  });

  test("points table and inline references at the new paths", () => {
    const manifest = {
      mediaFiles: ["media/a.png", "media/b.gif"],
      entities: [{ mediaFile: "media/c.mp4" }, { mediaFileRef: 0 }],
    } as unknown as StudioManifest;
    const renamed = new Map([
      ["media/a.png", "media/x.png"],
      ["media/c.mp4", "media/y.mp4"],
    ]);
    const out = renameMediaPaths(manifest, renamed);
    expect(out.mediaFiles).toEqual(["media/x.png", "media/b.gif"]);
    expect(out.entities[0]!.mediaFile).toBe("media/y.mp4");
  });
});
