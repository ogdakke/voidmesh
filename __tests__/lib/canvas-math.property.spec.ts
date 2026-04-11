/**
 * Property-based tests for canvas-math utilities.
 *
 * Tests mathematical invariants of coordinate transforms, bounds operations,
 * interpolation functions, and easing curves using fast-check.
 */
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  screenToWorld,
  worldToScreen,
  zoomToPoint,
  clampZoom,
  rubberBandZoom,
  pointInBounds,
  boundsIntersect,
  createBounds,
  getRotatedAABB,
  lerp,
  lerpExp,
  lerpPoint,
  lerpViewport,
  snapToGrid,
  calculateGridLevel,
  calculateCenteredOffset,
  calculateOffsetForWorldPoint,
  easings,
} from "#lib/canvas-math.ts";
import type { Point, Viewport, Bounds } from "#types/canvas.ts";

// ── Arbitraries ─────────────────────────────────────────────────────

/** Reasonable float range to avoid precision issues at extremes */
const coordinate = () => fc.double({ min: -10_000, max: 10_000, noNaN: true });

const point = (): fc.Arbitrary<Point> => fc.record({ x: coordinate(), y: coordinate() });

const positiveFloat = () => fc.double({ min: 0.001, max: 10_000, noNaN: true });

const zoom = () => fc.double({ min: 0.001, max: 100, noNaN: true });

const viewport = (): fc.Arbitrary<Viewport> =>
  fc.record({
    offset: point(),
    zoom: zoom(),
  });

const containerRect = (): fc.Arbitrary<DOMRect> =>
  fc
    .record({
      left: coordinate(),
      top: coordinate(),
      width: positiveFloat(),
      height: positiveFloat(),
    })
    .map(({ left, top, width, height }) => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }));

const dpr = () => fc.double({ min: 0.5, max: 4, noNaN: true });

const bounds = (): fc.Arbitrary<Bounds> =>
  fc.record({
    x: coordinate(),
    y: coordinate(),
    width: positiveFloat(),
    height: positiveFloat(),
  });

const unitInterval = () => fc.double({ min: 0, max: 1, noNaN: true });

// ── Coordinate Transform Properties ────────────────────────────────

describe("coordinate transforms", () => {
  test("screenToWorld → worldToScreen is identity (round-trip)", () => {
    fc.assert(
      fc.property(point(), viewport(), containerRect(), dpr(), (screenPt, vp, rect, d) => {
        const world = screenToWorld(screenPt, vp, rect, d);
        const backToScreen = worldToScreen(world, vp, rect, d);
        expect(backToScreen.x).toBeCloseTo(screenPt.x, 6);
        expect(backToScreen.y).toBeCloseTo(screenPt.y, 6);
      }),
    );
  });

  test("worldToScreen → screenToWorld is identity (round-trip)", () => {
    fc.assert(
      fc.property(point(), viewport(), containerRect(), dpr(), (worldPt, vp, rect, d) => {
        const screen = worldToScreen(worldPt, vp, rect, d);
        const backToWorld = screenToWorld(screen, vp, rect, d);
        expect(backToWorld.x).toBeCloseTo(worldPt.x, 6);
        expect(backToWorld.y).toBeCloseTo(worldPt.y, 6);
      }),
    );
  });
});

// ── zoomToPoint Properties ──────────────────────────────────────────

describe("zoomToPoint", () => {
  test("world point under cursor is preserved after zoom", () => {
    fc.assert(
      fc.property(viewport(), point(), zoom(), (vp, cursorPos, newZoom) => {
        // World point under cursor before zoom
        const worldBefore = {
          x: cursorPos.x / vp.zoom + vp.offset.x,
          y: cursorPos.y / vp.zoom + vp.offset.y,
        };

        const newVp = zoomToPoint(vp, cursorPos, newZoom);

        // World point under cursor after zoom
        const worldAfter = {
          x: cursorPos.x / newVp.zoom + newVp.offset.x,
          y: cursorPos.y / newVp.zoom + newVp.offset.y,
        };

        expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
        expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
      }),
    );
  });

  test("zoom level is set to the requested value", () => {
    fc.assert(
      fc.property(viewport(), point(), zoom(), (vp, cursor, z) => {
        expect(zoomToPoint(vp, cursor, z).zoom).toBe(z);
      }),
    );
  });
});

