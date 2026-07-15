import { config } from "#config";
import type { ActionLayerRenderState, DragSelectMode, DragVisualRenderState } from "#engine";
import { getViewportWorldBounds } from "#lib/canvas-math.ts";
import type { EntitySpatialIndex } from "#lib/entity-spatial-index.ts";
import { tracePerformancePhase } from "#lib/performance-tracing.ts";
import { MediaType, type Bounds, type ShaderCanvasEntity, type Viewport } from "#types/canvas.ts";
import type {
  CompositionDrawItem,
  CompositionPass,
  FullSceneBatchPatch,
  FullSceneBatchKey,
  PrepareCompositionItemOptions,
} from "./composition-pass.ts";
import type { EntityTexturePipeline } from "./entity-texture-pipeline.ts";
import { getEntityRenderSize } from "./entity-render-size.ts";

const MAX_MIXED_FULL_SCENE_TEXTURE_RUNS = 256;
const MAX_INCREMENTAL_FULL_SCENE_PATCHES = 32;
type MixedFullSceneBatchMode = "reuse" | "refresh" | "disabled";

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

export interface PreparedEntityDrawItems {
  entityDrawItems: CompositionDrawItem[];
  actionLayerDrawItems: CompositionDrawItem[];
  fullSceneBatch: FullSceneBatchKey | null;
  singleSelectedDrawItem: CompositionDrawItem | null;
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
  readonly #fullSceneDrawItems: CompositionDrawItem[] = [];
  readonly #fullScenePatches: FullSceneBatchPatch[] = [];
  readonly #fullSceneEntityIndices = new Map<string, number>();
  readonly #prepared: PreparedEntityDrawItems = {
    entityDrawItems: this.#entityDrawItems,
    actionLayerDrawItems: this.#actionLayerDrawItems,
    fullSceneBatch: null,
    singleSelectedDrawItem: null,
    hasAnimatingContent: false,
  };
  #fullSceneBatchKey: FullSceneBatchKey | null = null;
  #mixedFullSceneBatchKey: FullSceneBatchKey | null = null;
  #activeFullSceneBatchKey: FullSceneBatchKey | null = null;
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
    this.#rememberFullSceneLayout(entities, key);
    this.#rememberSnapshotSource(representative, entityVersion, renderWidth, renderHeight);
    return key;
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
      devicePixelRatio,
      encoder,
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

    const items = this.#fullSceneDrawItems;
    items.length = 0;
    const representative = entities[0];
    if (!representative || representative.mediaSource.type !== MediaType.image) return null;
    let previousTexture: GPUTexture | null = null;
    let textureRunCount = 0;
    let previousSizedEntity: ShaderCanvasEntity | null = null;
    let previousDesiredWidth = 0;
    let previousDesiredHeight = 0;
    for (const entity of entities) {
      if (
        entity.mediaSource.type !== MediaType.image ||
        this.#texturePipeline.needsContinuousRenderForEntity(entity)
      ) {
        items.length = 0;
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
          items.length = 0;
          return null;
        }
        source = this.#texturePipeline.renderEntityToTexture(entity, encoder, renderSize);
      }
      if (source?.kind !== "texture") {
        items.length = 0;
        return null;
      }
      if (source.texture !== previousTexture) {
        previousTexture = source.texture;
        textureRunCount++;
        if (textureRunCount > MAX_MIXED_FULL_SCENE_TEXTURE_RUNS) {
          items.length = 0;
          return null;
        }
      }
      items.push(
        this.#compositionPass.prepareDrawItem({
          entity,
          source,
          isSelected: selectedEntityIds.has(entity.id),
          debugMode,
          positionOffsetX: 0,
          positionOffsetY: 0,
          visualScale: 1,
        }),
      );
    }

    key.textureCacheRevision = this.#texturePipeline.textureCacheRevision;
    this.#compositionPass.prepareMixedFullSceneBatch(key, items);
    this.#rememberFullSceneLayout(entities, key);
    return key;
  }

  #tryPatchFullSceneBatch(options: PrepareEntityDrawItemsOptions): FullSceneBatchKey | null {
    const previousKey = this.#activeFullSceneBatchKey;
    const dirtyEntityIds = options.dirtyEntityIds;
    if (
      !previousKey ||
      options.mixedFullSceneBatchMode === "disabled" ||
      dirtyEntityIds.size === 0 ||
      dirtyEntityIds.size > MAX_INCREMENTAL_FULL_SCENE_PATCHES ||
      previousKey.entityVersion === options.entityVersion ||
      previousKey.geometryVersion !== options.geometryVersion ||
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
        item: this.#compositionPass.prepareDrawItem({
          entity,
          source,
          isSelected: options.selectedEntityIds.has(entity.id),
          debugMode: options.debugMode,
          positionOffsetX: 0,
          positionOffsetY: 0,
          visualScale: 1,
        }),
      });
    }

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
    if (
      !this.#compositionPass.patchMixedFullSceneBatch(
        key,
        patches,
        MAX_MIXED_FULL_SCENE_TEXTURE_RUNS,
      )
    ) {
      patches.length = 0;
      return null;
    }

    this.#activeFullSceneBatchKey = key;
    this.#homogeneousEntityVersion = options.entityVersion;
    this.#homogeneousEntities = options.entities;
    this.#homogeneousRepresentative = null;
    patches.length = 0;
    return key;
  }

  #rememberFullSceneLayout(entities: readonly ShaderCanvasEntity[], key: FullSceneBatchKey): void {
    this.#fullSceneEntityIndices.clear();
    for (let index = 0; index < entities.length; index++) {
      this.#fullSceneEntityIndices.set(entities[index]!.id, index);
    }
    this.#activeFullSceneBatchKey = key;
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
      dirtyEntityIds.size > 0 &&
      dirtyEntityIds.size <= MAX_INCREMENTAL_FULL_SCENE_PATCHES
    ) {
      const previousRepresentative = this.#homogeneousRepresentative;
      this.#homogeneousEntityVersion = entityVersion;
      if (!previousRepresentative) return null;

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
    this.#fullSceneEntityIndices.clear();
    for (let index = 0; index < entities.length; index++) {
      this.#fullSceneEntityIndices.set(entities[index]!.id, index);
    }

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
