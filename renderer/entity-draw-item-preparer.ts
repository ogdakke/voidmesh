import { config } from "#config";
import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import { getViewportWorldBounds } from "#lib/canvas-math.ts";
import type { EntitySpatialIndex } from "#lib/entity-spatial-index.ts";
import { tracePerformancePhase } from "#lib/performance-tracing.ts";
import { MediaType, type Bounds, type ShaderCanvasEntity, type Viewport } from "#types/canvas.ts";
import type {
  CompositionDrawItem,
  CompositionPass,
  FullSceneBatchKey,
  PrepareCompositionItemOptions,
} from "./composition-pass.ts";
import type { EntityTexturePipeline } from "./entity-texture-pipeline.ts";
import { getEntityRenderSize } from "./entity-render-size.ts";

interface EntityDrawItemPreparerOptions {
  texturePipeline: EntityTexturePipeline;
  compositionPass: CompositionPass;
}

interface PrepareEntityDrawItemsOptions {
  entities: ShaderCanvasEntity[];
  entitySpatialIndex: EntitySpatialIndex;
  entityVersion: number;
  geometryVersion: number;
  selectionVersion: number;
  viewport: Viewport;
  width: number;
  height: number;
  devicePixelRatio: number;
  encoder: GPUCommandEncoder;
  selectedEntityIds: ReadonlySet<string>;
  actionLayer: ActionLayerRenderState;
  dragVisual: DragVisualRenderState;
  dragSelectActive: boolean;
  hasCanvasCallouts: boolean;
  debugMode: boolean;
}

export interface PreparedEntityDrawItems {
  entityDrawItems: CompositionDrawItem[];
  actionLayerDrawItems: CompositionDrawItem[];
  fullSceneBatch: FullSceneBatchKey | null;
  hasAnimatingContent: boolean;
}

export interface EntityPreparationPhaseStats {
  batchAdmissionMs: number;
  spatialQueryMs: number;
  visibleEntityPreparationMs: number;
}

export interface FullSceneSnapshotSource {
  kind: "processed" | "source";
  texture: GPUTexture;
  ownerEntityId: string;
}