// ── clampZoom Properties ────────────────────────────────────────────

describe("clampZoom", () => {
  test("result is always within [min, max]", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -100, max: 200, noNaN: true }),
        positiveFloat(),
        positiveFloat(),
        (z, a, b) => {
          const min = Math.min(a, b);
          const max = Math.max(a, b) || min + 0.01;
          const result = clampZoom(z, min, max);
          expect(result).toBeGreaterThanOrEqual(min);
          expect(result).toBeLessThanOrEqual(max);
        },
      ),
    );
  });

  test("values within range are unchanged", () => {
    fc.assert(
      fc.property(positiveFloat(), positiveFloat(), (a, b) => {
        const min = Math.min(a, b);
        const max = Math.max(a, b) || min + 0.01;
        const mid = (min + max) / 2;
        expect(clampZoom(mid, min, max)).toBe(mid);
      }),
    );
  });
});

// ── rubberBandZoom Properties ───────────────────────────────────────

describe("rubberBandZoom", () => {
  test("within-bounds zoom is unchanged", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 10, noNaN: true }), (z) => {
        // Default bounds: 0.01 to 10
        const result = rubberBandZoom(z, 0.01, 10);
        expect(result).toBeCloseTo(z, 10);
      }),
    );
  });

  test("result is always positive", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.0001, max: 1000, noNaN: true }), (z) => {
        expect(rubberBandZoom(z, 0.01, 10)).toBeGreaterThan(0);
      }),
    );
  });

  test("overshoot beyond max is damped below raw value", () => {
    fc.assert(
      fc.property(fc.double({ min: 10.01, max: 200, noNaN: true }), (z) => {
        const result = rubberBandZoom(z, 0.01, 10);
        expect(result).toBeLessThan(z);
        expect(result).toBeGreaterThanOrEqual(10);
      }),
    );
  });

  test("undershoot below min is damped above raw value", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.0001, max: 0.0099, noNaN: true }), (z) => {
        const result = rubberBandZoom(z, 0.01, 10);
        expect(result).toBeGreaterThan(z);
        expect(result).toBeLessThanOrEqual(0.01);
      }),
    );
  });
});

// ── Bounds Properties ───────────────────────────────────────────────

describe("bounds operations", () => {
  test("boundsIntersect is commutative", () => {
    fc.assert(
      fc.property(bounds(), bounds(), (a, b) => {
        expect(boundsIntersect(a, b)).toBe(boundsIntersect(b, a));
      }),
    );
  });

  test("bounds always intersects itself", () => {
    fc.assert(
      fc.property(bounds(), (b) => {
        expect(boundsIntersect(b, b)).toBe(true);
      }),
    );
  });

  test("point at center is always inside bounds", () => {
    fc.assert(
      fc.property(bounds(), (b) => {
        const center: Point = {
          x: b.x + b.width / 2,
          y: b.y + b.height / 2,
        };
        expect(pointInBounds(center, b)).toBe(true);
      }),
    );
  });

  test("createBounds preserves position and size", () => {
    fc.assert(
      fc.property(point(), positiveFloat(), positiveFloat(), (pos, w, h) => {
        const b = createBounds(pos, { width: w, height: h });
        expect(b.x).toBe(pos.x);
        expect(b.y).toBe(pos.y);
        expect(b.width).toBe(w);
        expect(b.height).toBe(h);
      }),
    );
  });

  test("point inside createBounds is detected by pointInBounds", () => {
    fc.assert(
      fc.property(
        point(),
        positiveFloat(),
        positiveFloat(),
        unitInterval(),
        unitInterval(),
        (pos, w, h, fx, fy) => {
          const b = createBounds(pos, { width: w, height: h });
          const interior: Point = {
            x: pos.x + w * fx,
            y: pos.y + h * fy,
          };
          expect(pointInBounds(interior, b)).toBe(true);
        },
      ),
    );
  });
});

