import { describe, expect, test } from "vitest";
import {
  MANY_ENTITY_SCENARIOS,
  estimateDecodedAssetBytes,
  getManyEntityPosition,
  getManyEntityViewportOffset,
} from "./many-entity-scenarios.ts";

const canvasSize = { width: 1280, height: 720 };

describe("many entity benchmark scenarios", () => {
  test("covers the required asset, visibility, churn, and processed-output dimensions", () => {
    expect(MANY_ENTITY_SCENARIOS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityCount: 10_000,
          assetMode: "shared",
          layout: "all-visible",
        }),
        expect.objectContaining({ entityCount: 10_000, assetMode: "shared", layout: "world-grid" }),
        expect.objectContaining({ assetMode: "unique", layout: "all-visible" }),
        expect.objectContaining({ assetMode: "unique", pan: true }),
        expect.objectContaining({ processPixels: true }),
        expect.objectContaining({
          entityCount: 262_144,
          selectedEntityFraction: 0.5,
          debugMode: true,
          paceWithAnimationFrame: true,
        }),
      ]),
    );
    expect(new Set(MANY_ENTITY_SCENARIOS.map((scenario) => scenario.id)).size).toBe(
      MANY_ENTITY_SCENARIOS.length,
    );
  });

  test("packs all-visible entities inside the canvas", () => {
    const scenario = MANY_ENTITY_SCENARIOS.find(
      (item) => item.id === "many-10000-shared-original-all-visible",
    )!;
    for (const index of [0, 1, 999, scenario.entityCount - 1]) {
      const position = getManyEntityPosition({
        index,
        entityCount: scenario.entityCount,
        displaySize: scenario.displaySize,
        layout: scenario.layout,
        canvasSize,
      });
      expect(position.x).toBeGreaterThanOrEqual(0);
      expect(position.y).toBeGreaterThanOrEqual(0);
      expect(position.x + scenario.displaySize.width).toBeLessThanOrEqual(canvasSize.width);
      expect(position.y + scenario.displaySize.height).toBeLessThanOrEqual(canvasSize.height);
    }
  });

  test("panning visits different bounded world pages", () => {
    const scenario = MANY_ENTITY_SCENARIOS.find(
      (item) => item.id === "many-4096-unique-thumbnails-pan",
    )!;
    const offsets = [0, 3, 6, 90].map((frame) =>
      getManyEntityViewportOffset(scenario, frame, canvasSize),
    );
    expect(new Set(offsets.map((offset) => `${offset.x}:${offset.y}`)).size).toBeGreaterThan(2);
    for (const offset of offsets) {
      expect(offset.x).toBeGreaterThanOrEqual(0);
      expect(offset.y).toBeGreaterThanOrEqual(0);
    }
  });

  test("reports decoded-pixel pressure from unique assets rather than instances", () => {
    const shared = MANY_ENTITY_SCENARIOS.find(
      (item) => item.id === "many-10000-shared-original-all-visible",
    )!;
    const unique = MANY_ENTITY_SCENARIOS.find(
      (item) => item.id === "many-4096-unique-thumbnails-all-visible",
    )!;
    expect(estimateDecodedAssetBytes(shared)).toBe(1024 * 1024 * 4);
    expect(estimateDecodedAssetBytes(unique)).toBe(4096 * 128 * 128 * 4);
  });

  test("covers the 262k overview selection-density and debug matrix", () => {
    const overviewScenarios = MANY_ENTITY_SCENARIOS.filter(
      (scenario) => scenario.entityCount === 262_144,
    );

    expect(
      overviewScenarios.map((scenario) => ({
        id: scenario.id,
        selectedEntityCount: scenario.selectedEntityCount ?? 0,
        selectedEntityFraction: scenario.selectedEntityFraction ?? 0,
        debugMode: scenario.debugMode ?? false,
        dragSelectedEntities: scenario.dragSelectedEntities ?? false,
      })),
    ).toEqual([
      expect.objectContaining({ selectedEntityCount: 0, selectedEntityFraction: 0 }),
      expect.objectContaining({ selectedEntityCount: 1 }),
      expect.objectContaining({ selectedEntityFraction: 0.5, debugMode: false }),
      expect.objectContaining({ selectedEntityFraction: 1 }),
      expect.objectContaining({ selectedEntityFraction: 0.5, debugMode: true }),
      expect.objectContaining({ selectedEntityFraction: 0.5, dragSelectedEntities: true }),
    ]);
  });
});
