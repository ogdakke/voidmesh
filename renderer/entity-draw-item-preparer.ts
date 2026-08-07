import { config } from "#config";
import type { ActionLayerRenderState, DragSelectMode, DragVisualRenderState } from "#engine";
import { getViewportWorldBounds } from "#lib/canvas-math.ts";
import type { EntitySpatialIndex } from "#lib/entity-spatial-index.ts";
import { tracePerformancePhase } from "#lib/performance-tracing.ts";
import { haveEquivalentShaderParams } from "#lib/shader-params-identity.ts";
import { MediaType, type Bounds, type ShaderCanvasEntity, type Viewport } from "#types/canvas.ts";
import type {
  CompositionDrawItem,
  CompositionPass,
  FullSceneBatchPatch,
  FullSceneBatchKey,
  FullSceneInstancePatch,
  FullSceneTextureRange,
  PrepareCompositionItemOptions,
} from "./composition-pass.ts";
import type { EntityTexturePipeline } from "./entity-texture-pipeline.ts";
import { getEntityRenderSize } from "./entity-render-size.ts";

type MixedFullSceneBatchMode = "reuse" | "refresh" | "disabled";

interface EntityDrawItemPreparerOptions {
  texturePipeline: EntityTexturePipeline;
  compositionPass: CompositionPass;
}

interface PrepareEntityDrawItemsOptions {
  entities: ShaderCanvasEntity[];
  entityIndices: ReadonlyMap<string, number>;
  entitySpatialIndex: EntitySpatialIndex;
  entityVersion: number;
  geometryVersion: number;
  selectionVersion: number;
  dirtyEntityIds: ReadonlySet<string>;
  viewport: Viewport;
  width: number;
  height: number;
  devicePixelRatio: number;
  encoder: GPUCommandEncoder;
  selectedEntityIds: ReadonlySet<string>;
  actionLayer: ActionLayerRenderState;
  dragVisual: DragVisualRenderState;
  dragSelectMode: DragSelectMode | null;
  mixedFullSceneBatchMode: MixedFullSceneBatchMode;
  hasCanvasCallouts: boolean;
  debugMode: boolean;
}

interface MixedFullSceneTextureRun extends FullSceneTextureRange {
  representative: ShaderCanvasEntity;
}

interface MixedFullScenePlan {
  entities: readonly ShaderCanvasEntity[];
  entityVersion: number;
  geometryVersion: number;
  selectionVersion: number;
  debugMode: boolean;
  viewportZoom: number;
  devicePixelRatio: number;
  textureCacheRevision: number;
  fullTextureRunCount: number;
  runs: MixedFullSceneTextureRun[];
  runByEntity: WeakMap<ShaderCanvasEntity, MixedFullSceneTextureRun>;
  textures: GPUTexture[];
}

