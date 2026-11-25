import { describe, expect, it } from "vitest";
import {
  isEmptyRect,
  subtractCoveringRect,
  toOutputRegion,
  type WorldRect,
} from "#renderer/processing-visibility.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): WorldRect => ({ x0, y0, x1, y1 });
const region = () => ({ x: -1, y: -1, width: -1, height: -1 });

describe("subtractCoveringRect", () => {
  it("trims a side the cover spans completely", () => {
    const right = rect(0, 0, 100, 100);
    subtractCoveringRect(right, rect(80, -5, 200, 105));
    expect(right).toEqual(rect(0, 0, 80, 100));

    const left = rect(0, 0, 100, 100);
    subtractCoveringRect(left, rect(-10, 0, 30, 100));
    expect(left).toEqual(rect(30, 0, 100, 100));

    const bottom = rect(0, 0, 100, 100);
    subtractCoveringRect(bottom, rect(0, 60, 100, 300));
    expect(bottom).toEqual(rect(0, 0, 100, 60));

    const top = rect(0, 0, 100, 100);
    subtractCoveringRect(top, rect(-1, -1, 101, 25));
    expect(top).toEqual(rect(0, 25, 100, 100));
  });

  it("empties a rectangle the cover hides completely", () => {
    const visible = rect(10, 10, 20, 20);
    subtractCoveringRect(visible, rect(0, 0, 30, 30));
    expect(isEmptyRect(visible)).toBe(true);
  });

  it("keeps everything when the cover would leave more than one rectangle", () => {
    for (const cover of [
      rect(40, 40, 60, 60), // middle
      rect(50, 50, 200, 200), // corner
      rect(40, -10, 60, 110), // strip through the middle
      rect(80, 10, 200, 105), // side, but not its whole length
      rect(100, 0, 200, 100), // touching, no overlap
    ]) {
      const visible = rect(0, 0, 100, 100);
      subtractCoveringRect(visible, cover);
      expect(visible).toEqual(rect(0, 0, 100, 100));
    }
  });

  it("applies covers one after another", () => {
    const visible = rect(0, 0, 100, 100);
    subtractCoveringRect(visible, rect(90, 0, 150, 100));
    subtractCoveringRect(visible, rect(0, 50, 90, 150));
    expect(visible).toEqual(rect(0, 0, 90, 50));
  });
});

describe("toOutputRegion", () => {
  it("maps the shown world rectangle to texels with margin and padding", () => {
    // Entity 200x100 world at (1000, 500), texture 400x200: two texels per world unit.
    const output = toOutputRegion(
      rect(1050, 520, 1100, 560),
      1000,
      500,
      200,
      100,
      400,
      200,
      1,
      2,
      region(),
    );
    expect(output).toEqual({ x: 96, y: 36, width: 108, height: 88 });
  });

  it("clamps to the texture", () => {
    const output = toOutputRegion(
      rect(1000, 500, 1200, 600),
      1000,
      500,
      200,
      100,
      400,
      200,
      4,
      2,
      region(),
    );
    expect(output).toEqual({ x: 0, y: 0, width: 400, height: 200 });
  });

  it("covers every texel a shown pixel can sample at fractional scales", () => {
    const output = toOutputRegion(rect(10.3, 0, 20.7, 33), 0, 0, 33, 33, 64, 64, 0, 0, region());
    expect(output.x).toBeLessThanOrEqual(Math.floor((10.3 * 64) / 33));
    expect(output.x + output.width).toBeGreaterThanOrEqual(Math.ceil((20.7 * 64) / 33));
    expect(output.y).toBe(0);
    expect(output.height).toBe(64);
  });

  it("is zero-sized when nothing shows", () => {
    const empty = { x: 0, y: 0, width: 0, height: 0 };
    expect(toOutputRegion(rect(5, 5, 5, 9), 0, 0, 10, 10, 64, 64, 1, 2, region())).toEqual(empty);
    expect(toOutputRegion(rect(0, 0, 10, 10), 0, 0, 0, 10, 64, 64, 1, 2, region())).toEqual(empty);
  });
});
