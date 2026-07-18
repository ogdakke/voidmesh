import { describe, expect, expectTypeOf, it } from "vitest";
import type { AssetThumbnailUploadRequest } from "../src/index.ts";
import { isIdentifier } from "../src/index.ts";

describe("API contract validation", () => {
  it("accepts bounded opaque identifiers", () => {
    expect(isIdentifier("workspace_01JABC-def")).toBe(true);
  });

  it("rejects paths and oversized identifiers", () => {
    expect(isIdentifier("../workspace")).toBe(false);
    expect(isIdentifier("x".repeat(129))).toBe(false);
  });

  it("keeps thumbnail backfill payloads JSON-safe and bounded by explicit metadata", () => {
    const input = {
      byteLength: 7,
      contentHash: "a".repeat(64),
      contentType: "image/webp",
      data: "cHJldmlldw==",
    } satisfies AssetThumbnailUploadRequest;

    expectTypeOf(input).toMatchTypeOf<AssetThumbnailUploadRequest>();
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  });
});
