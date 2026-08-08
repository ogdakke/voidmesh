import { logger, LogLevel, type Logger } from "#lib/client.logger.ts";
import { Store } from "#lib/store.ts";
import { getCommonFeatures, paramVisibilityRules, shaderFeatures } from "#config";
import {
  type Viewport,
  type CanvasCallout,
  type ShaderCanvasEntity,
  type Point,
  type Bounds,
  type ShaderParams,
  type ParamPaths,
  type GetParamByPath,
  type SelectionState,
  type ShaderType,
  MediaType,
} from "#types/canvas.ts";
import { getFrameAtTime } from "#lib/gif-decoder.ts";
import { completeOnboardingStarterSelectionFromEvent } from "#lib/onboarding/onboarding-runtime.ts";
import { EntitySpatialIndex } from "#lib/entity-spatial-index.ts";
import { CanvasLensing } from "#types/enums.ts";

export type DragSelectMode = "replace" | "additive" | "subtractive";

export interface CanvasState {
  // Core state
  viewport: Viewport;
  entities: Map<string, ShaderCanvasEntity>;
  /** Sorted list of entity IDs by their z-index (ascending) */
  entityIds: string[];

  // Interaction state (transient, not persisted)
  /** Selected entity IDs (multi-select support) */
  selectedEntityIds: Set<string>;
  contextOpenEntityId: string | null;
  /** Multi-select mode: tapping toggles selection, empty space tap is ignored */
  multiSelectMode: boolean;

  // Debug mode - shows hitbox borders
  debugMode: boolean;
  // Snap-to-grid mode - entities snap to visible grid during drag
  snapToGrid: boolean;
  // Fancy deletions - disintegration shader animation on entity removal
  fancyDelete: boolean;
  // Haptic feedback on touch interactions
  haptics: boolean;
  // Full-canvas edge lensing effect intensity
  canvasLensing: CanvasLensing;

  // Dirty flags for optimization
  viewportDirty: boolean;
  entitiesDirty: Set<string>;
  geometryDirty: boolean;
  selectionDirty: boolean;
  containerSizeDirty: boolean;
  canvasCalloutsDirty: boolean;

  // Frame counter for debugging
  frameCount: number;

  // Version counters for React change detection (selective subscriptions)
  version: number; // Overall version (for backward compat)
  entityVersion: number; // Entity membership/reference/animation classification changes
  geometryVersion: number; // Imperative position changes that do not notify React
  viewportVersion: number; // Incremented only on viewport changes
  selectionVersion: number; // Incremented on selection/entity changes
  preferencesVersion: number; // Incremented on preference changes
  playbackVersion: number; // Incremented on video time updates (lightweight, isolated)
  dragVersion: number; // Incremented on entity drag state changes (mobile long-press drag)

  // Mobile entity drag state (transient)
  /** Whether a mobile long-press entity drag is currently active */
  entityDragActive: boolean;

  // Mobile action layer state (transient)
  /** Whether the mobile action layer (radial context menu) is active */
  actionLayerActive: boolean;
  /** Entity IDs targeted by the action layer */
  actionLayerEntityIds: ReadonlySet<string>;
  /** Touch origin in CSS viewport coordinates (raw finger position) */
  actionLayerTouchOrigin: { x: number; y: number };
  /** Version counter for action layer state changes */
  actionLayerVersion: number;

  // Canvas-rendered instructional callouts (transient, not persisted)
  canvasCallouts: readonly CanvasCallout[];
}

export interface CanvasEntityUpdate {
  id: string;
  updates: Partial<ShaderCanvasEntity>;
}

// Snapshot types for selective subscriptions
export interface ViewportSnapshot {
  viewport: Viewport;
  version: number;
}

export interface SelectionSnapshot {
  selectedEntityIds: ReadonlySet<string>;
  contextOpenEntityId: string | null;
  entities: Map<string, ShaderCanvasEntity>;
  multiSelectMode: boolean;
  snapToGrid: boolean;
  fancyDelete: boolean;
  haptics: boolean;
  version: number;
}

export interface DragSnapshot {
  entityDragActive: boolean;
  version: number;
}

export interface PreferencesSnapshot {
  snapToGrid: boolean;
  fancyDelete: boolean;
  haptics: boolean;
  canvasLensing: CanvasLensing;
  version: number;
}

export interface ActionLayerSnapshot {
  active: boolean;
  entityIds: ReadonlySet<string>;
  touchOrigin: { x: number; y: number };
  version: number;
}

export interface PlaybackSnapshot {
  entityId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  version: number;
}

export interface SelectedVideoAudioSnapshot {
  entityId: string | null;
  canToggleMuted: boolean;
  muted: boolean;
  version: number;
}

export interface ActionLayerRenderState {
  /** Whether the action layer is active or dismiss/transition animation is still visible. */
  active: boolean;
  /** Entity IDs to keep sharp and offset while the action layer is rendering. */
  entityIds: ReadonlySet<string>;
  /** Rubber-band offset in CSS pixels. */
  entityOffset: Point;
  /** Current background blur/dim intensity, 0..1. */
  blurIntensity: number;
}

export interface DragVisualRenderState {
  /** Whether any drag visual animation is active. */
  active: boolean;
  /** Whether the active visual is in the dragging phase. */
  isDragPhase: boolean;
  /** Entity IDs receiving the shared visual scale. */
  entityIds: ReadonlySet<string>;
  /** Shared scale for active drag-visual entities. */
  scale: number;
  /** Shared world-space translation applied to the selected drag group. */
  offset: Point;
  /** Whether every visual target is exactly the current selection. */
  appliesToSelection: boolean;
}

export interface DisintegrationRenderOverlay {
  id: string;
  startTime: number;
  dissolveDuration: number;
  duration: number;
  seed: number;
  position: Point;
  size: { width: number; height: number };
  rotation: number;
  progress: number;
  elapsedSeconds: number;
}

export interface DisintegrationRenderState {
  overlays: readonly DisintegrationRenderOverlay[];
}

export interface RenderState {
  viewport: Viewport;
  entities: ShaderCanvasEntity[];
  /** Stable entity ID to sorted render-array index lookup for the current entity version. */
  entityIndices: ReadonlyMap<string, number>;
  entitySpatialIndex: EntitySpatialIndex;
  entityVersion: number;
  geometryVersion: number;
  selectionVersion: number;
  /** Entity references changed since the previous render; valid until dirty flags clear. */
  dirtyEntityIds: ReadonlySet<string>;
  selectedEntityIds: ReadonlySet<string>;
  debugMode: boolean;
  debugView: "none" | "alpha" | "spatial" | "all";
  dirty: boolean;
  canvasCallouts: readonly CanvasCallout[];
  /** Drag-select rectangle bounds in world coordinates (null if not active) */
  dragSelectBounds: Bounds | null;
  /** GPU drag-selection operation, enabled after the gesture crosses the click threshold. */
  dragSelectMode: DragSelectMode | null;
  /** Multi-select bounding box in world coordinates (null if < 2 entities selected) */
  multiSelectBounds: Bounds | null;
  actionLayer: ActionLayerRenderState;
  dragVisual: DragVisualRenderState;
  disintegration: DisintegrationRenderState;
}

