import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeThumbhash,
  isMediaPreview,
  thumbhashFromBase64,
  thumbhashToBase64,
} from "#lib/thumbhash.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";

describe("runtime ThumbHash previews", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupCanvasTest();
  });

  afterEach(() => cleanup());

  it("bounds the encoder input and caches by decoded bitmap", () => {
    const bitmap = { width: 400, height: 200, close() {} } as ImageBitmap;
    const first = encodeThumbhash(bitmap);
    const second = encodeThumbhash(bitmap);

    expect(isMediaPreview(first)).toBe(true);
    expect(second).toBe(first);
  });

  it("round-trips preview bytes through workspace-safe base64", () => {
    const preview = { codec: "thumbhash-v1" as const, bytes: new Uint8Array([1, 2, 3, 4]) };
    expect(thumbhashFromBase64(thumbhashToBase64(preview))).toEqual(preview);
    expect(thumbhashFromBase64("%%%invalid%%%")).toBeNull();
  });
});
