import { describe, expect, test } from "vitest";
import {
  ZOOM_STRESS_SCENARIO,
  estimateZoomStressDecodedBytes,
  getZoomStressDisplaySize,
  getZoomStressFrame,
  getZoomStressFrameCount,
  getZoomStressMediaKind,
  getZoomStressPosition,
  getZoomStressTargetCenter,
} from "./zoom-stress-scenario.ts";

const canvasSize = { width: 1280, height: 720 };

describe("mixed-media zoom stress scenario", () => {
  test("contains 61 unique sources with the requested image/video mix", () => {
    const kinds = Array.from({ length: ZOOM_STRESS_SCENARIO.entityCount }, (_, index) =>
      getZoomStressMediaKind(ZOOM_STRESS_SCENARIO, index),
    );

    expect(kinds).toHaveLength(61);
    expect(kinds.filter((kind) => kind === "image")).toHaveLength(ZOOM_STRESS_SCENARIO.imageCount);
    expect(kinds.filter((kind) => kind === "video")).toHaveLength(ZOOM_STRESS_SCENARIO.videoCount);
    expect(ZOOM_STRESS_SCENARIO.targetIndex % 4).not.toBe(0);
  });

  test("zooms out to the full grid before returning to the target", () => {
    const frameCount = getZoomStressFrameCount(ZOOM_STRESS_SCENARIO);
    const frames = Array.from({ length: frameCount }, (_, index) =>
      getZoomStressFrame(ZOOM_STRESS_SCENARIO, index, canvasSize),
    );

    expect(frames[0]).toMatchObject({
      phase: "detail-hold",
      zoom: ZOOM_STRESS_SCENARIO.detailZoom,
    });
    expect(frames.some((frame) => frame.phase === "zoom-out")).toBe(true);
    expect(frames.some((frame) => frame.phase === "overview-hold")).toBe(true);
    expect(frames.some((frame) => frame.phase === "zoom-in")).toBe(true);
    expect(frames.at(-1)).toMatchObject({
      phase: "target-hold",
      zoom: ZOOM_STRESS_SCENARIO.detailZoom,
    });
    expect(Math.min(...frames.map((frame) => frame.zoom))).toBeCloseTo(
      ZOOM_STRESS_SCENARIO.overviewZoom,
    );
  });

  test("keeps the target anchored at canvas center throughout the gesture", () => {
    const target = getZoomStressTargetCenter(ZOOM_STRESS_SCENARIO);
    for (let index = 0; index < getZoomStressFrameCount(ZOOM_STRESS_SCENARIO); index += 1) {
      const { viewport } = getZoomStressFrame(ZOOM_STRESS_SCENARIO, index, canvasSize);
      expect((target.x - viewport.offset.x) * viewport.zoom).toBeCloseTo(canvasSize.width / 2);
      expect((target.y - viewport.offset.y) * viewport.zoom).toBeCloseTo(canvasSize.height / 2);
    }
  });

  test("fits every entity in the overview viewport", () => {
    const overviewFrameIndex =
      ZOOM_STRESS_SCENARIO.detailHoldFrames + ZOOM_STRESS_SCENARIO.zoomOutFrames;
    const { viewport } = getZoomStressFrame(ZOOM_STRESS_SCENARIO, overviewFrameIndex, canvasSize);

    for (let index = 0; index < ZOOM_STRESS_SCENARIO.entityCount; index += 1) {
      const position = getZoomStressPosition(ZOOM_STRESS_SCENARIO, index);
      const size = getZoomStressDisplaySize(ZOOM_STRESS_SCENARIO, index);
      const left = (position.x - viewport.offset.x) * viewport.zoom;
      const top = (position.y - viewport.offset.y) * viewport.zoom;
      const right = (position.x + size.width - viewport.offset.x) * viewport.zoom;
      const bottom = (position.y + size.height - viewport.offset.y) * viewport.zoom;

      expect(left).toBeGreaterThanOrEqual(0);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(canvasSize.width);
      expect(bottom).toBeLessThanOrEqual(canvasSize.height);
    }
  });

  test("reports one decoded RGBA frame per unique media source", () => {
    expect(estimateZoomStressDecodedBytes(ZOOM_STRESS_SCENARIO)).toBe(
      45 * 2048 * 1365 * 4 + 16 * 1280 * 720 * 4,
    );
  });
});