export interface ParamResult<T> {
  value: T;
  isMixed: boolean;
  /** Whether the param is supported by all selected shader types */
  isSupported: boolean;
  /** All distinct values across selected entities (for showing mixed state details) */
  values: Set<NonNullable<T>>;
}

/**
 * State Access Guidelines
 *
 * - getState(): Direct state access for game loop. NO ALLOCATIONS.
 * - getSelectionSnapshot(): For React components needing selection/entity state.
 * - getViewportSnapshot(): For React components needing viewport state.
 * - getPlaybackSnapshot(): For React components needing playback time.
 *
 * React snapshots create new objects only when their version changes,
 * enabling useSyncExternalStore change detection without hot-path allocations.
 */
export class CanvasStore extends Store<CanvasState> {
  #logger: Logger;
  #viewportListeners = new Set<() => void>();
  #selectedEntitiesCache: ShaderCanvasEntity[] = [];
  #selectedEntitiesVersion = -1;
  #selectionStateCache: { entities: ShaderCanvasEntity[]; value: SelectionState } | null = null;
  #paramResultCache = new Map<
    string,
    { entities: ShaderCanvasEntity[]; value: ParamResult<unknown> }
  >();
  readonly #renderEntities: ShaderCanvasEntity[] = [];
  readonly #renderEntityIndices = new Map<string, number>();
  #entitySpatialIndex = new EntitySpatialIndex();
  #renderEntitiesVersion = -1;
  readonly #renderViewport: Viewport = { offset: { x: 0, y: 0 }, zoom: 1 };
  readonly #renderActionLayer: ActionLayerRenderState = {
    active: false,
    entityIds: new Set<string>(),
    entityOffset: { x: 0, y: 0 },
    blurIntensity: 0,
  };
  readonly #renderDragVisual: DragVisualRenderState = {
    active: false,
    isDragPhase: false,
    entityIds: new Set<string>(),
    scale: 1,
    offset: { x: 0, y: 0 },
    appliesToSelection: false,
  };
  readonly #transientEntityDragOffset: Point = { x: 0, y: 0 };
  readonly #renderDisintegration: DisintegrationRenderState = { overlays: [] };
  readonly #renderState: RenderState = {
    viewport: this.#renderViewport,
    entities: this.#renderEntities,
    entityIndices: this.#renderEntityIndices,
    entitySpatialIndex: this.#entitySpatialIndex,
    entityVersion: 0,
    geometryVersion: 0,
    selectionVersion: 0,
    dirtyEntityIds: new Set<string>(),
    selectedEntityIds: new Set<string>(),
    debugMode: false,
    debugView: "none",
    dirty: false,
    canvasCallouts: [],
    dragSelectBounds: null,
    dragSelectMode: null,
    multiSelectBounds: null,
    actionLayer: this.#renderActionLayer,
    dragVisual: this.#renderDragVisual,
    disintegration: this.#renderDisintegration,
  };

  /** Throttle interval for passive playback notifications (hard cap at 60fps) */
  static readonly #PLAYBACK_NOTIFY_INTERVAL_MS = 16.67;
  #lastPlaybackNotifyTime = 0;

  // Stable snapshot getters for useSyncExternalStore
  readonly getViewportSnapshot: () => ViewportSnapshot;
  readonly getSelectionSnapshot: () => SelectionSnapshot;
  readonly getSelectedEntityIdsSnapshot: () => ReadonlySet<string>;
  readonly getSelectedEntitySnapshot: () => ShaderCanvasEntity | undefined;
  readonly getSelectedEntitiesSnapshot: () => ShaderCanvasEntity[];
  readonly getEntityCountSnapshot: () => number;
  readonly getHasEntitiesSnapshot: () => boolean;
  readonly getMultiSelectModeSnapshot: () => boolean;
  readonly getContextOpenEntityIdSnapshot: () => string | null;
  readonly getPreferencesSnapshot: () => PreferencesSnapshot;
  readonly getPlaybackSnapshot: () => PlaybackSnapshot;
  readonly getSelectedVideoAudioSnapshot: () => SelectedVideoAudioSnapshot;
  readonly getDragSnapshot: () => DragSnapshot;
  readonly getActionLayerSnapshot: () => ActionLayerSnapshot;

  constructor() {
    super({
      viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
      entities: new Map(),
      entityIds: [],
      selectedEntityIds: new Set(),
      contextOpenEntityId: null,
      multiSelectMode: false,
      debugMode: false,
      snapToGrid: false,
      fancyDelete: true,
      haptics: true,
      canvasLensing: CanvasLensing.off,
      viewportDirty: false,
      entitiesDirty: new Set(),
      geometryDirty: false,
      selectionDirty: false,
      containerSizeDirty: false,
      canvasCalloutsDirty: false,
      frameCount: 0,
      version: 0,
      entityVersion: 0,
      geometryVersion: 0,
      viewportVersion: 0,
      selectionVersion: 0,
      preferencesVersion: 0,
      playbackVersion: 0,
      dragVersion: 0,
      entityDragActive: false,
      actionLayerActive: false,
      actionLayerEntityIds: new Set(),
      actionLayerTouchOrigin: { x: 0, y: 0 },
      actionLayerVersion: 0,
      canvasCallouts: [],
    });

    this.#logger = logger;

    // Create stable snapshot getters via base class
    this.getViewportSnapshot = this.createSnapshot("viewportVersion", (s) => ({
      viewport: { ...s.viewport, offset: { ...s.viewport.offset } },
      version: s.viewportVersion,
    }));

    this.getSelectionSnapshot = this.createSnapshot("selectionVersion", (s) => ({
      selectedEntityIds: s.selectedEntityIds,
      contextOpenEntityId: s.contextOpenEntityId,
      entities: s.entities,
      multiSelectMode: s.multiSelectMode,
      snapToGrid: s.snapToGrid,
      fancyDelete: s.fancyDelete,
      haptics: s.haptics,
      version: s.selectionVersion,
    }));

    this.getSelectedEntityIdsSnapshot = this.createSnapshot(
      "selectionVersion",
      (s) => s.selectedEntityIds,
    );

    this.getSelectedEntitySnapshot = this.createSnapshot("selectionVersion", () =>
      this.getSelectedEntity(),
    );

    this.getSelectedEntitiesSnapshot = this.createSnapshot("selectionVersion", () =>
      this.getComputed("selectedEntities", "selectionVersion", () => this.getSelectedEntities()),
    );

    this.getEntityCountSnapshot = this.createSnapshot("selectionVersion", (s) => s.entities.size);

    this.getHasEntitiesSnapshot = this.createSnapshot(
      "selectionVersion",
      (s) => s.entities.size > 0,
    );

    this.getMultiSelectModeSnapshot = this.createSnapshot(
      "selectionVersion",
      (s) => s.multiSelectMode,
    );

    this.getContextOpenEntityIdSnapshot = this.createSnapshot(
      "selectionVersion",
      (s) => s.contextOpenEntityId,
    );

    this.getPreferencesSnapshot = this.createSnapshot("preferencesVersion", (s) => ({
      snapToGrid: s.snapToGrid,
      fancyDelete: s.fancyDelete,
      haptics: s.haptics,
      canvasLensing: s.canvasLensing,
      version: s.preferencesVersion,
    }));

    this.getPlaybackSnapshot = this.createSnapshot("playbackVersion", (s) => {
      const selectedEntity = this.getSelectedEntity();

      // Handle video entities
      if (selectedEntity?.mediaSource.type === MediaType.video) {
        const video = selectedEntity.mediaSource.videoElement;
        return {
          entityId: selectedEntity.id,
          currentTime: selectedEntity.playback?.currentTime ?? 0,
          duration: video.duration || 0,
          isPlaying: selectedEntity.playback?.isPlaying ?? false,
          version: s.playbackVersion,
        };
      }

      // Handle GIF entities
      if (selectedEntity?.mediaSource.type === MediaType.gif) {
        return {
          entityId: selectedEntity.id,
          currentTime: selectedEntity.playback?.currentTime ?? 0,
          duration: selectedEntity.mediaSource.duration,
          isPlaying: selectedEntity.playback?.isPlaying ?? false,
          version: s.playbackVersion,
        };
      }

      // No animated entity selected
      return {
        entityId: null,
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        version: s.playbackVersion,
      };
    });

    this.getSelectedVideoAudioSnapshot = this.createSnapshot("selectionVersion", (s) => {
      const selectedEntity = this.getSelectedEntity();
      if (selectedEntity?.mediaSource.type === MediaType.video) {
        return {
          entityId: selectedEntity.id,
          canToggleMuted: selectedEntity.mediaSource.hasAudio,
          muted: selectedEntity.playback?.muted ?? selectedEntity.mediaSource.videoElement.muted,
          version: s.selectionVersion,
        };
      }

      return {
        entityId: null,
        canToggleMuted: false,
        muted: true,
        version: s.selectionVersion,
      };
    });

    this.getDragSnapshot = this.createSnapshot("dragVersion", (s) => ({
      entityDragActive: s.entityDragActive,
      version: s.dragVersion,
    }));

    this.getActionLayerSnapshot = this.createSnapshot("actionLayerVersion", (s) => ({
      active: s.actionLayerActive,
      entityIds: s.actionLayerEntityIds,
      touchOrigin: s.actionLayerTouchOrigin,
      version: s.actionLayerVersion,
    }));
  }

  /** Direct state access for game loop - NO ALLOCATIONS */
  override getState(): CanvasState {
    return super.getState();
  }

  // Viewport mutations (only notify viewport subscribers)
  setViewport(viewport: Viewport): void {
    this.state.viewport = { ...viewport, offset: { ...viewport.offset } };
    this.state.viewportDirty = true;
    this.notifyViewportChange();
  }

  panBy(delta: Point): void {
    this.state.viewport.offset.x += delta.x;
    this.state.viewport.offset.y += delta.y;
    this.state.viewportDirty = true;
    this.notifyViewportChange();
  }

  // Entity mutations (only notify selection subscribers)
  addEntity(entity: ShaderCanvasEntity): void {
    if (entity.mediaSource.type === MediaType.video) {
      this.#syncVideoElementPlayback(entity);
    }
    this.state.entities.set(entity.id, entity);
    this.state.entityIds.push(entity.id);
    this.#entitySpatialIndex.upsert(entity);
    this.state.entitiesDirty.add(entity.id);
    this.notifyEntityChange();
  }

  addEntities(entities: readonly ShaderCanvasEntity[]): void {
    if (entities.length === 0) return;
    for (const entity of entities) {
      if (entity.mediaSource.type === MediaType.video) {
        this.#syncVideoElementPlayback(entity);
      }
      this.state.entities.set(entity.id, entity);
      this.state.entityIds.push(entity.id);
      this.#entitySpatialIndex.upsert(entity);
      this.state.entitiesDirty.add(entity.id);
    }
    this.notifyEntityChange();
  }

  /** Atomically replace canvas content after a workspace has decoded successfully. */
  restoreWorkspace(entities: readonly ShaderCanvasEntity[], viewport: Viewport): void {
    const nextEntities = new Map<string, ShaderCanvasEntity>();
    const nextEntityIds: string[] = [];
    const nextSpatialIndex = new EntitySpatialIndex();
    for (const entity of entities) {
      if (nextEntities.has(entity.id)) {
        throw new Error(`Cannot restore duplicate entity ID "${entity.id}"`);
      }
      if (entity.mediaSource.type === MediaType.video) this.#syncVideoElementPlayback(entity);
      nextEntities.set(entity.id, entity);
      nextEntityIds.push(entity.id);
      nextSpatialIndex.upsert(entity);
    }

    this.state.entities = nextEntities;
    this.state.entityIds = nextEntityIds;
    this.#entitySpatialIndex = nextSpatialIndex;
    this.#renderState.entitySpatialIndex = nextSpatialIndex;
    this.state.viewport = {
      offset: { x: viewport.offset.x, y: viewport.offset.y },
      zoom: viewport.zoom,
    };
    this.state.selectedEntityIds = new Set();
    this.state.contextOpenEntityId = null;
    this.state.multiSelectMode = false;
    this.state.entityDragActive = false;
    this.state.actionLayerActive = false;
    this.state.actionLayerEntityIds = new Set();
    this.state.actionLayerTouchOrigin = { x: 0, y: 0 };
    this.state.canvasCallouts = [];
    // Every restored entity is already textureDirty. One scene-level dirty flag is
    // sufficient; retaining 131k duplicate IDs until the first frame is wasted memory.
    this.state.entitiesDirty.clear();
    this.state.selectionDirty = true;
    this.state.viewportDirty = true;
    this.state.containerSizeDirty = false;
    this.state.canvasCalloutsDirty = false;
    this.state.version++;
    this.state.entityVersion++;
    this.state.geometryVersion++;
    this.state.selectionVersion++;
    this.state.viewportVersion++;
    this.state.preferencesVersion++;
    this.state.playbackVersion++;
    this.state.dragVersion++;
    this.state.actionLayerVersion++;
    this.clearComputedCache();
    this.#resetSelectorCaches();
    this.notify();
    for (const listener of this.#viewportListeners) listener();
  }

  updateEntity(id: string, updates: Partial<ShaderCanvasEntity>): void {
    this.updateEntities([{ id, updates }]);
  }

  /** Apply a large entity mutation set with one version bump and subscriber notification. */
  updateEntities(batch: readonly CanvasEntityUpdate[]): number {
    if (batch.length === 0) return 0;

    let updatedCount = 0;
    for (const { id, updates } of batch) {
      const entity = this.state.entities.get(id);
      if (!entity) continue;
      const updatedEntity = { ...entity, ...updates } as ShaderCanvasEntity;
      this.state.entities.set(id, updatedEntity);
      if (hasSpatialEntityUpdates(updates)) {
        this.#entitySpatialIndex.upsert(updatedEntity);
      } else {
        this.#entitySpatialIndex.updateEntityReference(updatedEntity);
      }
      this.state.entitiesDirty.add(id);
      updatedCount++;
    }

    if (updatedCount === 0) return 0;
    this.notifyEntityChange();
    this.#logger.debug("Updated entity batch", { entityCount: updatedCount });
    return updatedCount;
  }

  moveEntity(id: string, delta: Point): void {
    const entity = this.state.entities.get(id);
    if (entity) {
      entity.position.x += delta.x;
      entity.position.y += delta.y;
      this.#entitySpatialIndex.upsert(entity);
      this.state.geometryVersion++;
      // Position-only updates still change the composed scene and must invalidate
      // renderer caches such as the fullscreen wlur overlay during drag.
      this.state.geometryDirty = true;
    }
  }

  /** Translate a group with one spatial-index pass and one geometry invalidation. */
  moveEntities(entityIds: ReadonlySet<string> | readonly string[], delta: Point): number {
    if (delta.x === 0 && delta.y === 0) return 0;
    let movedCount = 0;
    for (const entityId of entityIds) {
      const entity = this.state.entities.get(entityId);
      if (!entity) continue;
      entity.position.x += delta.x;
      entity.position.y += delta.y;
      movedCount++;
    }
    if (movedCount === 0) return 0;
    this.#entitySpatialIndex.translateEntities(entityIds, delta);
    this.state.geometryVersion++;
    this.state.geometryDirty = true;
    return movedCount;
  }

  removeEntity(id: string): void {
    this.state.entities.delete(id);
    this.#entitySpatialIndex.remove(id);
    const index = this.state.entityIds.indexOf(id);
    if (index !== -1) {
      this.state.entityIds.splice(index, 1);
    }

    this.state.entitiesDirty.delete(id);
    // Always mark dirty since entity list changed (needed for undo/redo re-render)
    this.state.selectionDirty = true;
    // Remove from selection if present (immutable update for React)
    if (this.state.selectedEntityIds.has(id)) {
      const newSelection = new Set(this.state.selectedEntityIds);
      newSelection.delete(id);
      this.state.selectedEntityIds = newSelection;
    }
    this.notifyEntityChange();
  }

  removeEntities(entityIds: ReadonlySet<string>): number {
    if (entityIds.size === 0) return 0;

    let removedCount = 0;
    for (const id of entityIds) {
      if (!this.state.entities.delete(id)) continue;
      this.#entitySpatialIndex.remove(id);
      this.state.entitiesDirty.delete(id);
      removedCount++;
    }
    if (removedCount === 0) return 0;

    const orderedIds = this.state.entityIds;
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < orderedIds.length; readIndex++) {
      const id = orderedIds[readIndex]!;
      if (!entityIds.has(id)) orderedIds[writeIndex++] = id;
    }
    orderedIds.length = writeIndex;

    const nextSelection = new Set<string>();
    for (const id of this.state.selectedEntityIds) {
      if (!entityIds.has(id)) nextSelection.add(id);
    }
    this.state.selectedEntityIds = nextSelection;
    this.state.selectionDirty = true;
    this.notifyEntityChange();
    this.#logger.debug("Removed entity batch", { entityCount: removedCount });
    return removedCount;
  }

  // ============================================================================
  // Multi-Selection Methods
  // ============================================================================

  /** Add an entity to the current selection */
  addToSelection(id: string): void {
    if (!this.state.entities.has(id)) return;
    this.state.selectedEntityIds = new Set(this.state.selectedEntityIds).add(id);
    this.state.selectionDirty = true;
    completeOnboardingStarterSelectionFromEvent(this.state.selectedEntityIds);
    this.#logger.debug(`Added to selection: ${id}`, this.state.entities.get(id));
    this.notifySelectionChange();
  }

  /** Remove an entity from the current selection */
  removeFromSelection(id: string): void {
    const newSelection = new Set(this.state.selectedEntityIds);
    newSelection.delete(id);
    this.state.selectedEntityIds = newSelection;
    this.state.selectionDirty = true;
    this.#logger.debug(`Removed from selection: ${id}`);
    this.notifySelectionChange();
  }

  /** Toggle an entity's selection state */
  toggleSelection(id: string): void {
    if (this.state.selectedEntityIds.has(id)) {
      this.removeFromSelection(id);
    } else {
      this.addToSelection(id);
    }
  }

  /** Replace the current selection with a new set of entity IDs */
  replaceSelection(ids: string[]): void {
    const newSelection = new Set<string>();
    for (const id of ids) {
      if (this.state.entities.has(id)) {
        newSelection.add(id);
      }
    }
    this.state.selectedEntityIds = newSelection;
    this.state.selectionDirty = true;
    completeOnboardingStarterSelectionFromEvent(this.state.selectedEntityIds);
    this.#logger.debug("Selection replaced", {
      entityCount: newSelection.size,
      requestedCount: ids.length,
      firstEntityId: ids[0] ?? null,
      lastEntityId: ids.at(-1) ?? null,
    });
    this.notifySelectionChange();
  }

  /** Select every entity without materializing and revalidating an intermediate ID array. */
  selectAll(): void {
    if (
      this.state.entities.size === 0 ||
      this.state.selectedEntityIds.size === this.state.entities.size
    ) {
      return;
    }
    this.state.selectedEntityIds = new Set(this.state.entityIds);
    this.state.selectionDirty = true;
    completeOnboardingStarterSelectionFromEvent(this.state.selectedEntityIds);
    this.#logger.debug("All entities selected", { entityCount: this.state.selectedEntityIds.size });
    this.notifySelectionChange();
  }

  /** Adopt a validated drag-selection set without notifying React mid-gesture. */
  replaceTransientSelection(ids: Set<string>): Set<string> {
    const previousSelection = this.state.selectedEntityIds;
    this.state.selectedEntityIds = ids;
    this.state.selectionDirty = true;
    return previousSelection;
  }

  /** Publish the final transient selection once when drag selection completes. */
  commitTransientSelection(): void {
    completeOnboardingStarterSelectionFromEvent(this.state.selectedEntityIds);
    this.#logger.debug("Drag selection committed", {
      entityCount: this.state.selectedEntityIds.size,
    });
    this.notifySelectionChange();
  }

  /** Clear all selection */
  clearSelection(): void {
    this.state.selectedEntityIds = new Set();
    this.state.selectionDirty = true;
    this.#logger.debug(`Selection cleared`);
    this.notifySelectionChange();
  }

  /** Check if an entity is selected */
  isSelected(id: string): boolean {
    return this.state.selectedEntityIds.has(id);
  }

  /** Get all selected entity IDs */
  getSelectedEntityIds(): ReadonlySet<string> {
    return this.state.selectedEntityIds;
  }

  /** Get all selected entities */
  getSelectedEntities(): ShaderCanvasEntity[] {
    const entities: ShaderCanvasEntity[] = [];
    for (const id of this.state.selectedEntityIds) {
      const entity = this.state.entities.get(id);
      if (entity) entities.push(entity);
    }
    return entities;
  }

  /** Get selected entities with structural sharing for selector subscriptions. */
  getSelectedEntitiesStable(): ShaderCanvasEntity[] {
    if (this.#selectedEntitiesVersion === this.state.selectionVersion) {
      return this.#selectedEntitiesCache;
    }
    this.#selectedEntitiesCache = this.getSelectedEntities();
    this.#selectedEntitiesVersion = this.state.selectionVersion;
    return this.#selectedEntitiesCache;
  }

  /** Get the count of selected entities */
  getSelectionCount(): number {
    return this.state.selectedEntityIds.size;
  }

  /** Get the single selected entity (for backwards compat during migration) */
  getSelectedEntity(): ShaderCanvasEntity | undefined {
    if (this.state.selectedEntityIds.size !== 1) return undefined;
    const [id] = this.state.selectedEntityIds;
    return id ? this.state.entities.get(id) : undefined;
  }

  getSelectionState(): SelectionState {
    const entities = this.getSelectedEntitiesStable();
    if (this.#selectionStateCache?.entities === entities) {
      return this.#selectionStateCache.value;
    }

    const next = computeSelectionState(entities, this.state.selectedEntityIds);
    this.#selectionStateCache = { entities, value: next };
    return next;
  }

  /** Set selected entity (wrapper for replaceSelection for backwards compat) */
  setSelectedEntity(id: string | null): void {
    if (id === null) {
      this.clearSelection();
    } else {
      this.replaceSelection([id]);
    }
  }

  setContextOpenEntity(id: string | null): void {
    this.state.contextOpenEntityId = id;
    this.state.selectionDirty = true;
    if (id) {
      this.#logger.debug(`context menu opened for entity: ${id}`, this.state.entities.get(id));
    }

    this.notifySelectionChange();
  }

  setContextMenuClosed(): void {
    if (this.state.contextOpenEntityId) {
      this.#logger.debug(
        `context menu closed for entity: ${this.state.contextOpenEntityId}`,
        this.state.entities.get(this.state.contextOpenEntityId),
      );
    }

    this.state.contextOpenEntityId = null;
    this.state.selectionDirty = true;

    this.notifySelectionChange();
  }

  // ============================================================================
  // Test/Reset Methods
  // ============================================================================

  /**
   * Reset store to initial state. Used for testing.
   * Properly increments versions and notifies subscribers.
   */
  reset(): void {
    this.state.entities.clear();
    this.state.entityIds.length = 0;
    this.#entitySpatialIndex.clear();
    this.state.selectedEntityIds = new Set();
    this.state.contextOpenEntityId = null;
    this.state.multiSelectMode = false;
    this.state.entityDragActive = false;
    this.state.actionLayerActive = false;
    this.state.actionLayerEntityIds = new Set();
    this.state.actionLayerTouchOrigin = { x: 0, y: 0 };
    this.state.canvasCallouts = [];
    this.state.entitiesDirty.clear();
    this.state.selectionDirty = false;
    this.state.viewportDirty = false;
    this.state.containerSizeDirty = false;
    this.state.canvasCalloutsDirty = false;
    // Increment versions to invalidate cached snapshots
    this.state.version++;
    this.state.entityVersion++;
    this.state.geometryVersion++;
    this.state.selectionVersion++;
    this.state.viewportVersion++;
    this.state.preferencesVersion++;
    this.state.playbackVersion++;
    this.state.dragVersion++;
    this.state.actionLayerVersion++;
    // Clear computed cache
    this.clearComputedCache();
    this.#resetSelectorCaches();
    // Notify all subscribers
    this.notify();
  }

  // Debug mode toggle
  toggleDebugMode(): void {
    this.state.version++;
    this.state.viewportDirty = true;
    this.state.debugMode = !this.state.debugMode;
    this.#logger.setLevel(this.state.debugMode ? LogLevel.DEBUG : LogLevel.ERROR);
    this.notifySelectionChange();
    this.#logger.debug(`Debug mode toggled: ${this.state.debugMode}`);
  }

  setDebugMode(enabled: boolean): void {
    this.state.version++;
    this.state.viewportDirty = true;
    this.state.debugMode = enabled;
    this.#logger.setLevel(enabled ? LogLevel.DEBUG : LogLevel.ERROR);
    this.notifySelectionChange();
    this.#logger.debug(`Debug mode set to: ${this.state.debugMode}`);
  }

  setDebugView(view: RenderState["debugView"]): void {
    this.#renderState.debugView = view;
  }

  // Snap-to-grid toggle
  toggleSnapToGrid(): void {
    this.state.snapToGrid = !this.state.snapToGrid;
    this.state.version++;
    this.notifyPreferencesChange();
  }

  setSnapToGrid(enabled: boolean): void {
    if (this.state.snapToGrid === enabled) return;
    this.state.snapToGrid = enabled;
    this.state.version++;
    this.notifyPreferencesChange();
  }

  setFancyDelete(enabled: boolean): void {
    if (this.state.fancyDelete === enabled) return;
    this.state.fancyDelete = enabled;
    this.state.version++;
    this.notifyPreferencesChange();
  }

  setHaptics(enabled: boolean): void {
    if (this.state.haptics === enabled) return;
    this.state.haptics = enabled;
    this.state.version++;
    this.notifyPreferencesChange();
  }

  setCanvasLensing(value: CanvasLensing): void {
    if (this.state.canvasLensing === value) return;
    this.state.canvasLensing = value;
    this.state.version++;
    this.notifyPreferencesChange();
  }

  setEntityDragActive(active: boolean): void {
    if (this.state.entityDragActive === active) return;
    this.state.entityDragActive = active;
    this.state.dragVersion++;
    this.notify();
  }

  setTransientEntityDragOffset(offset: Point): void {
    this.#transientEntityDragOffset.x = offset.x;
    this.#transientEntityDragOffset.y = offset.y;
    this.state.geometryDirty = true;
  }

  getTransientEntityDragOffset(): Readonly<Point> {
    return this.#transientEntityDragOffset;
  }

  getEntityPositionWithTransientDrag(entityId: string): Point | null {
    const entity = this.state.entities.get(entityId);
    if (!entity) return null;
    if (!this.state.selectedEntityIds.has(entityId)) return { ...entity.position };
    return {
      x: entity.position.x + this.#transientEntityDragOffset.x,
      y: entity.position.y + this.#transientEntityDragOffset.y,
    };
  }

  resetTransientEntityDragOffset(): void {
    this.#transientEntityDragOffset.x = 0;
    this.#transientEntityDragOffset.y = 0;
  }

  setActionLayerActive(
    active: boolean,
    entityIds?: ReadonlySet<string>,
    touchOrigin?: { x: number; y: number },
  ): void {
    this.state.actionLayerActive = active;
    this.state.actionLayerEntityIds = entityIds ?? new Set();
    if (touchOrigin) this.state.actionLayerTouchOrigin = touchOrigin;
    this.state.actionLayerVersion++;
    this.notify();
  }

  setCanvasCallouts(callouts: readonly CanvasCallout[]): void {
    if (sameCanvasCallouts(this.state.canvasCallouts, callouts)) return;
    this.state.canvasCallouts = callouts;
    this.state.canvasCalloutsDirty = true;
  }

  setMultiSelectMode(enabled: boolean): void {
    this.state.multiSelectMode = enabled;
    this.notifySelectionChange();
  }

  // Playback controls (video and GIF)
  async togglePlayback(entityId: string): Promise<void> {
    const entity = this.state.entities.get(entityId);
    if (!entity) return;

    if (entity.mediaSource.type === MediaType.video) {
      if (entity.playback?.isPlaying) {
        this.pauseVideo(entityId);
      } else {
        await this.playVideo(entityId);
      }
    } else if (entity.mediaSource.type === MediaType.gif) {
      if (entity.playback?.isPlaying) {
        this.pauseGif(entityId);
      } else {
        this.playGif(entityId);
      }
    }
  }

  async playVideo(entityId: string): Promise<void> {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.video) return;

    const video = entity.mediaSource.videoElement;
    this.#syncVideoElementPlayback(entity);
    await video.play();

    if (entity.playback) {
      entity.playback.isPlaying = true;
      entity.playback.currentTime = video.currentTime;
    }
    this.state.entitiesDirty.add(entityId);
    this.notifyEntityChange();
  }

  setVideoMuted(entityId: string, muted: boolean): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.video || !entity.playback) return;

    if (entity.playback.muted === muted && entity.mediaSource.videoElement.muted === muted) {
      return;
    }

    entity.playback.muted = muted;
    entity.mediaSource.videoElement.muted = muted;
    this.state.entitiesDirty.add(entityId);
    this.notifySelectionChange();
  }

  toggleVideoMuted(entityId: string): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.video) return;

    this.setVideoMuted(
      entityId,
      !(entity.playback?.muted ?? entity.mediaSource.videoElement.muted),
    );
  }

  pauseVideo(entityId: string): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.video) return;

    const video = entity.mediaSource.videoElement;
    video.pause();

    if (entity.playback) {
      entity.playback.isPlaying = false;
      entity.playback.currentTime = video.currentTime;
    }

    // Snapshot current frame for static display
    const width = video.videoWidth || entity.originalSize.width;
    const height = video.videoHeight || entity.originalSize.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0, width, height);
      const previousBitmap = entity.imageBitmap;
      createImageBitmap(canvas)
        .then((bitmap) => {
          if (this.state.entities.get(entityId) !== entity) {
            bitmap.close();
            return;
          }
          entity.imageBitmap = bitmap;
          previousBitmap.close();
          entity.textureDirty = true;
          this.state.entitiesDirty.add(entityId);
        })
        .catch((e) => logger.error(e));
    }

    this.state.entitiesDirty.add(entityId);
    this.notifyEntityChange();
  }

  /**
   * Seek video to a specific time.
   * Updates video.currentTime, playback state, and marks texture dirty.
   */
  seekVideo(entityId: string, time: number): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.video) return;

    const video = entity.mediaSource.videoElement;
    // Clamp to valid range
    const clampedTime = Math.max(0, Math.min(time, video.duration || 0));
    video.currentTime = clampedTime;

    if (entity.playback) {
      entity.playback.currentTime = clampedTime;
    }

    entity.textureDirty = true;
    this.state.entitiesDirty.add(entityId);
    this.state.playbackVersion++;
    this.notify();
  }

  /**
   * Update video playback time during passive playback.
   * Always updates entity state (renderer reads this directly).
   * Throttles React notification to 60fps to avoid layout thrashing on high-refresh displays.
   */
  updatePlaybackTime(entityId: string, currentTime: number): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.video || !entity.playback) return;

    entity.playback.currentTime = currentTime;
    if (!this.state.selectedEntityIds.has(entityId)) return;

    const now = performance.now();
    if (now - this.#lastPlaybackNotifyTime < CanvasStore.#PLAYBACK_NOTIFY_INTERVAL_MS) {
      return;
    }
    this.#lastPlaybackNotifyTime = now;
    this.state.playbackVersion++;
    this.notify();
  }

  markEntityTextureDirty(entityId: string): void {
    const entity = this.state.entities.get(entityId);
    if (!entity) return;

    entity.textureDirty = true;
    this.state.entitiesDirty.add(entityId);
  }

  // GIF playback controls
  playGif(entityId: string): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.gif) return;

    if (entity.playback) {
      entity.playback.isPlaying = true;
    }
    this.state.entitiesDirty.add(entityId);
    this.notifyEntityChange();
  }

  pauseGif(entityId: string): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.gif) return;

    if (entity.playback) {
      entity.playback.isPlaying = false;
    }

    // Snapshot current frame for static display (already set by advanceGifPlayback)
    entity.textureDirty = true;
    this.state.entitiesDirty.add(entityId);
    this.notifyEntityChange();
  }

  /**
   * Seek GIF to a specific time.
   * Updates playback state, imageBitmap to correct frame, and marks texture dirty.
   */
  seekGif(entityId: string, time: number): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.gif) return;

    const { frames, duration } = entity.mediaSource;
    const clampedTime = Math.max(0, Math.min(time, duration));

    if (entity.playback) {
      entity.playback.currentTime = clampedTime;
    }

    // Update frame to match seek position
    const frame = getFrameAtTime(frames, clampedTime, entity.playback?.loop ?? true);
    entity.imageBitmap = frame.bitmap;
    entity.textureDirty = true;
    this.state.entitiesDirty.add(entityId);
    this.state.playbackVersion++;
    this.notify();
  }

  /**
   * Update GIF playback time during playback.
   * Always updates entity state (renderer reads this directly).
   * Throttles React notification to 60fps to avoid layout thrashing on high-refresh displays.
   */
  updateGifPlaybackTime(entityId: string, currentTime: number): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.gif || !entity.playback) return;

    entity.playback.currentTime = currentTime;
    if (!this.state.selectedEntityIds.has(entityId)) return;

    const now = performance.now();
    if (now - this.#lastPlaybackNotifyTime < CanvasStore.#PLAYBACK_NOTIFY_INTERVAL_MS) {
      return;
    }
    this.#lastPlaybackNotifyTime = now;
    this.state.playbackVersion++;
    this.notify();
  }

  /**
   * Force an immediate playback notification (bypasses throttle).
   * Used after seek events, play/pause, and video end.
   */
  forcePlaybackNotify(entityId: string, currentTime: number): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || !entity.playback) return;

    entity.playback.currentTime = currentTime;
    this.#lastPlaybackNotifyTime = performance.now();
    this.state.playbackVersion++;
    this.notify();
  }

  #syncVideoElementPlayback(entity: ShaderCanvasEntity): void {
    if (entity.mediaSource.type !== MediaType.video) return;

    const { videoElement } = entity.mediaSource;
    const playback = entity.playback;
    videoElement.muted = playback?.muted ?? true;
    videoElement.volume = Math.max(0, Math.min(playback?.volume ?? 1, 1));
    videoElement.loop = playback?.loop ?? true;
    videoElement.playbackRate = playback?.playbackRate ?? 1;
  }

  /**
   * Advance GIF playback by deltaSeconds.
   * Resolves the current frame and swaps entity.imageBitmap.
   */
  advanceGifPlayback(entityId: string, deltaSeconds: number, updateFrame = true): boolean {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.gif || !entity.playback?.isPlaying) {
      return false;
    }

    const { frames, duration } = entity.mediaSource;
    const loop = entity.playback.loop;

    // Advance current time
    entity.playback.currentTime += deltaSeconds * entity.playback.playbackRate;

    // Handle loop/end
    if (loop && duration > 0) {
      entity.playback.currentTime = entity.playback.currentTime % duration;
    } else if (entity.playback.currentTime >= duration) {
      entity.playback.currentTime = duration;
      entity.playback.isPlaying = false;
    }

    if (!updateFrame) return false;

    // Resolve the frame to display
    const frame = getFrameAtTime(frames, entity.playback.currentTime, loop);
    if (entity.imageBitmap === frame.bitmap) {
      return false;
    }

    entity.imageBitmap = frame.bitmap;
    // Mark as dirty so renderer picks up the new frame
    entity.textureDirty = true;
    this.state.entitiesDirty.add(entityId);
    return true;
  }

  // Mark container as needing resize handling (no React notification needed)
  setContainerDirty(): void {
    this.state.containerSizeDirty = true;
  }

  // Snapshot for rendering (called once per frame)
  hasRenderChanges(): boolean {
    return (
      this.state.viewportDirty ||
      this.state.entitiesDirty.size > 0 ||
      this.state.geometryDirty ||
      this.state.selectionDirty ||
      this.state.containerSizeDirty ||
      this.state.canvasCalloutsDirty
    );
  }

  getRenderState(): RenderState {
    if (this.#renderEntitiesVersion !== this.state.entityVersion) {
      let canPatchReferences =
        this.#renderEntitiesVersion >= 0 &&
        this.state.entitiesDirty.size > 0 &&
        this.#renderEntities.length === this.state.entities.size;
      if (canPatchReferences) {
        for (const id of this.state.entitiesDirty) {
          const index = this.#renderEntityIndices.get(id);
          const next = this.state.entities.get(id);
          const previous = index === undefined ? undefined : this.#renderEntities[index];
          if (index === undefined || !next || !previous || previous.zIndex !== next.zIndex) {
            canPatchReferences = false;
            break;
          }
        }
      }
      if (canPatchReferences) {
        for (const id of this.state.entitiesDirty) {
          this.#renderEntities[this.#renderEntityIndices.get(id)!] = this.state.entities.get(id)!;
        }
      } else {
        this.#renderEntities.length = 0;
        for (const entity of this.state.entities.values()) this.#renderEntities.push(entity);
        this.#renderEntities.sort((a, b) => a.zIndex - b.zIndex);
        this.#renderEntityIndices.clear();
        for (let index = 0; index < this.#renderEntities.length; index++) {
          this.#renderEntityIndices.set(this.#renderEntities[index]!.id, index);
        }
      }
      this.#renderEntitiesVersion = this.state.entityVersion;
    }

    this.#renderViewport.offset.x = this.state.viewport.offset.x;
    this.#renderViewport.offset.y = this.state.viewport.offset.y;
    this.#renderViewport.zoom = this.state.viewport.zoom;
    this.#renderActionLayer.active = this.state.actionLayerActive;
    this.#renderActionLayer.entityIds = this.state.actionLayerEntityIds;
    this.#renderDragVisual.active = this.state.entityDragActive;

    const renderState = this.#renderState;
    renderState.entityVersion = this.state.entityVersion;
    renderState.geometryVersion = this.state.geometryVersion;
    renderState.selectionVersion = this.state.selectionVersion;
    renderState.dirtyEntityIds = this.state.entitiesDirty;
    renderState.selectedEntityIds = this.state.selectedEntityIds;
    renderState.debugMode = this.state.debugMode;
    renderState.dirty = this.hasRenderChanges();
    renderState.canvasCallouts = this.state.canvasCallouts;
    renderState.dragSelectBounds = null;
    renderState.dragSelectMode = null;
    renderState.multiSelectBounds = null;
    renderState.actionLayer = this.#renderActionLayer;
    renderState.dragVisual = this.#renderDragVisual;
    renderState.disintegration = this.#renderDisintegration;
    return renderState;
  }

  queryEntitiesInBounds(bounds: Bounds, output: ShaderCanvasEntity[]): ShaderCanvasEntity[] {
    return this.#entitySpatialIndex.queryBounds(bounds, output);
  }

  queryEntitiesInBoundsUnordered(
    bounds: Bounds,
    output: ShaderCanvasEntity[],
  ): ShaderCanvasEntity[] {
    return this.#entitySpatialIndex.queryBounds(bounds, output, undefined, false);
  }

  // Clear dirty flags after render
  clearDirtyFlags(): void {
    this.state.viewportDirty = false;
    this.state.entitiesDirty.clear();
    this.state.geometryDirty = false;
    this.state.selectionDirty = false;
    this.state.containerSizeDirty = false;
    this.state.canvasCalloutsDirty = false;
    this.state.frameCount++;
  }

  // Imperative getter for on-demand viewport access (no subscription)
  getViewport(): Viewport {
    return this.state.viewport;
  }

  subscribeViewport = (listener: () => void): (() => void) => {
    this.#viewportListeners.add(listener);
    return () => this.#viewportListeners.delete(listener);
  };

  // ============================================================================
  // Notification Helpers (use base class notify())
  // ============================================================================

  private notifyViewportChange(): void {
    // Only increment viewportVersion, NOT version
    // This keeps high-frequency pan/zoom off the general store subscription path.
    this.state.viewportVersion++;
    for (const listener of this.#viewportListeners) {
      listener();
    }
  }

  private notifySelectionChange(): void {
    // Increment selectionVersion, version, AND playbackVersion
    // playbackVersion is included because getPlaybackSnapshot depends on selected entity
    this.state.selectionVersion++;
    this.state.version++;
    this.state.playbackVersion++;
    this.notify();
  }

  private notifyEntityChange(): void {
    this.state.entityVersion++;
    this.notifySelectionChange();
  }

  private notifyPreferencesChange(): void {
    this.state.preferencesVersion++;
    this.notify();
  }

  // ============================================================================
  // Computed Param Results (cached with structural sharing)
  // ============================================================================

  /**
   * Get a shader param value with multi-select support.
   * Returns cached result with structural sharing to prevent unnecessary re-renders.
   */
  getParamResult<P extends ParamPaths>(
    path: P,
    defaultValue: GetParamByPath<P> | null,
  ): ParamResult<GetParamByPath<P> | null> {
    const entities = this.getSelectedEntitiesStable();
    const cacheKey = `param:${path}`;
    const cached = this.#paramResultCache.get(cacheKey) as
      | {
          entities: ShaderCanvasEntity[];
          value: ParamResult<GetParamByPath<P> | null>;
        }
      | undefined;

    if (cached?.entities === entities) {
      return cached.value;
    }

    const next = this.#computeParamResult(path, defaultValue, entities);
    if (cached && paramResultEqual(cached.value, next)) {
      this.#paramResultCache.set(cacheKey, {
        entities,
        value: cached.value,
      });
      return cached.value;
    }

    this.#paramResultCache.set(cacheKey, {
      entities,
      value: next,
    });
    return next;
  }

  #computeParamResult<P extends ParamPaths>(
    path: P,
    defaultValue: GetParamByPath<P> | null,
    entities = this.getSelectedEntitiesStable(),
  ): ParamResult<GetParamByPath<P> | null> {
    type T = GetParamByPath<P>;

    const pathParts = path.split(".");
    const rootParam = pathParts[0] as keyof ShaderParams;

    if (entities.length === 0) {
      return { value: defaultValue, isMixed: false, isSupported: true, values: new Set() };
    }

    const firstValue = getNestedValue<T>(entities[0]!.shaderParams, pathParts) ?? defaultValue;
    const firstEntity = entities[0]!;
    if (!entitySupportsParam(firstEntity, rootParam, path)) {
      return createUnsupportedParamResult(firstValue);
    }

    if (entities.length === 1) {
      const values = new Set<NonNullable<T>>();
      if (firstValue != null) values.add(firstValue as NonNullable<T>);
      return { value: firstValue, isMixed: false, isSupported: true, values };
    }

    // Multi-select: check uniformity and collect distinct values
    const values = new Set<NonNullable<T>>();
    if (firstValue != null) values.add(firstValue as NonNullable<T>);
    let isMixed = false;
    let objectValueKeys: Set<string> | null = null;

    for (let index = 1; index < entities.length; index++) {
      const entity = entities[index]!;
      if (!entitySupportsParam(entity, rootParam, path)) {
        return createUnsupportedParamResult(firstValue);
      }
      // Apply default to get effective value (matches how firstValue is computed)
      const val = getNestedValue<T>(entity.shaderParams, pathParts) ?? defaultValue;
      const matchesFirst = paramValueEqual(val, firstValue);
      if (!matchesFirst) isMixed = true;
      if (val == null || Object.is(val, firstValue)) continue;

      if (typeof val !== "object") {
        values.add(val as NonNullable<T>);
        continue;
      }

      // Object-valued params (currently palettes) are commonly cloned per entity.
      // Keep one semantic value without retaining every clone in a giant Set.
      if (matchesFirst) continue;
      objectValueKeys ??= new Set(
        firstValue != null && typeof firstValue === "object" ? [JSON.stringify(firstValue)] : [],
      );
      const key = JSON.stringify(val);
      if (objectValueKeys.has(key)) continue;
      objectValueKeys.add(key);
      values.add(val as NonNullable<T>);
    }

    return { value: firstValue, isMixed, isSupported: true, values };
  }

  #resetSelectorCaches(): void {
    this.#selectedEntitiesCache = [];
    this.#selectedEntitiesVersion = -1;
    this.#selectionStateCache = null;
    this.#paramResultCache.clear();
  }
}