// ── getRotatedAABB Properties ───────────────────────────────────────

describe("getRotatedAABB", () => {
  test("at 0° rotation equals createBounds", () => {
    fc.assert(
      fc.property(point(), positiveFloat(), positiveFloat(), (pos, w, h) => {
        const size = { width: w, height: h };
        const aabb = getRotatedAABB(pos, size, 0);
        const plain = createBounds(pos, size);
        expect(aabb.x).toBeCloseTo(plain.x, 10);
        expect(aabb.y).toBeCloseTo(plain.y, 10);
        expect(aabb.width).toBeCloseTo(plain.width, 10);
        expect(aabb.height).toBeCloseTo(plain.height, 10);
      }),
    );
  });

  test("AABB always contains the original center", () => {
    fc.assert(
      fc.property(
        point(),
        positiveFloat(),
        positiveFloat(),
        fc.double({ min: 0, max: 360, noNaN: true }),
        (pos, w, h, rotation) => {
          const center = { x: pos.x + w / 2, y: pos.y + h / 2 };
          const aabb = getRotatedAABB(pos, { width: w, height: h }, rotation);
          expect(pointInBounds(center, aabb)).toBe(true);
        },
      ),
    );
  });

  test("AABB dimensions are at least as large as original (for non-axis-aligned rotations)", () => {
    fc.assert(
      fc.property(
        point(),
        positiveFloat(),
        positiveFloat(),
        fc.double({ min: 0, max: 360, noNaN: true }),
        (pos, w, h, rotation) => {
          const aabb = getRotatedAABB(pos, { width: w, height: h }, rotation);
          // AABB area is always >= original area (equality at 0°, 90°, 180°, 270°)
          expect(aabb.width * aabb.height).toBeGreaterThanOrEqual(w * h - 1e-6);
        },
      ),
    );
  });

  test("90° rotation swaps width and height", () => {
    fc.assert(
      fc.property(point(), positiveFloat(), positiveFloat(), (pos, w, h) => {
        const aabb = getRotatedAABB(pos, { width: w, height: h }, 90);
        expect(aabb.width).toBeCloseTo(h, 6);
        expect(aabb.height).toBeCloseTo(w, 6);
      }),
    );
  });
});

// ── Lerp Properties ─────────────────────────────────────────────────

describe("lerp", () => {
  test("lerp(a, b, 0) = a", () => {
    fc.assert(
      fc.property(coordinate(), coordinate(), (a, b) => {
        expect(lerp(a, b, 0)).toBeCloseTo(a, 10);
      }),
    );
  });

  test("lerp(a, b, 1) = b", () => {
    fc.assert(
      fc.property(coordinate(), coordinate(), (a, b) => {
        expect(lerp(a, b, 1)).toBeCloseTo(b, 10);
      }),
    );
  });

  test("lerp(a, a, t) = a for any t", () => {
    fc.assert(
      fc.property(coordinate(), unitInterval(), (a, t) => {
        expect(lerp(a, a, t)).toBeCloseTo(a, 10);
      }),
    );
  });

  test("lerp result is between start and end for t in [0, 1]", () => {
    fc.assert(
      fc.property(coordinate(), coordinate(), unitInterval(), (a, b, t) => {
        const result = lerp(a, b, t);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        expect(result).toBeGreaterThanOrEqual(lo - 1e-10);
        expect(result).toBeLessThanOrEqual(hi + 1e-10);
      }),
    );
  });

  test("lerp is monotone in t (when a < b)", () => {
    fc.assert(
      fc.property(coordinate(), coordinate(), unitInterval(), unitInterval(), (a, b, t1, t2) => {
        if (a >= b) return; // skip when a >= b
        const lo = Math.min(t1, t2);
        const hi = Math.max(t1, t2);
        expect(lerp(a, b, hi)).toBeGreaterThanOrEqual(lerp(a, b, lo) - 1e-10);
      }),
    );
  });
});

