import { logger, LogLevel, type Logger } from "#lib/client.logger.ts";
import { Store } from "#lib/store.ts";
import { getCommonFeatures, paramVisibilityRules, shaderFeatures } from "#config";
import {
  type Viewport,
  type ShaderCanvasEntity,
  type Point,
  type Bounds,
  type ShaderParams,
  type ParamPaths,
  type GetParamByPath,
  type SelectionState,
  MediaType,
} from "#types/canvas.ts";
import { getFrameAtTime } from "#lib/gif-decoder.ts";

export interface CanvasState {
  // Core state
  viewport: Viewport;
  entities: Map<string, ShaderCanvasEntity>;

  // Interaction state (transient, not persisted)
  /** Selected entity IDs (multi-select support) */
  selectedEntityIds: Set<string>;
  hoveredEntityId: string | null;
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

  // Dirty flags for optimization
  viewportDirty: boolean;
  entitiesDirty: Set<string>;
  selectionDirty: boolean;
  containerSizeDirty: boolean;

  // Frame counter for debugging
  frameCount: number;

  // Version counters for React change detection (selective subscriptions)
  version: number; // Overall version (for backward compat)
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
}

// Snapshot types for selective subscriptions
export interface ViewportSnapshot {
  viewport: Viewport;
  version: number;
}

export interface SelectionSnapshot {
  selectedEntityIds: ReadonlySet<string>;
  hoveredEntityId: string | null;
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

export interface RenderState {
  viewport: Viewport;
  entities: ShaderCanvasEntity[];
  selectedEntityIds: ReadonlySet<string>;
  hoveredEntityId: string | null;
  debugMode: boolean;
  dirty: boolean;
  /** Drag-select rectangle bounds in world coordinates (null if not active) */
  dragSelectBounds: Bounds | null;
  /** Multi-select bounding box in world coordinates (null if < 2 entities selected) */
  multiSelectBounds: Bounds | null;
  /** Whether the mobile action layer is active (renderer applies blur overlay) */
  actionLayerActive: boolean;
  /** Entity IDs to keep sharp when action layer blur is active */
  actionLayerEntityIds: ReadonlySet<string>;
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
  #selectedEntitiesCache: ShaderCanvasEntity[] = [];
  #selectionStateCache: { entities: ShaderCanvasEntity[]; value: SelectionState } | null = null;
  #paramResultCache = new Map<
    string,
    { entities: ShaderCanvasEntity[]; value: ParamResult<unknown> }
  >();

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
  readonly getDragSnapshot: () => DragSnapshot;
  readonly getActionLayerSnapshot: () => ActionLayerSnapshot;