function hasSpatialEntityUpdates(updates: Partial<ShaderCanvasEntity>): boolean {
  return (
    updates.position !== undefined ||
    updates.size !== undefined ||
    updates.rotation !== undefined ||
    updates.zIndex !== undefined
  );
}

/**
 * Get a nested value from shader params using pre-split path parts
 */
function getNestedValue<T>(params: ShaderParams, pathParts: string[]): T | undefined {
  let current: unknown = params;
  for (const part of pathParts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as T | undefined;
}

function entitySupportsParam(
  entity: ShaderCanvasEntity,
  rootParam: keyof ShaderParams,
  path: ParamPaths,
): boolean {
  if (!shaderFeatures[entity.shaderType].params.includes(rootParam)) return false;
  const rule = paramVisibilityRules[entity.shaderType]?.find(
    (candidate) => candidate.param === path,
  );
  return !rule || rule.isVisible(entity.shaderParams);
}

function createUnsupportedParamResult<T>(value: T): ParamResult<T> {
  const values = new Set<NonNullable<T>>();
  if (value != null) values.add(value as NonNullable<T>);
  return { value, isMixed: false, isSupported: false, values };
}

function paramValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!paramValueEqual(a[index], b[index])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(bRecord, key) || !paramValueEqual(aRecord[key], bRecord[key])) return false;
  }
  return true;
}