export interface PreparedEntityDrawItems {
  entityDrawItems: CompositionDrawItem[];
  actionLayerDrawItems: CompositionDrawItem[];
  fullSceneBatch: FullSceneBatchKey | null;
  singleSelectedDrawItem: CompositionDrawItem | null;
  singleSelectedOffsetX: number;
  singleSelectedOffsetY: number;
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
  #admissionVisibleEntities: readonly ShaderCanvasEntity[] = this.#visibleEntities;
  readonly #entityDrawItems: CompositionDrawItem[] = [];
  readonly #actionLayerDrawItems: CompositionDrawItem[] = [];
  readonly #fullScenePatches: FullSceneBatchPatch[] = [];
  readonly #fullSceneInstancePatches: FullSceneInstancePatch[] = [];
  #fullSceneEntityIndices: ReadonlyMap<string, number> = new Map();
  readonly #prepared: PreparedEntityDrawItems = {
    entityDrawItems: this.#entityDrawItems,
    actionLayerDrawItems: this.#actionLayerDrawItems,
    fullSceneBatch: null,
    singleSelectedDrawItem: null,
    singleSelectedOffsetX: 0,
    singleSelectedOffsetY: 0,
    hasAnimatingContent: false,
  };
  #fullSceneBatchKey: FullSceneBatchKey | null = null;
  #mixedFullSceneBatchKey: FullSceneBatchKey | null = null;
  #mixedFullScenePlan: MixedFullScenePlan | null = null;
  #mixedIneligibleEntityVersion = -1;
  #mixedIneligibleEntities: readonly ShaderCanvasEntity[] | null = null;
  #dragBatchEntities: readonly ShaderCanvasEntity[] | null = null;
  #dragBatchSelectedEntityIds: ReadonlySet<string> | null = null;
  #dragBatchEntityVersion = -1;
  #dragBatchGeometryVersion = -1;
  #dragBatchSelectionVersion = -1;
  #dragBatchDebugMode = false;
  #activeFullSceneBatchKey: FullSceneBatchKey | null = null;
  #activeFullSceneSelectedEntityIds: ReadonlySet<string> | null = null;
  #homogeneousEntityVersion = -1;
  #homogeneousEntityCount = 0;
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
  #singleSelectionIds: ReadonlySet<string> | null = null;
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
    this.#fullSceneEntityIndices = options.entityIndices;

    const entityDrawItems = this.#entityDrawItems;
    const actionLayerDrawItems = this.#actionLayerDrawItems;
    entityDrawItems.length = 0;
    actionLayerDrawItems.length = 0;
    if (this.#snapshotEntityVersion !== options.entityVersion) {
      this.#snapshotRepresentative = null;
      this.#snapshotEntityVersion = options.entityVersion;
    }
    this.#prepared.fullSceneBatch = null;
    this.#prepared.singleSelectedDrawItem = null;
    this.#prepared.singleSelectedOffsetX = 0;
    this.#prepared.singleSelectedOffsetY = 0;
    this.#fullSceneAdmissionQueried = false;
    this.#admissionVisibleEntities = this.#visibleEntities;
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
      this.#trackPreparedFullSceneDrag(options);
      const singleSelectedEntity =
        fullSceneBatch.singleSelectedIndex >= 0
          ? entities[fullSceneBatch.singleSelectedIndex]
          : undefined;
      if (
        singleSelectedEntity &&
        dragVisual.active &&
        dragVisual.appliesToSelection &&
        dragVisual.entityIds.has(singleSelectedEntity.id)
      ) {
        this.#prepared.singleSelectedOffsetX = dragVisual.offset.x;
        this.#prepared.singleSelectedOffsetY = dragVisual.offset.y;
      }
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
      visibleEntities = this.#admissionVisibleEntities;
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
      const textureWasDirty = options.dirtyEntityIds.has(entity.id);
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

      // Determine whether this entity is selected.
      const isSelected = allEntitiesSelected || selectedEntityIds.has(entity.id);

      // Action layer entities are drawn AFTER blur (not in main pass) to avoid halo
      const isActionLayerEntity = actionLayerActive && actionLayer.entityIds.has(entity.id);
      const isDragVisualEntity = dragVisual.active && dragVisual.entityIds.has(entity.id);
      const dragOffsetX =
        isDragVisualEntity && dragVisual.appliesToSelection ? dragVisual.offset.x : 0;
      const dragOffsetY =
        isDragVisualEntity && dragVisual.appliesToSelection ? dragVisual.offset.y : 0;
      const positionOffsetX = (isActionLayerEntity ? actionLayerOffsetX : 0) + dragOffsetX;
      const positionOffsetY = (isActionLayerEntity ? actionLayerOffsetY : 0) + dragOffsetY;
      const visualScale = isDragVisualEntity ? dragVisual.scale : 1;
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
      if (selectedEntityIds.size === 1 && isSelected) {
        this.#prepared.singleSelectedDrawItem = drawItem;
        this.#prepared.singleSelectedOffsetX = drawItem.offsetX;
        this.#prepared.singleSelectedOffsetY = drawItem.offsetY;
      }

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
      hasCanvasCallouts,
      debugMode,
    } = options;
    const committedDragBatch = this.#tryPatchCommittedFullSceneDrag(options);
    if (committedDragBatch) return committedDragBatch;
    if (
      actionLayer.active ||
      actionLayer.blurIntensity > 0.01 ||
      (dragVisual.active && !dragVisual.appliesToSelection) ||
      hasCanvasCallouts
    ) {
      return null;
    }

    const incrementallyPatchedBatch = this.#tryPatchFullSceneBatch(options);
    if (incrementallyPatchedBatch) return incrementallyPatchedBatch;

    const representative = this.#getHomogeneousRepresentative(
      entities,
      entityVersion,
      options.dirtyEntityIds,
    );
    if (!representative) {
      if (options.mixedFullSceneBatchMode === "disabled") return null;
      return this.#prepareMixedFullSceneBatch(
        options,
        options.mixedFullSceneBatchMode === "refresh",
      );
    }
    if (representative.mediaSource.type !== MediaType.image) return null;
    if (this.#texturePipeline.needsContinuousRenderForEntity(representative)) {
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
    const key = this.#fullSceneBatchKey ?? {
      entityVersion,
      geometryVersion,
      selectionVersion,
      debugMode,
      singleSelectedIndex: -1,
      renderWidth,
      renderHeight,
      texture: compositionSource.texture,
      textureCacheRevision: this.#texturePipeline.textureCacheRevision,
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
    key.textureCacheRevision = this.#texturePipeline.textureCacheRevision;
    key.instanceCount = entities.length;
    if (this.#hasResidentFullSceneBatch(key)) {
      this.#activeFullSceneBatchKey = key;
      this.#rememberSnapshotSource(representative, entityVersion, renderWidth, renderHeight);
      return key;
    }
    if (
      this.#compositionPass.restoreFullSceneBatch(key, [
        {
          texture: compositionSource.texture,
          firstInstance: 0,
          instanceCount: entities.length,
        },
      ])
    ) {
      this.#activeFullSceneBatchKey = key;
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
    this.#admissionVisibleEntities = visibleEntities;
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
    this.#rememberFullSceneBatch(key, selectedEntityIds);
    this.#rememberSnapshotSource(representative, entityVersion, renderWidth, renderHeight);
    return key;
  }

  #trackPreparedFullSceneDrag(options: PrepareEntityDrawItemsOptions): void {
    const { dragVisual } = options;
    if (
      dragVisual.active &&
      dragVisual.isDragPhase &&
      dragVisual.appliesToSelection &&
      options.selectedEntityIds.size > 0 &&
      (dragVisual.offset.x !== 0 || dragVisual.offset.y !== 0)
    ) {
      this.#dragBatchEntities = options.entities;
      this.#dragBatchSelectedEntityIds = options.selectedEntityIds;
      this.#dragBatchEntityVersion = options.entityVersion;
      this.#dragBatchGeometryVersion = options.geometryVersion;
      this.#dragBatchSelectionVersion = options.selectionVersion;
      this.#dragBatchDebugMode = options.debugMode;
      return;
    }
    if (options.geometryVersion === this.#dragBatchGeometryVersion) {
      this.#clearPreparedFullSceneDrag();
    }
  }

  #tryPatchCommittedFullSceneDrag(
    options: PrepareEntityDrawItemsOptions,
  ): FullSceneBatchKey | null {
    const selectedEntityIds = this.#dragBatchSelectedEntityIds;
    if (!selectedEntityIds || options.geometryVersion === this.#dragBatchGeometryVersion) {
      return null;
    }

    const previousKey = this.#activeFullSceneBatchKey;
    const canPatch =
      previousKey !== null &&
      this.#dragBatchEntities === options.entities &&
      this.#activeFullSceneSelectedEntityIds === selectedEntityIds &&
      selectedEntityIds === options.selectedEntityIds &&
      this.#dragBatchEntityVersion === options.entityVersion &&
      this.#dragBatchGeometryVersion + 1 === options.geometryVersion &&
      this.#dragBatchSelectionVersion === options.selectionVersion &&
      this.#dragBatchDebugMode === options.debugMode &&
      !options.dragVisual.isDragPhase &&
      options.dragVisual.offset.x === 0 &&
      options.dragVisual.offset.y === 0 &&
      !options.actionLayer.active &&
      options.actionLayer.blurIntensity <= 0.01 &&
      !options.hasCanvasCallouts;
    this.#clearPreparedFullSceneDrag();
    if (!canPatch) return null;

    const patches = this.#fullSceneInstancePatches;
    patches.length = 0;
    for (const entityId of selectedEntityIds) {
      const index = this.#fullSceneEntityIndices.get(entityId);
      const entity = index === undefined ? undefined : options.entities[index];
      if (index === undefined || !entity || entity.id !== entityId) {
        patches.length = 0;
        return null;
      }
      patches.push({ index, entity, isSelected: true });
    }

    const key: FullSceneBatchKey = {
      ...previousKey,
      geometryVersion: options.geometryVersion,
      textureCacheRevision: this.#texturePipeline.textureCacheRevision,
    };
    if (!this.#compositionPass.patchFullSceneInstances(key, patches)) {
      patches.length = 0;
      return null;
    }

    if (key.texture) this.#fullSceneBatchKey = key;
    else this.#mixedFullSceneBatchKey = key;
    const plan = this.#mixedFullScenePlan;
    if (
      plan &&
      plan.entities === options.entities &&
      plan.geometryVersion + 1 === options.geometryVersion
    ) {
      plan.geometryVersion = options.geometryVersion;
    }
    this.#activeFullSceneBatchKey = key;
    patches.length = 0;
    return key;
  }

  #clearPreparedFullSceneDrag(): void {
    this.#dragBatchEntities = null;
    this.#dragBatchSelectedEntityIds = null;
    this.#dragBatchEntityVersion = -1;
    this.#dragBatchGeometryVersion = -1;
    this.#dragBatchSelectionVersion = -1;
  }

  #prepareMixedFullSceneBatch(
    options: PrepareEntityDrawItemsOptions,
    allowBuild: boolean,
  ): FullSceneBatchKey | null {
    const {
      entities,
      entitySpatialIndex,
      entityVersion,
      geometryVersion,
      selectionVersion,
      viewport,
      width,
      height,
      selectedEntityIds,
      debugMode,
    } = options;
    const key = this.#mixedFullSceneBatchKey ?? {
      entityVersion,
      geometryVersion,
      selectionVersion,
      debugMode,
      singleSelectedIndex: -1,
      renderWidth: 0,
      renderHeight: 0,
      texture: null,
      textureCacheRevision: this.#texturePipeline.textureCacheRevision,
      instanceCount: entities.length,
    };
    this.#mixedFullSceneBatchKey = key;
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
    key.textureCacheRevision = this.#texturePipeline.textureCacheRevision;
    key.instanceCount = entities.length;
    if (this.#hasResidentFullSceneBatch(key)) {
      this.#activeFullSceneBatchKey = key;
      return key;
    }
    if (!allowBuild) return null;

    if (
      this.#mixedIneligibleEntityVersion === entityVersion &&
      this.#mixedIneligibleEntities === entities
    ) {
      return null;
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
    this.#admissionVisibleEntities = visibleEntities;
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

    let plan = this.#mixedFullScenePlan;
    if (!this.#isMixedFullScenePlanStructurallyCurrent(plan, options)) {
      plan = this.#buildMixedFullScenePlan(options);
      if (!plan) return null;
    } else if (!this.#areMixedFullScenePlanTexturesCurrent(plan, options)) {
      if (!this.#refreshMixedFullScenePlanTextures(plan, options)) return null;
    }

    const visibleTextureRunCount = countVisibleTextureRuns(visibleEntities, plan.runByEntity);
    if (visibleTextureRunCount < 0) {
      this.#mixedFullScenePlan = null;
      return null;
    }

    // Compare run density rather than absolute run counts so a low-entropy full
    // plan is not rejected merely because some of its runs are outside the
    // viewport. Equal or higher offscreen entropy keeps spatial culling. Retain
    // rejected plans because viewport motion changes only the visible run count;
    // rebuilding the same full plan on every admission attempt would remain O(N).
    if (
      plan.fullTextureRunCount > visibleTextureRunCount &&
      plan.fullTextureRunCount * visibleEntities.length >= visibleTextureRunCount * entities.length
    ) {
      return null;
    }

    for (const texture of plan.textures) {
      if (this.#texturePipeline.pinCachedTexture(texture)) continue;
      this.#mixedFullScenePlan = null;
      return null;
    }

    key.textureCacheRevision = this.#texturePipeline.textureCacheRevision;
    if (!this.#compositionPass.restoreFullSceneBatch(key, plan.runs)) {
      this.#compositionPass.prepareMixedFullSceneBatch({
        ...key,
        entities,
        selectedEntityIds,
        textureRanges: plan.runs,
      });
    }
    this.#rememberFullSceneBatch(key, selectedEntityIds);
    return key;
  }

  #isMixedFullScenePlanStructurallyCurrent(
    plan: MixedFullScenePlan | null,
    options: PrepareEntityDrawItemsOptions,
  ): plan is MixedFullScenePlan {
    return (
      plan !== null &&
      plan.entities === options.entities &&
      plan.entityVersion === options.entityVersion &&
      plan.geometryVersion === options.geometryVersion &&
      plan.selectionVersion === options.selectionVersion &&
      plan.debugMode === options.debugMode
    );
  }

  #areMixedFullScenePlanTexturesCurrent(
    plan: MixedFullScenePlan,
    options: PrepareEntityDrawItemsOptions,
  ): boolean {
    return (
      plan.viewportZoom === options.viewport.zoom &&
      plan.devicePixelRatio === options.devicePixelRatio &&
      plan.textureCacheRevision === this.#texturePipeline.textureCacheRevision
    );
  }

  #refreshMixedFullScenePlanTextures(
    plan: MixedFullScenePlan,
    options: PrepareEntityDrawItemsOptions,
  ): boolean {
    const textures = plan.textures;
    textures.length = 0;
    const seenTextures = new Set<GPUTexture>();
    let previousTexture: GPUTexture | null = null;
    let fullTextureRunCount = 0;

    for (const run of plan.runs) {
      const desiredRenderSize = getEntityRenderSize(
        run.representative,
        options.viewport,
        options.devicePixelRatio,
        this.#desiredRenderSize,
      );
      let source = this.#texturePipeline.getReusableStaticCompositionSource(
        run.representative,
        desiredRenderSize,
        false,
      );
      if (!source) {
        const renderSize = this.#texturePipeline.resolveRenderSize(
          run.representative,
          desiredRenderSize,
          this.#resolvedRenderSize,
        );
        if (!renderSize) return false;
        source = this.#texturePipeline.renderEntityToTexture(
          run.representative,
          options.encoder,
          renderSize,
        );
      }
      if (source?.kind !== "texture") return false;

      run.texture = source.texture;
      if (source.texture !== previousTexture) {
        previousTexture = source.texture;
        fullTextureRunCount++;
      }
      if (!seenTextures.has(source.texture)) {
        seenTextures.add(source.texture);
        textures.push(source.texture);
      }
    }

    plan.viewportZoom = options.viewport.zoom;
    plan.devicePixelRatio = options.devicePixelRatio;
    plan.textureCacheRevision = this.#texturePipeline.textureCacheRevision;
    plan.fullTextureRunCount = fullTextureRunCount;
    return true;
  }

  #buildMixedFullScenePlan(options: PrepareEntityDrawItemsOptions): MixedFullScenePlan | null {
    const {
      entities,
      entityVersion,
      geometryVersion,
      selectionVersion,
      viewport,
      devicePixelRatio,
      encoder,
      debugMode,
    } = options;
    const runs: MixedFullSceneTextureRun[] = [];
    const runByEntity = new WeakMap<ShaderCanvasEntity, MixedFullSceneTextureRun>();
    const textures: GPUTexture[] = [];
    const seenTextures = new Set<GPUTexture>();
    let fullTextureRunCount = 0;
    let previousTexture: GPUTexture | null = null;
    let previousSizedEntity: ShaderCanvasEntity | null = null;
    let previousDesiredWidth = 0;
    let previousDesiredHeight = 0;

    for (let index = 0; index < entities.length; index++) {
      const entity = entities[index]!;
      if (
        entity.mediaSource.type !== MediaType.image ||
        this.#texturePipeline.needsContinuousRenderForEntity(entity)
      ) {
        this.#mixedFullScenePlan = null;
        this.#mixedIneligibleEntityVersion = entityVersion;
        this.#mixedIneligibleEntities = entities;
        return null;
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
      let source = this.#texturePipeline.getReusableStaticCompositionSource(
        entity,
        desiredRenderSize,
        false,
      );
      if (!source) {
        const renderSize = this.#texturePipeline.resolveRenderSize(
          entity,
          desiredRenderSize,
          this.#resolvedRenderSize,
        );
        if (!renderSize) {
          this.#mixedFullScenePlan = null;
          return null;
        }
        source = this.#texturePipeline.renderEntityToTexture(entity, encoder, renderSize);
      }
      if (source?.kind !== "texture") {
        this.#mixedFullScenePlan = null;
        return null;
      }

      if (source.texture !== previousTexture) {
        previousTexture = source.texture;
        fullTextureRunCount++;
      }
      let run = runs.at(-1);
      if (!run || run.texture !== source.texture || !sameProjectedSize) {
        run = {
          representative: entity,
          texture: source.texture,
          firstInstance: index,
          instanceCount: 1,
        };
        runs.push(run);
      } else {
        run.instanceCount++;
      }
      runByEntity.set(entity, run);
      if (!seenTextures.has(source.texture)) {
        seenTextures.add(source.texture);
        textures.push(source.texture);
      }
    }

    const plan: MixedFullScenePlan = {
      entities,
      entityVersion,
      geometryVersion,
      selectionVersion,
      debugMode,
      viewportZoom: viewport.zoom,
      devicePixelRatio,
      textureCacheRevision: this.#texturePipeline.textureCacheRevision,
      fullTextureRunCount,
      runs,
      runByEntity,
      textures,
    };
    this.#mixedFullScenePlan = plan;
    this.#mixedIneligibleEntityVersion = -1;
    this.#mixedIneligibleEntities = null;
    return plan;
  }

  #tryPatchFullSceneBatch(options: PrepareEntityDrawItemsOptions): FullSceneBatchKey | null {
    const previousKey = this.#activeFullSceneBatchKey;
    const dirtyEntityIds = options.dirtyEntityIds;
    if (
      !previousKey ||
      options.mixedFullSceneBatchMode === "disabled" ||
      dirtyEntityIds.size === 0 ||
      previousKey.entityVersion === options.entityVersion ||
      previousKey.geometryVersion !== options.geometryVersion ||
      this.#activeFullSceneSelectedEntityIds !== options.selectedEntityIds ||
      previousKey.instanceCount !== options.entities.length ||
      this.#fullSceneEntityIndices.size !== options.entities.length ||
      !this.#pinCachedFullSceneTextures()
    ) {
      return null;
    }

    const patches = this.#fullScenePatches;
    patches.length = 0;
    for (const entityId of dirtyEntityIds) {
      const index = this.#fullSceneEntityIndices.get(entityId);
      const entity = index === undefined ? undefined : options.entities[index];
      if (
        index === undefined ||
        !entity ||
        entity.id !== entityId ||
        entity.mediaSource.type !== MediaType.image ||
        this.#texturePipeline.needsContinuousRenderForEntity(entity)
      ) {
        patches.length = 0;
        return null;
      }

      const desiredRenderSize = getEntityRenderSize(
        entity,
        options.viewport,
        options.devicePixelRatio,
        this.#desiredRenderSize,
      );
      let source = this.#texturePipeline.getReusableStaticCompositionSource(
        entity,
        desiredRenderSize,
        false,
      );
      if (!source) {
        const renderSize = this.#texturePipeline.resolveRenderSize(
          entity,
          desiredRenderSize,
          this.#resolvedRenderSize,
        );
        if (!renderSize) {
          patches.length = 0;
          return null;
        }
        source = this.#texturePipeline.renderEntityToTexture(entity, options.encoder, renderSize);
      }
      if (source?.kind !== "texture") {
        patches.length = 0;
        return null;
      }
      patches.push({
        index,
        entity,
        texture: source.texture,
        isSelected: options.selectedEntityIds.has(entity.id),
      });
    }
    patches.sort((left, right) => left.index - right.index);

    const key = this.#mixedFullSceneBatchKey ?? {
      entityVersion: options.entityVersion,
      geometryVersion: options.geometryVersion,
      selectionVersion: options.selectionVersion,
      debugMode: options.debugMode,
      singleSelectedIndex: -1,
      renderWidth: 0,
      renderHeight: 0,
      texture: null,
      textureCacheRevision: this.#texturePipeline.textureCacheRevision,
      instanceCount: options.entities.length,
    };
    this.#mixedFullSceneBatchKey = key;
    key.entityVersion = options.entityVersion;
    key.geometryVersion = options.geometryVersion;
    key.selectionVersion = options.selectionVersion;
    key.debugMode = options.debugMode;
    key.singleSelectedIndex = this.#getSingleSelectedIndex(
      options.entities,
      options.selectedEntityIds,
      options.selectionVersion,
      options.entityVersion,
      options.geometryVersion,
    );
    key.renderWidth = 0;
    key.renderHeight = 0;
    key.texture = null;
    key.textureCacheRevision = this.#texturePipeline.textureCacheRevision;
    key.instanceCount = options.entities.length;
    if (!this.#compositionPass.patchMixedFullSceneBatch(key, patches)) {
      patches.length = 0;
      return null;
    }

    this.#activeFullSceneBatchKey = key;
    this.#activeFullSceneSelectedEntityIds = options.selectedEntityIds;
    this.#homogeneousEntityVersion = options.entityVersion;
    this.#homogeneousEntities = options.entities;
    this.#homogeneousRepresentative = null;
    patches.length = 0;
    return key;
  }

  #rememberFullSceneBatch(key: FullSceneBatchKey, selectedEntityIds: ReadonlySet<string>): void {
    this.#activeFullSceneBatchKey = key;
    this.#activeFullSceneSelectedEntityIds = selectedEntityIds;
  }

  #hasResidentFullSceneBatch(key: FullSceneBatchKey): boolean {
    return this.#compositionPass.hasFullSceneBatch(key) && this.#pinCachedFullSceneTextures();
  }

  #pinCachedFullSceneTextures(): boolean {
    let resident = true;
    const hasBatch = this.#compositionPass.visitCachedFullSceneTextures((texture) => {
      if (!this.#texturePipeline.pinCachedTexture(texture)) resident = false;
    });
    return hasBatch && resident;
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
    dirtyEntityIds: ReadonlySet<string>,
  ): ShaderCanvasEntity | null {
    if (
      this.#homogeneousEntityVersion === entityVersion &&
      this.#homogeneousEntities === entities
    ) {
      return this.#homogeneousRepresentative;
    }

    if (
      this.#homogeneousEntityVersion >= 0 &&
      this.#homogeneousEntities === entities &&
      this.#homogeneousEntityCount === entities.length &&
      dirtyEntityIds.size > 0
    ) {
      const previousRepresentative = this.#homogeneousRepresentative;
      this.#homogeneousEntityVersion = entityVersion;
      if (!previousRepresentative) return null;
      if (dirtyEntityIds.size === entities.length) {
        return this.#scanHomogeneousRepresentative(entities, entityVersion);
      }

      let baseline = previousRepresentative;
      if (dirtyEntityIds.has(baseline.id)) {
        const unchanged = entities.find((entity) => !dirtyEntityIds.has(entity.id));
        if (!unchanged) return this.#scanHomogeneousRepresentative(entities, entityVersion);
        baseline = unchanged;
      }
      const asset =
        baseline.mediaSource.type === MediaType.image ? baseline.mediaSource.asset : null;
      for (const entityId of dirtyEntityIds) {
        const index = this.#fullSceneEntityIndices.get(entityId);
        const entity = index === undefined ? undefined : entities[index];
        if (!entity || entity.id !== entityId || !isFullSceneEquivalent(entity, baseline, asset)) {
          this.#homogeneousRepresentative = null;
          return null;
        }
      }
      this.#homogeneousRepresentative = baseline;
      return baseline;
    }

    return this.#scanHomogeneousRepresentative(entities, entityVersion);
  }

  #scanHomogeneousRepresentative(
    entities: readonly ShaderCanvasEntity[],
    entityVersion: number,
  ): ShaderCanvasEntity | null {
    this.#homogeneousEntityVersion = entityVersion;
    this.#homogeneousEntityCount = entities.length;
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
      this.#singleSelectionGeometryVersion === geometryVersion &&
      this.#singleSelectionIds === selectedEntityIds
    ) {
      return this.#singleSelectedIndex;
    }

    this.#singleSelectionVersion = selectionVersion;
    this.#singleSelectionEntityVersion = entityVersion;
    this.#singleSelectionGeometryVersion = geometryVersion;
    this.#singleSelectionIds = selectedEntityIds;
    this.#singleSelectedIndex = -1;
    if (selectedEntityIds.size !== 1) return -1;

    const selectedId = selectedEntityIds.values().next().value;
    const cachedIndex = selectedId ? this.#fullSceneEntityIndices.get(selectedId) : undefined;
    if (cachedIndex !== undefined && entities[cachedIndex]?.id === selectedId) {
      this.#singleSelectedIndex = cachedIndex;
      return cachedIndex;
    }
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
    haveEquivalentShaderParams(entity.shaderParams, representative.shaderParams)
  );
}

function countVisibleTextureRuns(
  visibleEntities: readonly ShaderCanvasEntity[],
  runByEntity: WeakMap<ShaderCanvasEntity, MixedFullSceneTextureRun>,
): number {
  let runCount = 0;
  let previousTexture: GPUTexture | null = null;
  for (const entity of visibleEntities) {
    const texture = runByEntity.get(entity)?.texture;
    if (!texture) return -1;
    if (texture === previousTexture) continue;
    previousTexture = texture;
    runCount++;
  }
  return runCount;
}
