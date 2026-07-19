import { describe, expect, it } from "vitest";
import { rubberBandZoom } from "#lib/canvas-math.ts";

describe("rubberBandZoom", () => {
  it("keeps extreme gesture overshoot within a twofold stretch of the zoom limits", () => {
    expect(rubberBandZoom(Number.MIN_VALUE, 0.01, 10)).toBeGreaterThanOrEqual(0.005);
    expect(rubberBandZoom(Number.MAX_VALUE, 0.01, 10)).toBeLessThanOrEqual(20);
  });
});