describe("lerpExp", () => {
  test("lerpExp(a, b, 0) = a", () => {
    fc.assert(
      fc.property(positiveFloat(), positiveFloat(), (a, b) => {
        expect(lerpExp(a, b, 0)).toBeCloseTo(a, 6);
      }),
    );
  });

  test("lerpExp(a, b, 1) = b", () => {
    fc.assert(
      fc.property(positiveFloat(), positiveFloat(), (a, b) => {
        expect(lerpExp(a, b, 1)).toBeCloseTo(b, 6);
      }),
    );
  });

  test("lerpExp result is between start and end for t in [0, 1]", () => {
    fc.assert(
      fc.property(positiveFloat(), positiveFloat(), unitInterval(), (a, b, t) => {
        const result = lerpExp(a, b, t);
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        expect(result).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(result).toBeLessThanOrEqual(hi + 1e-6);
      }),
    );
  });
});

describe("lerpPoint", () => {
  test("lerpPoint(p, p, t) = p", () => {
    fc.assert(
      fc.property(point(), unitInterval(), (p, t) => {
        const result = lerpPoint(p, p, t);
        expect(result.x).toBeCloseTo(p.x, 10);
        expect(result.y).toBeCloseTo(p.y, 10);
      }),
    );
  });

  test("lerpPoint(a, b, 0) = a", () => {
    fc.assert(
      fc.property(point(), point(), (a, b) => {
        const result = lerpPoint(a, b, 0);
        expect(result.x).toBeCloseTo(a.x, 10);
        expect(result.y).toBeCloseTo(a.y, 10);
      }),
    );
  });

  test("lerpPoint(a, b, 1) = b", () => {
    fc.assert(
      fc.property(point(), point(), (a, b) => {
        const result = lerpPoint(a, b, 1);
        expect(result.x).toBeCloseTo(b.x, 10);
        expect(result.y).toBeCloseTo(b.y, 10);
      }),
    );
  });
});

describe("lerpViewport", () => {
  test("lerpViewport(vp, vp, t) = vp", () => {
    fc.assert(
      fc.property(viewport(), unitInterval(), (vp, t) => {
        const result = lerpViewport(vp, vp, t);
        expect(result.offset.x).toBeCloseTo(vp.offset.x, 10);
        expect(result.offset.y).toBeCloseTo(vp.offset.y, 10);
        expect(result.zoom).toBeCloseTo(vp.zoom, 10);
      }),
    );
  });
});

// ── snapToGrid Properties ───────────────────────────────────────────

describe("snapToGrid", () => {
  test("snapped position is a multiple of grid size", () => {
    fc.assert(
      fc.property(point(), positiveFloat(), (pos, gridSize) => {
        const snapped = snapToGrid(pos, gridSize);
        // snapped.x / gridSize should be close to an integer
        const xRatio = snapped.x / gridSize;
        const yRatio = snapped.y / gridSize;
        expect(Math.abs(xRatio - Math.round(xRatio))).toBeLessThan(1e-6);
        expect(Math.abs(yRatio - Math.round(yRatio))).toBeLessThan(1e-6);
      }),
    );
  });

  test("snapped position is within half grid size of original", () => {
    fc.assert(
      fc.property(point(), positiveFloat(), (pos, gridSize) => {
        const snapped = snapToGrid(pos, gridSize);
        expect(Math.abs(snapped.x - pos.x)).toBeLessThanOrEqual(gridSize / 2 + 1e-6);
        expect(Math.abs(snapped.y - pos.y)).toBeLessThanOrEqual(gridSize / 2 + 1e-6);
      }),
    );
  });

  test("snapping an already-snapped point is idempotent", () => {
    fc.assert(
      fc.property(point(), positiveFloat(), (pos, gridSize) => {
        const snapped = snapToGrid(pos, gridSize);
        const snappedAgain = snapToGrid(snapped, gridSize);
        expect(snappedAgain.x).toBeCloseTo(snapped.x, 10);
        expect(snappedAgain.y).toBeCloseTo(snapped.y, 10);
      }),
    );
  });
});

