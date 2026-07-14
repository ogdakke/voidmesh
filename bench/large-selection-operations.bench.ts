import { bench, describe } from "vitest";
import { CanvasStore } from "#engine";
import type { ParamPaths, ShaderCanvasEntity } from "#types/canvas.ts";
import { createTestEntity } from "../__tests__/helpers/test-entity.ts";

const ENTITY_COUNT = 262_144;
const SELECTED_COUNT = ENTITY_COUNT / 2;
const MOUNTED_DITHERING_PARAM_PATHS = [
  "size",
  "intensity",
  "scale",
  "time",
  "blobs.eagerness",
  "glass.angle",
  "glitch.angle",
  "glass.caustic",
  "glass.frostiness",
  "glass.highlight",
  "glass.dispersion",
  "glass.flow",
  "adjustments.brightness",
  "adjustments.contrast",
  "adjustments.saturation",
  "adjustments.blur",
  "postProcess.grain.enabled",
  "postProcess.grain.size",
  "postProcess.grain.intensity",
  "postProcess.bloom.enabled",
  "postProcess.bloom.threshold",
  "postProcess.bloom.intensity",
  "postProcess.bloom.filterRadius",
  "postProcess.bloom.softness",
  "postProcess.chromaticAberration.enabled",
  "postProcess.chromaticAberration.offset",
] as const satisfies readonly ParamPaths[];

describe("262k selection operations", () => {
  const store = new CanvasStore();
  const base = createTestEntity({ id: "large-selection-0" });
  const entities = new Array<ShaderCanvasEntity>(ENTITY_COUNT);
  entities[0] = base;
  for (let index = 1; index < ENTITY_COUNT; index++) {
    entities[index] = {
      ...base,
      id: `large-selection-${index}`,
      zIndex: index,
      position: { x: index * 8, y: 0 },
    };
  }
  store.addEntities(entities);
  const halfSelectedIds = entities.slice(0, SELECTED_COUNT).map((entity) => entity.id);

  const prepareHalfSelection = () => {
    store.replaceSelection(halfSelectedIds);
    for (const path of MOUNTED_DITHERING_PARAM_PATHS) store.getParamResult(path, null);
  };

  bench(
    "Command-A plus mounted parameter aggregation",
    () => {
      prepareHalfSelection();
      store.selectAll();
      for (const path of MOUNTED_DITHERING_PARAM_PATHS) store.getParamResult(path, null);
    },
    { time: 0, iterations: 3, warmupTime: 0, warmupIterations: 1 },
  );

  bench(
    "commit half-selection translation",
    () => {
      store.moveEntities(halfSelectedIds, { x: 1, y: 0 });
      store.moveEntities(halfSelectedIds, { x: -1, y: 0 });
    },
    { time: 0, iterations: 3, warmupTime: 0, warmupIterations: 1 },
  );
});
