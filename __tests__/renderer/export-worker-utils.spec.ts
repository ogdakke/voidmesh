import {
  getGifExportDimensions,
  getGifFrameDelayCentiseconds,
  getVideoExportBitrate,
  getVideoExportDimensions,
} from "#renderer/export-worker-utils.ts";
import { describe, expect, test } from "vitest";

describe("export worker utils", () => {
  test("scales GIF dimensions to max width and keeps them even", () => {
    expect(getGifExportDimensions(1920, 1080, 250)).toEqual({ width: 250, height: 140 });
    expect(getGifExportDimensions(101, 57, 101)).toEqual({ width: 100, height: 56 });
  });

  test("does not upscale GIF dimensions", () => {
    expect(getGifExportDimensions(180, 101, 250)).toEqual({ width: 180, height: 100 });
  });

  test("accumulates GIF frame delay error for fractional frame rates", () => {
    let error = 0;
    const delays: number[] = [];

    for (let i = 0; i < 6; i++) {
      const next = getGifFrameDelayCentiseconds(30, error);
      delays.push(next.delayCentiseconds);
      error = next.nextAccumulatedError;
    }

    expect(delays).toEqual([3, 4, 3, 3, 4, 3]);
  });

  test("uses existing video resolution presets", () => {
    expect(getVideoExportDimensions(3840, 2160, { advanced: { resolution: "1080p" } })).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  test("honors explicit video bitrate override", () => {
    expect(getVideoExportBitrate(1920, 1080, { advanced: { bitrate: 123_456 } })).toBe(123_456);
  });
});
