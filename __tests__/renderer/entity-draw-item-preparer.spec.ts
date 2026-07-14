import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { config } from "#config";
import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import { releaseImageAsset, retainImageAsset } from "#lib/media-assets.ts";
import { EntityDrawItemPreparer } from "#renderer/entity-draw-item-preparer.ts";
import type {
  CompositionDrawItem,
  FullSceneBatchKey,
  PrepareFullSceneBatchOptions,
} from "#renderer/composition-pass.ts";
import type { ShaderCanvasEntity, Viewport } from "#types/canvas.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

const renderingConfig = config.rendering as unknown as {
  fullSceneBatchMinEntityCount: number;
  fullSceneBatchMinVisibleFraction: number;
};
const originalMinimumCount = renderingConfig.fullSceneBatchMinEntityCount;
const originalMinimumVisibleFraction = renderingConfig.fullSceneBatchMinVisibleFraction;

describe("EntityDrawItemPreparer full-scene batching", () => {
  beforeAll(() => {
    renderingConfig.fullSceneBatchMinEntityCount = 2;
    renderingConfig.fullSceneBatchMinVisibleFraction = 0.25;
  });

  afterAll(() => {
    renderingConfig.fullSceneBatchMinEntityCount = originalMinimumCount;
    renderingConfig.fullSceneBatchMinVisibleFraction = originalMinimumVisibleFraction;
  });

  test("reuses an admitted homogeneous batch without another spatial query", () => {
    const scene = createScene();
    const harness = createHarness(scene.entities);

    const first = harness.preparer.prepare(harness.options);
    expect(first.fullSceneBatch).not.toBeNull();
    expect(harness.spatialIndex.queryBounds).toHaveBeenCalledOnce();
    expect(harness.compositionPass.prepareFullSceneBatch).toHaveBeenCalledOnce();

    harness.options.viewport = { offset: { x: 500, y: 200 }, zoom: 1 };
    const second = harness.preparer.prepare(harness.options);
    expect(second.fullSceneBatch).not.toBeNull();
    expect(harness.spatialIndex.queryBounds).toHaveBeenCalledOnce();
    expect(harness.texturePipeline.getReusableStaticCompositionSource).toHaveBeenCalledTimes(2);
    expect(harness.compositionPass.prepareFullSceneBatch).toHaveBeenCalledOnce();

    scene.release();
  });

  test("supplies the cached texture for a non-representative fancy-delete snapshot", () => {
    const scene = createScene();
    const harness = createHarness(scene.entities);
    harness.preparer.prepare(harness.options);

    expect(harness.preparer.getFullSceneSnapshotSource(scene.entities[1]!)).toEqual({
      kind: "processed",
      texture: harness.texture,
      ownerEntityId: scene.entities[0]!.id,
    });

    const different = {
      ...scene.entities[1]!,
      shaderParams: structuredClone(scene.entities[1]!.shaderParams),
    };
    different.shaderParams.size += 1;
    expect(harness.preparer.getFullSceneSnapshotSource(different)).toBeNull();

    scene.release();
  });

  test("requires the admission viewport to contain the configured scene fraction", () => {
    const scene = createScene();
    const harness = createHarness(scene.entities, []);

    expect(harness.preparer.prepare(harness.options).fullSceneBatch).toBeNull();
    expect(harness.spatialIndex.queryBounds).toHaveBeenCalledOnce();
    expect(harness.compositionPass.prepareFullSceneBatch).not.toHaveBeenCalled();

    scene.release();
  });

  test("persists heterogeneous static-image scenes as a mixed texture plan", () => {
    const scene = createScene();
    scene.entities[1]!.shaderParams = structuredClone(scene.entities[1]!.shaderParams);
    scene.entities[1]!.shaderParams.size += 1;
    const harness = createHarness(scene.entities);

    expect(harness.preparer.prepare(harness.options).fullSceneBatch).not.toBeNull();
    expect(harness.compositionPass.prepareFullSceneBatch).not.toHaveBeenCalled();
    expect(harness.compositionPass.prepareMixedFullSceneBatch).toHaveBeenCalledOnce();

    harness.options.viewport = { offset: { x: 0, y: 0 }, zoom: 0.1 };
    harness.options.mixedFullSceneBatchMode = "reuse";
    expect(harness.preparer.prepare(harness.options).fullSceneBatch).not.toBeNull();
    expect(harness.compositionPass.prepareMixedFullSceneBatch).toHaveBeenCalledOnce();

    scene.release();
  });

  test("uses visible preparation for a mixed scene until zoom LOD work settles", () => {
    const scene = createScene();
    scene.entities[1]!.shaderParams = structuredClone(scene.entities[1]!.shaderParams);
    scene.entities[1]!.shaderParams.size += 1;
    const harness = createHarness(scene.entities);
    harness.options.mixedFullSceneBatchMode = "disabled";

    expect(harness.preparer.prepare(harness.options).fullSceneBatch).toBeNull();
    expect(harness.compositionPass.prepareMixedFullSceneBatch).not.toHaveBeenCalled();
    expect(harness.compositionPass.prepareDrawItem).toHaveBeenCalledTimes(scene.entities.length);

    harness.options.mixedFullSceneBatchMode = "refresh";
    expect(harness.preparer.prepare(harness.options).fullSceneBatch).not.toBeNull();
    expect(harness.compositionPass.prepareMixedFullSceneBatch).toHaveBeenCalledOnce();

    scene.release();
  });

  test("rejects continuous shader scenes", () => {
    const scene = createScene();
    const harness = createHarness(scene.entities);
    harness.texturePipeline.needsContinuousRenderForEntity.mockReturnValue(true);

    expect(harness.preparer.prepare(harness.options).fullSceneBatch).toBeNull();
    expect(harness.compositionPass.prepareFullSceneBatch).not.toHaveBeenCalled();

    scene.release();
  });

  test("keeps the persistent batch for selection and rebuilds only when selection changes", () => {
    const scene = createScene();
    const harness = createHarness(scene.entities);
    harness.options.selectedEntityIds.add(scene.entities[0]!.id);
    harness.options.selectionVersion++;

    const first = harness.preparer.prepare(harness.options);
    expect(first.fullSceneBatch).toMatchObject({
      selectionVersion: 2,
      singleSelectedIndex: 0,
    });
    expect(harness.compositionPass.prepareFullSceneBatch).toHaveBeenCalledOnce();

    harness.options.viewport = { offset: { x: 500, y: 200 }, zoom: 1 };
    harness.preparer.prepare(harness.options);
    expect(harness.compositionPass.prepareFullSceneBatch).toHaveBeenCalledOnce();

    harness.options.selectedEntityIds.clear();
    harness.options.selectedEntityIds.add(scene.entities[1]!.id);
    harness.options.selectionVersion++;
    const changed = harness.preparer.prepare(harness.options);
    expect(changed.fullSceneBatch).toMatchObject({
      selectionVersion: 3,
      singleSelectedIndex: 1,
    });
    expect(harness.compositionPass.prepareFullSceneBatch).toHaveBeenCalledTimes(2);

    scene.entities.reverse();
    harness.options.geometryVersion++;
    const reordered = harness.preparer.prepare(harness.options);
    expect(reordered.fullSceneBatch).toMatchObject({ singleSelectedIndex: 0 });
    expect(harness.compositionPass.prepareFullSceneBatch).toHaveBeenCalledTimes(3);

    scene.release();
  });

  test("keeps the persistent batch in debug mode", () => {
    const scene = createScene();
    const harness = createHarness(scene.entities);
    harness.options.debugMode = true;

    expect(harness.preparer.prepare(harness.options).fullSceneBatch).toMatchObject({
      debugMode: true,
    });
    expect(harness.compositionPass.prepareFullSceneBatch).toHaveBeenCalledOnce();

    scene.release();
  });

  test("keeps the persistent batch for a drag transform covering the selection", () => {
    const scene = createScene();
    const harness = createHarness(scene.entities);
    harness.options.selectedEntityIds.add(scene.entities[0]!.id);
    harness.options.selectionVersion++;
    harness.options.dragVisual.active = true;
    harness.options.dragVisual.isDragPhase = true;
    harness.options.dragVisual.appliesToSelection = true;
    harness.options.dragVisual.entityIds = harness.options.selectedEntityIds;
    harness.options.dragVisual.offset = { x: 100, y: -50 };

    expect(harness.preparer.prepare(harness.options).fullSceneBatch).not.toBeNull();
    expect(harness.compositionPass.prepareFullSceneBatch).toHaveBeenCalledOnce();

    scene.release();
  });

  test("keeps the persistent batch while drag-selection membership changes on the GPU", () => {
    const scene = createScene();
    const harness = createHarness(scene.entities);
    harness.options.dragSelectMode = "replace";

    expect(harness.preparer.prepare(harness.options).fullSceneBatch).not.toBeNull();
    expect(harness.compositionPass.prepareFullSceneBatch).toHaveBeenCalledOnce();

    scene.release();
  });

  test.each([
    ["action layer", (options: PrepareOptions) => (options.actionLayer.active = true)],
    ["action blur", (options: PrepareOptions) => (options.actionLayer.blurIntensity = 0.5)],
    ["drag visual", (options: PrepareOptions) => (options.dragVisual.active = true)],
    ["canvas callouts", (options: PrepareOptions) => (options.hasCanvasCallouts = true)],
  ])("rejects batching during %s", (_label, configure) => {
    const scene = createScene();
    const harness = createHarness(scene.entities);
    configure(harness.options);

    expect(harness.preparer.prepare(harness.options).fullSceneBatch).toBeNull();
    expect(harness.compositionPass.prepareFullSceneBatch).not.toHaveBeenCalled();

    scene.release();
  });
});

