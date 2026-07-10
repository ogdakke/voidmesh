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

    expect(index.queryBounds({ x: -1, y: -1, width: 10, height: 10 }, [], ordered)).toEqual(
      ordered,
    );

    back.position = { x: 100, y: 100 };
    index.upsert(back);
    expect(index.queryBounds({ x: -1, y: -1, width: 10, height: 10 }, [], ordered)).toEqual([
      front,
    ]);
  });
});
