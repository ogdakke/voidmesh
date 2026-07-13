import { describe, expect, it } from "vitest";
import {
  COLLABORATION_PROTOCOL_VERSION,
  clearCollaborationInvite,
  createCollaborationInvite,
  createCollaborationInviteUrl,
  hashBlob,
  parseCollaborationInvite,
  prepareAssetPayload,
  restoreAssetPayload,
  type ReceivedAssetMetadata,
} from "#lib/collaboration/protocol.ts";

describe("collaboration invite links", () => {
  it("round-trips an invite without modifying existing query state", () => {
    const invite = createCollaborationInvite();
    const url = createCollaborationInviteUrl(invite, "https://voidmesh.app/?shader=glass");

    expect(parseCollaborationInvite(url)).toEqual(invite);
    expect(new URL(url).search).toBe("?shader=glass");
    expect(clearCollaborationInvite(url)).toBe("https://voidmesh.app/?shader=glass");
  });

  it("rejects malformed or incompatible invites", () => {
    expect(parseCollaborationInvite("https://voidmesh.app/#collab=v3.room.key")).toBeNull();
    expect(parseCollaborationInvite("https://voidmesh.app/#anything-else")).toBeNull();
  });
});

describe("collaboration asset payloads", () => {
  it("compresses repetitive SVG data and restores it", async () => {
    const source = "<svg>" + "<path d='M 0 0 L 100 100'/>".repeat(200) + "</svg>";
    const blob = new Blob([source], { type: "image/svg+xml" });
    const prepared = await prepareAssetPayload(blob, blob.type);
    const metadata: ReceivedAssetMetadata = {
      transferId: "svg-transfer",
      hash: await hashBlob(blob),
      mimeType: blob.type,
      byteLength: blob.size,
      filename: "drawing.svg",
      compression: prepared.compression,
      originalByteLength: prepared.originalByteLength,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    };

    expect(prepared.compression).toBe("gzip");
    expect(prepared.transmittedByteLength).toBeLessThan(prepared.originalByteLength);
    expect(await (await restoreAssetPayload(prepared.bytes, metadata)).text()).toBe(source);
  });

  it("does not recompress encoded video bytes", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(2048));
    const prepared = await prepareAssetPayload(
      new Blob([bytes], { type: "video/mp4" }),
      "video/mp4",
    );

    expect(prepared.compression).toBe("identity");
    expect(prepared.bytes).toEqual(bytes);
  });

  it("detects a corrupt decompressed length", async () => {
    const metadata: ReceivedAssetMetadata = {
      transferId: "video-transfer",
      hash: "hash",
      mimeType: "video/mp4",
      byteLength: 3,
      filename: "clip.mp4",
      compression: "identity",
      originalByteLength: 4,
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    };

    await expect(restoreAssetPayload(new Uint8Array([1, 2, 3]), metadata)).rejects.toThrow(
      "Asset length mismatch",
    );
  });
});
