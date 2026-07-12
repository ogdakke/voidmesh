import { describe, expect, test } from "vitest";
import { EntitySpatialIndex } from "#lib/entity-spatial-index.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("EntitySpatialIndex", () => {
  test("returns intersecting entities in z order without multi-cell duplicates", () => {
    const index = new EntitySpatialIndex(10);
    const back = createTestEntity({
      id: "back",
      position: { x: 0, y: 0 },
      size: { width: 25, height: 25 },
      zIndex: 1,
    });
    const front = createTestEntity({
      id: "front",
      position: { x: 5, y: 5 },
      size: { width: 10, height: 10 },
      zIndex: 2,
    });
    index.upsert(front);
    index.upsert(back);

    const result = index.queryBounds({ x: 4, y: 4, width: 12, height: 12 }, []);

    expect(result.map((entity) => entity.id)).toEqual(["back", "front"]);
  });

  test("can skip z-order work for membership-only queries", () => {
    const index = new EntitySpatialIndex(10);
    const front = createTestEntity({ id: "front", zIndex: 2 });
    const back = createTestEntity({ id: "back", zIndex: 1 });
    index.upsert(front);
    index.upsert(back);

    const result = index.queryBounds(
      { x: -1, y: -1, width: 202, height: 152 },
      [],
      undefined,
      false,
    );

    expect(result.map((entity) => entity.id)).toEqual(["front", "back"]);
  });

  test("updates moved and rotated entity bounds", () => {
    const index = new EntitySpatialIndex(10);
    const entity = createTestEntity({
      id: "moving",
      position: { x: 0, y: 0 },
      size: { width: 20, height: 4 },
      rotation: 0,
    });
    index.upsert(entity);
    entity.position = { x: 100, y: 100 };
    entity.rotation = 90;
    index.upsert(entity);

    expect(index.queryBounds({ x: 0, y: 0, width: 20, height: 20 }, [])).toEqual([]);
    expect(index.queryBounds({ x: 105, y: 90, width: 10, height: 25 }, [])).toEqual([entity]);
  });

  test("removes entities and includes very large entities without indexing every cell", () => {
    const index = new EntitySpatialIndex(1);
    const large = createTestEntity({
      id: "large",
      position: { x: -100, y: -100 },
      size: { width: 500, height: 500 },
    });
    index.upsert(large);

    expect(index.queryBounds({ x: 200, y: 200, width: 1, height: 1 }, [])).toEqual([large]);
    index.remove(large.id);
    expect(index.queryBounds({ x: 200, y: 200, width: 1, height: 1 }, [])).toEqual([]);
  });

  test("returns the existing ordered array when the query covers the entire index", () => {
    const index = new EntitySpatialIndex(10);
    const front = createTestEntity({
      id: "all-front",
      position: { x: 5, y: 5 },
      size: { width: 2, height: 2 },
      zIndex: 2,
    });
    const back = createTestEntity({
      id: "all-back",
      position: { x: 0, y: 0 },
      size: { width: 2, height: 2 },
      zIndex: 1,
    });
    index.upsert(front);
    index.upsert(back);
    const ordered = [back, front];

    expect(index.queryBounds({ x: -1, y: -1, width: 10, height: 10 }, [], ordered)).toBe(ordered);

    back.position = { x: 100, y: 100 };
    index.upsert(back);
    expect(index.queryBounds({ x: -1, y: -1, width: 10, height: 10 }, [], ordered)).toEqual([
      front,
    ]);
  });

  test("collects visible occupied buckets and entity centers across index levels", () => {
    const index = new EntitySpatialIndex(16);
    const smallA = createTestEntity({
      id: "small-a",
      position: { x: -15, y: -15 },
      size: { width: 4, height: 4 },
    });
    const smallB = createTestEntity({
      id: "small-b",
      position: { x: -12, y: -12 },
      size: { width: 4, height: 4 },
    });
    const large = createTestEntity({
      id: "large-debug",
      position: { x: 32, y: 0 },
      size: { width: 30, height: 10 },
    });
    index.upsert(smallA);
    index.upsert(smallB);
    index.upsert(large);

    const buckets: Parameters<EntitySpatialIndex["collectDebugGeometry"]>[1] = [];
    const centers: Parameters<EntitySpatialIndex["collectDebugGeometry"]>[2] = [];
    index.collectDebugGeometry({ x: -20, y: -20, width: 80, height: 40 }, buckets, centers);

    expect(buckets).toEqual([
      { cellSize: 16, cellX: -1, cellY: -1 },
      { cellSize: 32, cellX: 1, cellY: 0 },
    ]);
    expect(centers).toEqual([
      { x: -13, y: -13, cellSize: 16 },
      { x: -10, y: -10, cellSize: 16 },
      { x: 47, y: 5, cellSize: 32 },
    ]);

    smallA.position = { x: 200, y: 200 };
    index.upsert(smallA);
    index.remove(smallB.id);
    index.collectDebugGeometry({ x: -20, y: -20, width: 80, height: 40 }, buckets, centers);
    expect(buckets).toEqual([{ cellSize: 32, cellX: 1, cellY: 0 }]);
    expect(centers).toEqual([{ x: 47, y: 5, cellSize: 32 }]);
  });
});