type PrepareOptions = Parameters<EntityDrawItemPreparer["prepare"]>[0] & {
  selectedEntityIds: Set<string>;
  actionLayer: ActionLayerRenderState;
  dragVisual: DragVisualRenderState;
};

function createHarness(
  entities: ShaderCanvasEntity[],
  visibleEntities: ShaderCanvasEntity[] = entities,
) {
  const texture = { width: 64, height: 64 } as GPUTexture;
  let cachedKey: FullSceneBatchKey | null = null;
  const compositionPass = {
    hasFullSceneBatch: vi.fn<(key: FullSceneBatchKey) => boolean>((key) => {
      return (
        cachedKey !== null &&
        cachedKey.entityVersion === key.entityVersion &&
        cachedKey.geometryVersion === key.geometryVersion &&
        cachedKey.selectionVersion === key.selectionVersion &&
        cachedKey.debugMode === key.debugMode &&
        cachedKey.renderWidth === key.renderWidth &&
        cachedKey.renderHeight === key.renderHeight &&
        cachedKey.texture === key.texture &&
        cachedKey.textureCacheRevision === key.textureCacheRevision &&
        cachedKey.instanceCount === key.instanceCount
      );
    }),
    prepareFullSceneBatch: vi.fn<(options: PrepareFullSceneBatchOptions) => void>((options) => {
      cachedKey = { ...options };
    }),
    prepareMixedFullSceneBatch: vi.fn<
      (key: FullSceneBatchKey, items: readonly CompositionDrawItem[]) => void
    >((key) => {
      cachedKey = { ...key };
    }),
    prepareDrawItem: vi.fn<(options: { entity: ShaderCanvasEntity }) => CompositionDrawItem>(
      (options) =>
        ({
          entity: options.entity,
          texture,
          bindGroup: null,
          pipeline: "texture",
          isSelected: false,
          debugMode: false,
          offsetX: 0,
          offsetY: 0,
          visualScale: 1,
        }) satisfies CompositionDrawItem,
    ),
  };
  const texturePipeline = {
    textureCacheRevision: 1,
    needsContinuousRenderForEntity: vi.fn<(entity: ShaderCanvasEntity) => boolean>(() => false),
    getReusableStaticCompositionSource: vi.fn<() => { kind: "texture"; texture: GPUTexture }>(
      () => ({ kind: "texture", texture }),
    ),
    resolveRenderSize: vi.fn<() => null>(() => null),
    renderEntityToTexture: vi.fn<() => null>(() => null),
  };
  const spatialIndex = {
    queryBounds: vi.fn<(_bounds: unknown, output: ShaderCanvasEntity[]) => ShaderCanvasEntity[]>(
      (_bounds, output) => {
        output.length = 0;
        output.push(...visibleEntities);
        return output;
      },
    ),
  };
  const preparer = new EntityDrawItemPreparer({
    texturePipeline: texturePipeline as never,
    compositionPass: compositionPass as never,
  });
  const options: PrepareOptions = {
    entities,
    entitySpatialIndex: spatialIndex as never,
    entityVersion: 1,
    geometryVersion: 1,
    selectionVersion: 1,
    viewport: { offset: { x: 0, y: 0 }, zoom: 1 } satisfies Viewport,
    width: 1280,
    height: 720,
    devicePixelRatio: 1,
    encoder: {} as GPUCommandEncoder,
    selectedEntityIds: new Set(),
    actionLayer: {
      active: false,
      entityIds: new Set(),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    },
    dragVisual: {
      active: false,
      isDragPhase: false,
      entityIds: new Set(),
      scale: 1,
      offset: { x: 0, y: 0 },
      appliesToSelection: false,
    },
    dragSelectMode: null,
    mixedFullSceneBatchMode: "refresh",
    hasCanvasCallouts: false,
    debugMode: false,
  };
  return { preparer, options, spatialIndex, compositionPass, texturePipeline, texture };
}

function createScene(): { entities: ShaderCanvasEntity[]; release: () => void } {
  const first = createTestEntity({ id: "scene-first" });
  if (first.mediaSource.type !== "image") throw new Error("Expected image entity");
  const asset = first.mediaSource.asset;
  retainImageAsset(asset);
  const second: ShaderCanvasEntity = {
    ...first,
    id: "scene-second",
    position: { x: 220, y: 0 },
    shaderParams: structuredClone(first.shaderParams),
    mediaSource: { type: "image", asset },
  };
  return {
    entities: [first, second],
    release: () => {
      releaseImageAsset(asset);
      releaseImageAsset(asset);
    },
  };
}