// ── calculateGridLevel Properties ───────────────────────────────────

describe("calculateGridLevel", () => {
  test("fade factor is in [0, 1]", () => {
    fc.assert(
      fc.property(positiveFloat(), zoom(), (baseSize, z) => {
        const { fadeFactor } = calculateGridLevel(baseSize, z);
        expect(fadeFactor).toBeGreaterThanOrEqual(0);
        expect(fadeFactor).toBeLessThanOrEqual(1 + 1e-10);
      }),
    );
  });

  test("fine grid size is always positive", () => {
    fc.assert(
      fc.property(positiveFloat(), zoom(), (baseSize, z) => {
        const { fineGridSize } = calculateGridLevel(baseSize, z);
        expect(fineGridSize).toBeGreaterThan(0);
      }),
    );
  });
});

// ── Easing Properties ───────────────────────────────────────────────

describe("easing functions", () => {
  const easingEntries = Object.entries(easings) as [string, (t: number) => number][];

  for (const [name, fn] of easingEntries) {
    describe(name, () => {
      test("f(0) = 0", () => {
        expect(fn(0)).toBeCloseTo(0, 10);
      });

      test("f(1) = 1", () => {
        expect(fn(1)).toBeCloseTo(1, 10);
      });

      test("output is in [0, 1] for input in [0, 1]", () => {
        fc.assert(
          fc.property(unitInterval(), (t) => {
            const result = fn(t);
            expect(result).toBeGreaterThanOrEqual(-1e-10);
            expect(result).toBeLessThanOrEqual(1 + 1e-10);
          }),
        );
      });
    });
  }
});

// ── calculateCenteredOffset / calculateOffsetForWorldPoint ──────────

describe("calculateCenteredOffset", () => {
  test("offset centers the origin: screenToWorld of screen center = (0,0)", () => {
    fc.assert(
      fc.property(positiveFloat(), positiveFloat(), zoom(), dpr(), (cw, ch, z, d) => {
        const offset = calculateCenteredOffset(cw, ch, z, d);
        const vp: Viewport = { offset, zoom: z };
        const rect = {
          left: 0,
          top: 0,
          width: cw,
          height: ch,
          right: cw,
          bottom: ch,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;

        const screenCenter: Point = { x: cw / 2, y: ch / 2 };
        const world = screenToWorld(screenCenter, vp, rect, d);
        expect(world.x).toBeCloseTo(0, 4);
        expect(world.y).toBeCloseTo(0, 4);
      }),
    );
  });
});

describe("calculateOffsetForWorldPoint", () => {
  test("centers the given world point at screen center", () => {
    fc.assert(
      fc.property(
        point(),
        positiveFloat(),
        positiveFloat(),
        zoom(),
        dpr(),
        (worldPt, cw, ch, z, d) => {
          const offset = calculateOffsetForWorldPoint(worldPt, cw, ch, z, d);
          const vp: Viewport = { offset, zoom: z };
          const rect = {
            left: 0,
            top: 0,
            width: cw,
            height: ch,
            right: cw,
            bottom: ch,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;

          const screenCenter: Point = { x: cw / 2, y: ch / 2 };
          const world = screenToWorld(screenCenter, vp, rect, d);
          expect(world.x).toBeCloseTo(worldPt.x, 4);
          expect(world.y).toBeCloseTo(worldPt.y, 4);
        },
      ),
    );
  });
});
