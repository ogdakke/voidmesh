import { describe, expect, test } from "vitest";
import {
  imageExtensionFromMime,
  MIME_BY_EXT,
  videoExtensionFromMime,
} from "#lib/serialization/media.ts";

describe("serialization media MIME mapping", () => {
  test("uses the shared MIME map for image extensions", () => {
    expect(imageExtensionFromMime("image/png")).toBe("png");
    expect(imageExtensionFromMime("image/jpeg")).toBe("jpeg");
    expect(imageExtensionFromMime("image/jpg")).toBe("jpeg");
    expect(MIME_BY_EXT.webp).toBe("image/webp");
  });

  test("keeps video extension selection limited to video MIME types", () => {
    expect(videoExtensionFromMime("video/mp4")).toBe("mp4");
    expect(videoExtensionFromMime("image/png")).toBe("mp4");
  });
});