  constructor() {
    super({
      viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
      entities: new Map(),
      selectedEntityIds: new Set(),
      contextOpenEntityId: null,
      hoveredEntityId: null,
      multiSelectMode: false,
      debugMode: false,
      snapToGrid: false,
      fancyDelete: true,
      haptics: true,
      viewportDirty: false,
      entitiesDirty: new Set(),
      selectionDirty: false,
      containerSizeDirty: false,
      frameCount: 0,
      version: 0,
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
    });

    this.#logger = logger;

    // Create stable snapshot getters via base class
    this.getViewportSnapshot = this.createSnapshot("viewportVersion", (s) => ({
      viewport: { ...s.viewport, offset: { ...s.viewport.offset } },
      version: s.viewportVersion,
    }));

    this.getSelectionSnapshot = this.createSnapshot("selectionVersion", (s) => ({
      selectedEntityIds: s.selectedEntityIds,
      hoveredEntityId: s.hoveredEntityId,
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
    this.state.viewport = {
      ...this.state.viewport,
      offset: {
        x: this.state.viewport.offset.x + delta.x,
        y: this.state.viewport.offset.y + delta.y,
      },
    };
    this.state.viewportDirty = true;
    this.notifyViewportChange();
  }

  // Entity mutations (only notify selection subscribers)
  addEntity(entity: ShaderCanvasEntity): void {
    this.state.entities.set(entity.id, entity);
    this.state.entitiesDirty.add(entity.id);
    this.notifySelectionChange();
  }

  updateEntity(id: string, updates: Partial<ShaderCanvasEntity>): void {
    const entity = this.state.entities.get(id);
    if (entity) {
      const nextEntity = { ...entity, ...updates } as ShaderCanvasEntity;
      this.state.entities.set(id, nextEntity);
      this.state.entitiesDirty.add(id);
      this.notifySelectionChange();
      this.#logger.debug(`Updated entity: ${id}`, { entity: nextEntity, updates });
    }
  }

  moveEntity(id: string, delta: Point): void {
    const entity = this.state.entities.get(id);
    if (entity) {
      entity.position.x += delta.x;
      entity.position.y += delta.y;
      // Position-only updates still change the composed scene and must invalidate
      // renderer caches such as the fullscreen wlur overlay during drag.
      this.state.entitiesDirty.add(id);
    }
  }

  removeEntity(id: string): void {
    this.state.entities.delete(id);
    this.state.entitiesDirty.delete(id);
    // Always mark dirty since entity list changed (needed for undo/redo re-render)
    this.state.selectionDirty = true;
    // Remove from selection if present (immutable update for React)
    if (this.state.selectedEntityIds.has(id)) {
      const newSelection = new Set(this.state.selectedEntityIds);
      newSelection.delete(id);
      this.state.selectedEntityIds = newSelection;
    }
    this.notifySelectionChange();
  }

  // Interaction state
  setHoveredEntity(id: string | null): void {
    this.state.hoveredEntityId = id;
  }

  // ============================================================================
  // Multi-Selection Methods
  // ============================================================================

  /** Add an entity to the current selection */
  addToSelection(id: string): void {
    if (!this.state.entities.has(id)) return;
    this.state.selectedEntityIds = new Set(this.state.selectedEntityIds).add(id);
    this.state.selectionDirty = true;
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
    this.#logger.debug(`Selection replaced with: ${ids.join(", ")}`);
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
    return [...this.state.selectedEntityIds]
      .map((id) => this.state.entities.get(id))
      .filter((e): e is ShaderCanvasEntity => e !== undefined);
  }

  /** Get selected entities with structural sharing for selector subscriptions. */
  getSelectedEntitiesStable(): ShaderCanvasEntity[] {
    const next = this.getSelectedEntities();
    if (sameReferenceArray(this.#selectedEntitiesCache, next)) {
      return this.#selectedEntitiesCache;
    }
    this.#selectedEntitiesCache = next;
    return next;
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

    const next = computeSelectionState(entities);
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
    this.state.selectedEntityIds = new Set();
    this.state.hoveredEntityId = null;
    this.state.contextOpenEntityId = null;
    this.state.entitiesDirty.clear();
    this.state.selectionDirty = false;
    this.state.viewportDirty = false;
    this.state.containerSizeDirty = false;
    // Increment versions to invalidate cached snapshots
    this.state.version++;
    this.state.selectionVersion++;
    this.state.viewportVersion++;
    this.state.preferencesVersion++;
    this.state.playbackVersion++;
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

  setEntityDragActive(active: boolean): void {
    if (this.state.entityDragActive === active) return;
    this.state.entityDragActive = active;
    this.state.dragVersion++;
    this.notify();
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
    await video.play();

    if (entity.playback) {
      entity.playback.isPlaying = true;
      entity.playback.currentTime = video.currentTime;
    }
    this.state.entitiesDirty.add(entityId);
    this.notifySelectionChange();
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
    const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0);
      createImageBitmap(canvas)
        .then((bitmap) => {
          entity.imageBitmap = bitmap;
          entity.textureDirty = true;
          this.state.entitiesDirty.add(entityId);
          this.notifySelectionChange();
        })
        .catch((e) => logger.error(e));
    }

    this.state.entitiesDirty.add(entityId);
    this.notifySelectionChange();
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

    const now = performance.now();
    if (now - this.#lastPlaybackNotifyTime < CanvasStore.#PLAYBACK_NOTIFY_INTERVAL_MS) {
      return;
    }
    this.#lastPlaybackNotifyTime = now;
    this.state.playbackVersion++;
    this.notify();
  }

  // GIF playback controls
  playGif(entityId: string): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.gif) return;

    if (entity.playback) {
      entity.playback.isPlaying = true;
    }
    this.state.entitiesDirty.add(entityId);
    this.notifySelectionChange();
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
    this.notifySelectionChange();
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

  /**
   * Advance GIF playback by deltaSeconds.
   * Resolves the current frame and swaps entity.imageBitmap.
   */
  advanceGifPlayback(entityId: string, deltaSeconds: number): void {
    const entity = this.state.entities.get(entityId);
    if (!entity || entity.mediaSource.type !== MediaType.gif || !entity.playback?.isPlaying) return;

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

    // Resolve the frame to display
    const frame = getFrameAtTime(frames, entity.playback.currentTime, loop);
    entity.imageBitmap = frame.bitmap;
    // Mark as dirty so renderer picks up the new frame
    entity.textureDirty = true;
    this.state.entitiesDirty.add(entityId);
  }

  // Mark container as needing resize handling (no React notification needed)
  setContainerDirty(): void {
    this.state.containerSizeDirty = true;
  }

  // Snapshot for rendering (called once per frame)
  getRenderState(): RenderState {
    return {
      viewport: {
        offset: {
          x: this.state.viewport.offset.x,
          y: this.state.viewport.offset.y,
        },
        zoom: this.state.viewport.zoom,
      },
      entities: Array.from(this.state.entities.values()),
      selectedEntityIds: this.state.selectedEntityIds,
      hoveredEntityId: this.state.hoveredEntityId,
      debugMode: this.state.debugMode,
      dirty:
        this.state.viewportDirty ||
        this.state.entitiesDirty.size > 0 ||
        this.state.selectionDirty ||
        this.state.containerSizeDirty,
      // dragSelectBounds and multiSelectBounds are set by game-loop after calling this method
      dragSelectBounds: null,
      multiSelectBounds: null,
      actionLayerActive: this.state.actionLayerActive,
      actionLayerEntityIds: this.state.actionLayerEntityIds,
    };
  }

  // Clear dirty flags after render
  clearDirtyFlags(): void {
    this.state.viewportDirty = false;
    this.state.entitiesDirty.clear();
    this.state.selectionDirty = false;
    this.state.containerSizeDirty = false;
    this.state.frameCount++;
  }

  // Imperative getter for on-demand viewport access (no subscription)
  getViewport(): Viewport {
    return this.state.viewport;
  }

  // ============================================================================
  // Notification Helpers (use base class notify())
  // ============================================================================

  private notifyViewportChange(): void {
    // Only increment viewportVersion, NOT version
    // This ensures useViewport() re-renders but useCanvas()/provider does NOT
    this.state.viewportVersion++;
    this.notify();
  }

  private notifySelectionChange(): void {
    // Increment selectionVersion, version, AND playbackVersion
    // playbackVersion is included because getPlaybackSnapshot depends on selected entity
    this.state.selectionVersion++;
    this.state.version++;
    this.state.playbackVersion++;
    this.notify();
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

    // Check if all selected shader types support this param,
    // including conditional visibility rules (e.g. dithering scale, glass sub-params).
    // Rules are evaluated per-entity to correctly handle multi-select with mixed shader types.
    const isSupported = entities.every((e) => {
      if (!shaderFeatures[e.shaderType].params.includes(rootParam)) return false;
      const rules = paramVisibilityRules[e.shaderType];
      if (rules) {
        const rule = rules.find((r) => r.param === path);
        if (rule && !rule.isVisible(e.shaderParams)) return false;
      }
      return true;
    });

    const firstValue = getNestedValue<T>(entities[0]!.shaderParams, pathParts) ?? defaultValue;

    if (entities.length === 1) {
      const values = new Set<NonNullable<T>>();
      if (firstValue != null) values.add(firstValue as NonNullable<T>);
      return { value: firstValue, isMixed: false, isSupported, values };
    }

    // Multi-select: check uniformity and collect distinct values
    const values = new Set<NonNullable<T>>();
    let isMixed = false;

    for (const entity of entities) {
      // Apply default to get effective value (matches how firstValue is computed)
      const val = getNestedValue<T>(entity.shaderParams, pathParts) ?? defaultValue;
      if (val != null) values.add(val as NonNullable<T>);

      if (!isMixed) {
        if (val !== firstValue) {
          if (typeof val === "object" && typeof firstValue === "object") {
            if (JSON.stringify(val) !== JSON.stringify(firstValue)) {
              isMixed = true;
            }
          } else {
            isMixed = true;
          }
        }
      }
    }

    return { value: firstValue, isMixed, isSupported, values };
  }

  #resetSelectorCaches(): void {
    this.#selectedEntitiesCache = [];
    this.#selectionStateCache = null;
    this.#paramResultCache.clear();
  }
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

function computeSelectionState(entities: ShaderCanvasEntity[]): SelectionState {
  if (entities.length === 0) {
    return {
      entityIds: new Set(),
      count: 0,
      isEmpty: true,
      isSingle: false,
      isMultiple: false,
      shaderTypes: new Set(),
      hasUniformShader: false,
      commonParams: [],
      colorMode: "mixed",
      paramValues: {},
    };
  }

  const shaderTypes = new Set(entities.map((entity) => entity.shaderType));
  const { params: commonParams, colorMode } = getCommonFeatures([...shaderTypes]);
  const paramValues: Record<string, { isUniform: boolean; value: unknown; values: Set<unknown> }> =
    {};

  for (const param of commonParams) {
    const values = new Set(
      entities.map((entity) => {
        const value = entity.shaderParams[param];
        return typeof value === "object" ? JSON.stringify(value) : value;
      }),
    );
    const firstValue = entities[0]?.shaderParams[param];
    paramValues[param] = {
      isUniform: values.size === 1,
      value: values.size === 1 ? (firstValue ?? null) : null,
      values: new Set(entities.map((entity) => entity.shaderParams[param])),
    };
  }

  return {
    entityIds: new Set(entities.map((entity) => entity.id)),
    count: entities.length,
    isEmpty: false,
    isSingle: entities.length === 1,
    isMultiple: entities.length > 1,
    shaderTypes,
    hasUniformShader: shaderTypes.size === 1,
    commonParams,
    colorMode,
    paramValues: paramValues as SelectionState["paramValues"],
  };
}

function sameReferenceArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
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
