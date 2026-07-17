import { describe, expect, test } from "vitest";

import { parseOptions } from "../../scripts/render-bench-ab.ts";

describe("render benchmark A/B options", () => {
  test("requires a bounded scenario and accepts comparison controls", () => {
    expect(() => parseOptions([])).toThrow("--scenario is required");
    expect(
      parseOptions([
        "--scenario",
        "zoom-61-unique-mixed-round-trip",
        "--base",
        "HEAD~1",
        "--rounds",
        "2",
        "--metric",
        "cpuRenderP95Ms",
      ]),
    ).toMatchObject({
      scenario: "zoom-61-unique-mixed-round-trip",
      base: "HEAD~1",
      rounds: 2,
      metric: "cpuRenderP95Ms",
    });
  });
});
