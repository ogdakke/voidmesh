import { afterEach, describe, expect, test, vi } from "vitest";
import { releaseImageAsset } from "#lib/media-assets.ts";
import { EntitySpatialIndex } from "#lib/entity-spatial-index.ts";
import type { CompositionPass } from "#renderer/composition-pass.ts";
import { EntityDrawItemPreparer } from "#renderer/entity-draw-item-preparer.ts";
import type { EntityTexturePipeline } from "#renderer/entity-texture-pipeline.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

afterEach(() => vi.restoreAllMocks());

describe("EntityDrawItemPreparer LOD transitions", () => {
  test("crossfades between regular texture tiers and keeps rendering until complete", () => {
    const entity = createTestEntity({ id: "lod-crossfade" });
    entity.textureDirty = false;
    const lowTexture = createTexture(128, 128);
    const highTexture = createTexture(512, 512);
    let sourceTexture = lowTexture;
    const touchCompositionTexture = vi.fn<(texture: GPUTexture) => void>();
    const texturePipeline = {
      needsContinuousRenderForEntity: vi.fn<
        EntityTexturePipeline["needsContinuousRenderForEntity"]
      >(() => false),
      getReusableStaticCompositionSource: vi.fn<
        EntityTexturePipeline["getReusableStaticCompositionSource"]
      >(() => ({ kind: "texture", texture: sourceTexture })),
      touchCompositionTexture,
    } as unknown as EntityTexturePipeline;
    let preparedTexture: GPUTexture | null = null;
    const compositionPass = {
      getPreparedRegularTexture: vi.fn<CompositionPass["getPreparedRegularTexture"]>(
        () => preparedTexture,
      ),
      prepareDrawItem: vi.fn<CompositionPass["prepareDrawItem"]>((options) => {
        preparedTexture = options.source.kind === "texture" ? options.source.texture : null;
        return {
          bindGroup: null,
          texture: preparedTexture,
          pipeline: options.source.kind,
          entity: options.entity,
          isSelected: options.isSelected,
          debugMode: options.debugMode,
          offsetX: options.positionOffsetX,
          offsetY: options.positionOffsetY,
          visualScale: options.visualScale,
          previousTexture: options.previousTexture,
          lodBlend: options.lodBlend,
        };
      }),
    } as unknown as CompositionPass;
    const preparer = new EntityDrawItemPreparer({ texturePipeline, compositionPass });
    const spatialIndex = new EntitySpatialIndex();
    spatialIndex.upsert(entity);
    const now = vi.spyOn(performance, "now");

    now.mockReturnValue(0);
    expect(prepare(preparer, entity, spatialIndex).entityDrawItems[0]?.lodBlend).toBe(1);

    sourceTexture = highTexture;
    now.mockReturnValue(100);
    let prepared = prepare(preparer, entity, spatialIndex);
    expect(prepared.entityDrawItems[0]?.previousTexture).toBe(lowTexture);
    expect(prepared.entityDrawItems[0]?.lodBlend).toBe(0);
    expect(preparer.hasActiveLodTransitions).toBe(true);
    expect(touchCompositionTexture).toHaveBeenCalledWith(lowTexture);

    now.mockReturnValue(170);
    prepared = prepare(preparer, entity, spatialIndex);
    expect(prepared.entityDrawItems[0]?.lodBlend).toBeCloseTo(0.5);
    expect(preparer.hasActiveLodTransitions).toBe(true);

    now.mockReturnValue(241);
    prepared = prepare(preparer, entity, spatialIndex);
    expect(prepared.entityDrawItems[0]?.previousTexture).toBeNull();
    expect(prepared.entityDrawItems[0]?.lodBlend).toBe(1);
    expect(preparer.hasActiveLodTransitions).toBe(false);

    if (entity.mediaSource.type === "image") releaseImageAsset(entity.mediaSource.asset);
  });
});

function prepare(
  preparer: EntityDrawItemPreparer,
  entity: ReturnType<typeof createTestEntity>,
  entitySpatialIndex: EntitySpatialIndex,
) {
  return preparer.prepare({
    entities: [entity],
    entitySpatialIndex,
    viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
    width: 800,
    height: 600,
    devicePixelRatio: 1,
    encoder: {} as GPUCommandEncoder,
    hoveredEntityId: null,
    selectedEntityIds: new Set(),
    actionLayer: {
      active: false,
      entityIds: new Set(),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    },
    dragVisual: { active: false, isDragPhase: false, entityIds: new Set(), scale: 1 },
    debugMode: false,
  });
}

function createTexture(width: number, height: number): GPUTexture {
  return { width, height } as GPUTexture;
}
