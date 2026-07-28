import { bench, describe } from "vitest";
import { CanvasStore } from "#engine";
import { EntitySpatialIndex } from "#lib/entity-spatial-index.ts";
import { ByteBudgetCache } from "#renderer/byte-budget-cache.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { createTestEntity } from "../__tests__/helpers/test-entity.ts";

const LARGE_ENTITY_COUNT = 131_072;
const EVICTION_ENTRY_COUNT = 16_384;
const EVICTION_BUDGET = EVICTION_ENTRY_COUNT / 2;

function createLargeEntitySet(): ShaderCanvasEntity[] {
  const base = createTestEntity({
    id: "hot-path-0",
    size: { width: 6, height: 6 },
    zIndex: 0,
  });
  const entities = new Array<ShaderCanvasEntity>(LARGE_ENTITY_COUNT);
  entities[0] = base;
  for (let index = 1; index < LARGE_ENTITY_COUNT; index++) {
    entities[index] = {
      ...base,
      id: `hot-path-${index}`,
      position: { x: (index % 512) * 8, y: Math.floor(index / 512) * 8 },
      zIndex: index,
    };
  }
  return entities;
}

describe("131k engine hot paths", () => {
  const entities = createLargeEntitySet();
  const orderedEntities = [...entities];
  const spatialIndex = new EntitySpatialIndex();
  for (const entity of entities) spatialIndex.upsert(entity);
  const queryOutput: ShaderCanvasEntity[] = [];
  const fullBounds = { x: -16, y: -16, width: 4_160, height: 2_112 };
  let translatedEntity = entities[Math.floor(entities.length / 2) + 256]!;
  let direction = 1;

  bench(
    "translate one interior entity then query full bounds",
    () => {
      const delta = { x: direction, y: 0 };
      translatedEntity.position.x += delta.x;
      spatialIndex.translateEntities([translatedEntity.id], delta);
      spatialIndex.queryBounds(fullBounds, queryOutput, orderedEntities);
      direction *= -1;
    },
    { time: 0, iterations: 8, warmupTime: 0, warmupIterations: 2 },
  );

  const store = new CanvasStore();
  store.addEntities(entities);
  let zIndex = entities.length + 1;

  bench(
    "update one entity z-index",
    () => {
      store.updateEntity(translatedEntity.id, { zIndex: zIndex++ });
      store.getRenderState();
      store.clearDirtyFlags();
    },
    { time: 0, iterations: 8, warmupTime: 0, warmupIterations: 2 },
  );

  bench(
    "clean render-change check",
    () => {
      for (let index = 0; index < 100_000; index++) store.hasRenderChanges();
    },
    { time: 0, iterations: 8, warmupTime: 0, warmupIterations: 2 },
  );
});

describe("renderer cache pressure", () => {
  const caches: ByteBudgetCache[] = [];
  for (let iteration = 0; iteration < 32; iteration++) {
    const cache = new ByteBudgetCache(EVICTION_BUDGET);
    for (let index = 0; index < EVICTION_ENTRY_COUNT; index++) {
      cache.register(`entry-${iteration}-${index}`, 1, () => {});
    }
    cache.endFrame();
    for (let index = EVICTION_ENTRY_COUNT / 4; index < EVICTION_ENTRY_COUNT; index++) {
      cache.markUsed(`entry-${iteration}-${index}`);
    }
    caches.push(cache);
  }
  let cacheIndex = 0;

  bench(
    "evict an over-budget 16k-entry cache",
    () => {
      const cache = caches[cacheIndex]!;
      cacheIndex += 1;
      cache.endFrame();
    },
    { time: 0, iterations: 8, warmupTime: 0, warmupIterations: 2 },
  );
});