export class EntityDrawItemPreparer {
  readonly #texturePipeline: EntityTexturePipeline;
  readonly #compositionPass: CompositionPass;
  readonly #desiredRenderSize = { width: 0, height: 0 };
  readonly #resolvedRenderSize = { width: 0, height: 0 };
  readonly #viewportBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #visibleEntities: ShaderCanvasEntity[] = [];
  readonly #entityDrawItems: CompositionDrawItem[] = [];
  readonly #actionLayerDrawItems: CompositionDrawItem[] = [];
  readonly #prepared: PreparedEntityDrawItems = {
    entityDrawItems: this.#entityDrawItems,
    actionLayerDrawItems: this.#actionLayerDrawItems,
    fullSceneBatch: null,
    hasAnimatingContent: false,
  };
  #fullSceneBatchKey: FullSceneBatchKey | null = null;
  #homogeneousEntityVersion = -1;
  #homogeneousEntities: readonly ShaderCanvasEntity[] | null = null;
  #homogeneousRepresentative: ShaderCanvasEntity | null = null;
  #snapshotRepresentative: ShaderCanvasEntity | null = null;
  #snapshotEntityVersion = -1;
  #snapshotRenderWidth = 0;
  #snapshotRenderHeight = 0;
  #fullSceneAdmissionQueried = false;
  #compositionOptions: PrepareCompositionItemOptions | null = null;
  #singleSelectionVersion = -1;
  #singleSelectionEntityVersion = -1;
  #singleSelectionGeometryVersion = -1;
  #singleSelectedIndex = -1;
  readonly #phaseStats: EntityPreparationPhaseStats = {
    batchAdmissionMs: 0,
    spatialQueryMs: 0,
    visibleEntityPreparationMs: 0,
  };

  constructor(options: EntityDrawItemPreparerOptions) {
    this.#texturePipeline = options.texturePipeline;
    this.#compositionPass = options.compositionPass;
  }

  prepare(options: PrepareEntityDrawItemsOptions): PreparedEntityDrawItems {
    const {
      entities,
      entitySpatialIndex,
      viewport,
      width,
      height,
      devicePixelRatio,
      encoder,
      selectedEntityIds,
      actionLayer,
      dragVisual,
      debugMode,
    } = options;

    const entityDrawItems = this.#entityDrawItems;
    const actionLayerDrawItems = this.#actionLayerDrawItems;
    entityDrawItems.length = 0;
    actionLayerDrawItems.length = 0;
    if (this.#snapshotEntityVersion !== options.entityVersion) {
      this.#snapshotRepresentative = null;
      this.#snapshotEntityVersion = options.entityVersion;
    }
    this.#prepared.fullSceneBatch = null;
    this.#fullSceneAdmissionQueried = false;
    let hasAnimatingContent = false;
    this.#phaseStats.batchAdmissionMs = 0;
    this.#phaseStats.spatialQueryMs = 0;
    this.#phaseStats.visibleEntityPreparationMs = 0;

    const batchAdmissionStart = performance.now();
    const fullSceneBatch = this.#prepareFullSceneBatch(options);
    const batchAdmissionEnd = performance.now();
    this.#phaseStats.batchAdmissionMs = tracePerformancePhase(
      "render.batch-admission",
      batchAdmissionStart,
      batchAdmissionEnd,
    );
    if (fullSceneBatch) {
      this.#prepared.fullSceneBatch = fullSceneBatch;
      this.#prepared.hasAnimatingContent = false;
      return this.#prepared;
    }

    let actionLayerOffsetX = 0;
    let actionLayerOffsetY = 0;
    const actionLayerActive = actionLayer.active;
    if (actionLayerActive) {
      const cssOffset = actionLayer.entityOffset;
      actionLayerOffsetX = (cssOffset.x * devicePixelRatio) / viewport.zoom;
      actionLayerOffsetY = (cssOffset.y * devicePixelRatio) / viewport.zoom;
    }

    const viewportBounds = getViewportWorldBounds(
      viewport,
      width,
      height,
      config.canvas.cullingBufferFraction,
      this.#viewportBounds,
    );

    let visibleEntities: readonly ShaderCanvasEntity[];
    if (this.#fullSceneAdmissionQueried) {
      visibleEntities = this.#visibleEntities;
    } else {
      const spatialQueryStart = performance.now();
      visibleEntities = entitySpatialIndex.queryBounds(
        viewportBounds,
        this.#visibleEntities,
        entities,
      );
      const spatialQueryEnd = performance.now();
      this.#phaseStats.spatialQueryMs = tracePerformancePhase(
        "render.spatial-query",
        spatialQueryStart,
        spatialQueryEnd,
      );
    }
    const allEntitiesSelected = entities.length > 0 && selectedEntityIds.size === entities.length;
    let previousSizedEntity: ShaderCanvasEntity | null = null;
    let previousDesiredWidth = 0;
    let previousDesiredHeight = 0;
    const visiblePreparationStart = performance.now();
    for (const entity of visibleEntities) {
      // Check if texture needs regeneration. Animated media is marked dirty by the
      // game loop only when the decoded frame changes.
      const textureWasDirty = !!entity.textureDirty;
      const needsContinuousRender = this.#texturePipeline.needsContinuousRenderForEntity(entity);
      if (textureWasDirty || needsContinuousRender) {
        hasAnimatingContent = true;
      }

      const sameProjectedSize =
        previousSizedEntity !== null &&
        previousSizedEntity.size.width === entity.size.width &&
        previousSizedEntity.size.height === entity.size.height &&
        previousSizedEntity.originalSize.width === entity.originalSize.width &&
        previousSizedEntity.originalSize.height === entity.originalSize.height;
      const desiredRenderSize = this.#desiredRenderSize;
      if (sameProjectedSize) {
        desiredRenderSize.width = previousDesiredWidth;
        desiredRenderSize.height = previousDesiredHeight;
      } else {
        getEntityRenderSize(entity, viewport, devicePixelRatio, desiredRenderSize);
        previousSizedEntity = entity;
        previousDesiredWidth = desiredRenderSize.width;
        previousDesiredHeight = desiredRenderSize.height;
      }
      let compositionSource = this.#texturePipeline.getReusableStaticCompositionSource(
        entity,
        desiredRenderSize,
        needsContinuousRender,
      );
      if (!compositionSource) {
        const renderSize = this.#texturePipeline.resolveRenderSize(
          entity,
          desiredRenderSize,
          this.#resolvedRenderSize,
        );
        if (!renderSize) continue;
        compositionSource = this.#texturePipeline.renderEntityToTexture(
          entity,
          encoder,
          renderSize,
        );
      }
      if (!compositionSource) continue;

      // Clear dirty flag
      entity.textureDirty = false;

      // Determine whether this entity is selected.
      const isSelected = allEntitiesSelected || selectedEntityIds.has(entity.id);

      // Action layer entities are drawn AFTER blur (not in main pass) to avoid halo
      const isActionLayerEntity = actionLayerActive && actionLayer.entityIds.has(entity.id);
      const positionOffsetX = isActionLayerEntity ? actionLayerOffsetX : 0;
      const positionOffsetY = isActionLayerEntity ? actionLayerOffsetY : 0;
      const visualScale =
        dragVisual.active && dragVisual.entityIds.has(entity.id) ? dragVisual.scale : 1;
      let compositionOptions = this.#compositionOptions;
      if (!compositionOptions) {
        compositionOptions = {
          entity,
          source: compositionSource,
          isSelected,
          debugMode,
          positionOffsetX,
          positionOffsetY,
          visualScale,
        };
        this.#compositionOptions = compositionOptions;
      } else {
        compositionOptions.entity = entity;
        compositionOptions.source = compositionSource;
        compositionOptions.isSelected = isSelected;
        compositionOptions.debugMode = debugMode;
        compositionOptions.positionOffsetX = positionOffsetX;
        compositionOptions.positionOffsetY = positionOffsetY;
        compositionOptions.visualScale = visualScale;
      }
      const drawItem = this.#compositionPass.prepareDrawItem(compositionOptions);

      if (isActionLayerEntity) {
        actionLayerDrawItems.push(drawItem);
      } else {
        entityDrawItems.push(drawItem);
      }
    }
    const visiblePreparationEnd = performance.now();
    this.#phaseStats.visibleEntityPreparationMs = tracePerformancePhase(
      "render.visible-entity-preparation",
      visiblePreparationStart,
      visiblePreparationEnd,
    );

    this.#prepared.hasAnimatingContent = hasAnimatingContent;
    return this.#prepared;
  }

  getPhaseStats(): Readonly<EntityPreparationPhaseStats> {
    return this.#phaseStats;
  }

  getFullSceneSnapshotSource(entity: ShaderCanvasEntity): FullSceneSnapshotSource | null {
    const representative = this.#snapshotRepresentative;
    if (!representative || !isFullSceneEquivalent(entity, representative)) return null;
    const source = this.#texturePipeline.getReusableStaticCompositionSource(
      representative,
      { width: this.#snapshotRenderWidth, height: this.#snapshotRenderHeight },
      false,
    );
    if (source?.kind !== "texture") return null;
    return {
      kind: representative.shaderParams.showOriginal ? "source" : "processed",
      texture: source.texture,
      ownerEntityId: representative.id,
    };
  }

  #prepareFullSceneBatch(options: PrepareEntityDrawItemsOptions): FullSceneBatchKey | null {
    const {
      entities,
      entitySpatialIndex,
      entityVersion,
      geometryVersion,
      selectionVersion,
      viewport,
      width,
      height,
      devicePixelRatio,
      encoder,
      selectedEntityIds,
      actionLayer,
      dragVisual,
      dragSelectActive,
      hasCanvasCallouts,
      debugMode,
    } = options;
    if (
      entities.length < config.rendering.fullSceneBatchMinEntityCount ||
      actionLayer.active ||
      actionLayer.blurIntensity > 0.01 ||
      (dragVisual.active && !dragVisual.appliesToSelection) ||
      dragSelectActive ||
      hasCanvasCallouts
    ) {
      return null;
    }

    const representative = this.#getHomogeneousRepresentative(entities, entityVersion);
    if (!representative || this.#texturePipeline.needsContinuousRenderForEntity(representative)) {
      return null;
    }

    const desiredRenderSize = getEntityRenderSize(
      representative,
      viewport,
      devicePixelRatio,
      this.#desiredRenderSize,
    );
    let renderWidth = desiredRenderSize.width;
    let renderHeight = desiredRenderSize.height;
    let compositionSource = this.#texturePipeline.getReusableStaticCompositionSource(
      representative,
      desiredRenderSize,
      false,
    );
    if (!compositionSource) {
      const renderSize = this.#texturePipeline.resolveRenderSize(
        representative,
        desiredRenderSize,
        this.#resolvedRenderSize,
      );
      if (!renderSize) return null;
      renderWidth = renderSize.width;
      renderHeight = renderSize.height;
      compositionSource = this.#texturePipeline.renderEntityToTexture(
        representative,
        encoder,
        renderSize,
      );
    }
    if (compositionSource?.kind !== "texture") return null;
    representative.textureDirty = false;

    const key = this.#fullSceneBatchKey ?? {
      entityVersion,
      geometryVersion,
      selectionVersion,
      debugMode,
      singleSelectedIndex: -1,
      renderWidth,
      renderHeight,
      texture: compositionSource.texture,
      instanceCount: entities.length,
    };
    this.#fullSceneBatchKey = key;
    key.entityVersion = entityVersion;
    key.geometryVersion = geometryVersion;
    key.selectionVersion = selectionVersion;
    key.debugMode = debugMode;
    key.singleSelectedIndex = this.#getSingleSelectedIndex(
      entities,
      selectedEntityIds,
      selectionVersion,
      entityVersion,
      geometryVersion,
    );
    key.renderWidth = renderWidth;
    key.renderHeight = renderHeight;
    key.texture = compositionSource.texture;
    key.instanceCount = entities.length;
    if (this.#compositionPass.hasFullSceneBatch(key)) {
      this.#rememberSnapshotSource(representative, entityVersion, renderWidth, renderHeight);
      return key;
    }

    const viewportBounds = getViewportWorldBounds(
      viewport,
      width,
      height,
      config.canvas.cullingBufferFraction,
      this.#viewportBounds,
    );
    const spatialQueryStart = performance.now();
    const visibleEntities = entitySpatialIndex.queryBounds(
      viewportBounds,
      this.#visibleEntities,
      entities,
    );
    const spatialQueryEnd = performance.now();
    this.#phaseStats.spatialQueryMs = tracePerformancePhase(
      "render.spatial-query",
      spatialQueryStart,
      spatialQueryEnd,
    );
    this.#fullSceneAdmissionQueried = true;
    if (
      visibleEntities.length / entities.length <
      config.rendering.fullSceneBatchMinVisibleFraction
    ) {
      return null;
    }

    this.#compositionPass.prepareFullSceneBatch({ ...key, entities, selectedEntityIds });
    this.#rememberSnapshotSource(representative, entityVersion, renderWidth, renderHeight);
    return key;
  }

  #rememberSnapshotSource(
    representative: ShaderCanvasEntity,
    entityVersion: number,
    renderWidth: number,
    renderHeight: number,
  ): void {
    this.#snapshotRepresentative = representative;
    this.#snapshotEntityVersion = entityVersion;
    this.#snapshotRenderWidth = renderWidth;
    this.#snapshotRenderHeight = renderHeight;
  }

  #getHomogeneousRepresentative(
    entities: readonly ShaderCanvasEntity[],
    entityVersion: number,
  ): ShaderCanvasEntity | null {
    if (
      this.#homogeneousEntityVersion === entityVersion &&
      this.#homogeneousEntities === entities
    ) {
      return this.#homogeneousRepresentative;
    }
    this.#homogeneousEntityVersion = entityVersion;
    this.#homogeneousEntities = entities;
    this.#homogeneousRepresentative = null;

    const representative = entities[0];
    if (!representative || representative.mediaSource.type !== MediaType.image) return null;
    const asset = representative.mediaSource.asset;
    for (let index = 1; index < entities.length; index++) {
      const entity = entities[index]!;
      if (!isFullSceneEquivalent(entity, representative, asset)) {
        return null;
      }
    }

    this.#homogeneousRepresentative = representative;
    return representative;
  }

  #getSingleSelectedIndex(
    entities: readonly ShaderCanvasEntity[],
    selectedEntityIds: ReadonlySet<string>,
    selectionVersion: number,
    entityVersion: number,
    geometryVersion: number,
  ): number {
    if (
      this.#singleSelectionVersion === selectionVersion &&
      this.#singleSelectionEntityVersion === entityVersion &&
      this.#singleSelectionGeometryVersion === geometryVersion
    ) {
      return this.#singleSelectedIndex;
    }

    this.#singleSelectionVersion = selectionVersion;
    this.#singleSelectionEntityVersion = entityVersion;
    this.#singleSelectionGeometryVersion = geometryVersion;
    this.#singleSelectedIndex = -1;
    if (selectedEntityIds.size !== 1) return -1;

    const selectedId = selectedEntityIds.values().next().value;
    for (let index = 0; index < entities.length; index++) {
      if (entities[index]!.id === selectedId) {
        this.#singleSelectedIndex = index;
        break;
      }
    }
    return this.#singleSelectedIndex;
  }
}

function isFullSceneEquivalent(
  entity: ShaderCanvasEntity,
  representative: ShaderCanvasEntity,
  representativeAsset = representative.mediaSource.type === MediaType.image
    ? representative.mediaSource.asset
    : null,
): boolean {
  return (
    representativeAsset !== null &&
    entity.mediaSource.type === MediaType.image &&
    entity.mediaSource.asset === representativeAsset &&
    entity.shaderType === representative.shaderType &&
    entity.originalSize.width === representative.originalSize.width &&
    entity.originalSize.height === representative.originalSize.height &&
    entity.size.width === representative.size.width &&
    entity.size.height === representative.size.height &&
    structurallyEqual(entity.shaderParams, representative.shaderParams)
  );
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!structurallyEqual(a[index], b[index])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  let aKeyCount = 0;
  let bKeyCount = 0;
  for (const key in aRecord) {
    if (!Object.hasOwn(aRecord, key)) continue;
    aKeyCount++;
    if (!Object.hasOwn(bRecord, key) || !structurallyEqual(aRecord[key], bRecord[key])) {
      return false;
    }
  }
  for (const key in bRecord) {
    if (Object.hasOwn(bRecord, key)) bKeyCount++;
  }
  return aKeyCount === bKeyCount;
}