function computeSelectionState(
  entities: ShaderCanvasEntity[],
  selectedEntityIds: ReadonlySet<string>,
): SelectionState {
  if (entities.length === 0) {
    return {
      entityIds: selectedEntityIds,
      count: 0,
      isEmpty: true,
      isSingle: false,
      isMultiple: false,
      shaderTypes: new Set(),
      hasUniformShader: false,
      commonParams: [],
      colorMode: "mixed",
    };
  }

  const shaderTypes = new Set<ShaderType>();
  for (const entity of entities) shaderTypes.add(entity.shaderType);
  const { params: commonParams, colorMode } = getCommonFeatures([...shaderTypes]);

  return {
    entityIds: selectedEntityIds,
    count: entities.length,
    isEmpty: false,
    isSingle: entities.length === 1,
    isMultiple: entities.length > 1,
    shaderTypes,
    hasUniformShader: shaderTypes.size === 1,
    commonParams,
    colorMode,
  };
}

function sameCanvasCallouts(a: readonly CanvasCallout[], b: readonly CanvasCallout[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.id !== right.id || left.text !== right.text) return false;
    if ((left.offset?.x ?? 0) !== (right.offset?.x ?? 0)) return false;
    if ((left.offset?.y ?? 0) !== (right.offset?.y ?? 0)) return false;
    if (left.anchor.type !== right.anchor.type) return false;

    if (left.anchor.type === "entity" && right.anchor.type === "entity") {
      if (
        left.anchor.entityId !== right.anchor.entityId ||
        left.anchor.placement !== right.anchor.placement
      ) {
        return false;
      }
    } else if (left.anchor.type === "screen" && right.anchor.type === "screen") {
      if (
        left.anchor.position.x !== right.anchor.position.x ||
        left.anchor.position.y !== right.anchor.position.y ||
        left.anchor.align !== right.anchor.align
      ) {
        return false;
      }
    }
  }

  return true;
}

function sameValueSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;

  const bValues = Array.from(b);
  outer: for (const valueA of a) {
    for (let index = 0; index < bValues.length; index += 1) {
      if (Object.is(valueA, bValues[index])) {
        continue outer;
      }
    }
    return false;
  }

  return true;
}

function paramResultEqual<T>(a: ParamResult<T>, b: ParamResult<T>): boolean {
  return (
    a.isMixed === b.isMixed &&
    a.isSupported === b.isSupported &&
    Object.is(a.value, b.value) &&
    sameValueSet(a.values, b.values)
  );
}

// Singleton instance
export const canvasStore = new CanvasStore();
