import type { AnimationScheduler } from "#lib/animation-scheduler.ts";
import {
  activateVideoElement,
  hasActiveVideoSource,
  isMediaPlaybackInterruption,
  suspendVideoElement,
} from "#lib/media-resources.ts";
import { MediaType, type Bounds, type ShaderCanvasEntity, type Viewport } from "#types/canvas.ts";
import {
  canvasStore,
  type ActionLayerRenderState,
  type DisintegrationRenderState,
  type DragVisualRenderState,
  type DragSelectMode,
  type RenderState,
} from "./canvas-store.ts";
import type { FrameStats } from "./perf-overlay.ts";

interface VideoFrameTracker {
  video: HTMLVideoElement;
  requestId: number | null;
  dirty: boolean;
  initialized: boolean;
  fallbackFrameIndex: number;
  generation: number;
  visible: boolean;
}

export interface CanvasRendererPort {
  readonly isReady: boolean;
  readonly device: GPUDevice | null;
  readonly colorConfig: {
    readonly canvasFormat: GPUTextureFormat;
    readonly canvasColorSpace: PredefinedColorSpace;
  };
  render(state: RenderState): void;
  getFrameStats(): FrameStats;
  hasPendingRenderWork(): boolean;
  needsContinuousRenderForEntity(entity: ShaderCanvasEntity): boolean;
  isEntityVisible(entity: ShaderCanvasEntity, viewport: Viewport): boolean;
}

interface FrameLoopDeps {
  scheduler: AnimationScheduler;
  videoPlayback: {
    maxActiveElements: number;
    minScreenEdge: number;
  };
  perf: {
    setRenderer(
      device: GPUDevice | null,
      canvasFormat: GPUTextureFormat | null,
      canvasColorSpace?: PredefinedColorSpace,
    ): void;
    onFrame(debugMode: boolean, timestamp?: number): void;
    onRender(frameStats: FrameStats, debugMode: boolean): void;
  };
}

interface FrameLoopCallbacks {
  processInput(): void;
  getDragSelectBounds(): Bounds | null;
  getDragSelectRenderMode(): DragSelectMode | null;
  getMultiSelectBounds(): Bounds | null;
  getActionLayerRenderState(): ActionLayerRenderState;
  getDragVisualRenderState(): DragVisualRenderState;
  getDisintegrationRenderState(now: number): DisintegrationRenderState;
  isPointerDragging(): boolean;
  isDragSelectActive(): boolean;
  onAfterFrame(): void;
  onRenderError(error: unknown): void;
  onVideoPlaybackError(error: unknown): void;
}

export class FrameLoop {
  readonly #deps: FrameLoopDeps;
  readonly #callbacks: FrameLoopCallbacks;
  #renderer: CanvasRendererPort | null = null;
  #running = false;
  #animationFrameId: number | null = null;
  #videoFrameTrackers = new Map<string, VideoFrameTracker>();
  #videoFrameTrackerGeneration = 0;
  #firstFrameRendered = false;
  #lastFrameTime: number | null = null;
  #activeEntityVersion = -1;
  #activeEntityCount = 0;
  readonly #classifiedEntityIds = new Set<string>();
  #playingGifs = new Map<string, ShaderCanvasEntity>();
  #playingVideos = new Map<string, ShaderCanvasEntity>();
  readonly #videoPlaybackCandidates: ShaderCanvasEntity[] = [];
  readonly #admittedVideoIds = new Set<string>();
  readonly #budgetSuspendedVideoIds = new Set<string>();
  readonly #resumingVideoIds = new Set<string>();
  readonly #resumeFailedVideoIds = new Set<string>();
  #continuousShaderEntities = new Map<string, ShaderCanvasEntity>();

  constructor(deps: FrameLoopDeps, callbacks: FrameLoopCallbacks) {
    this.#deps = deps;
    this.#callbacks = callbacks;
  }

  setRenderer(renderer: CanvasRendererPort): void {
    this.#renderer = renderer;
    this.#deps.perf.setRenderer(
      renderer.device,
      renderer.colorConfig.canvasFormat,
      renderer.colorConfig.canvasColorSpace,
    );
    this.#firstFrameRendered = false;
    this.#activeEntityVersion = -1;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#tick();
  }

  stop(): void {
    this.#running = false;
    this.#lastFrameTime = null;
    this.#clearVideoFrameTrackers();
    if (this.#animationFrameId !== null) {
      cancelAnimationFrame(this.#animationFrameId);
      this.#animationFrameId = null;
    }
  }

  #tick = (): void => {
    if (!this.#running) return;

    // 1. Compute delta time for GIF playback advancement
    const now = performance.now();
    const deltaSeconds = this.#lastFrameTime !== null ? (now - this.#lastFrameTime) / 1000 : 0;
    this.#lastFrameTime = now;

    let hasAnimatedFrameUpdate = false;
    this.#videoFrameTrackerGeneration++;
    this.#refreshActiveEntities();

    // 2. Advance GIF playback and update video time for all playing animated entities.
    // Uses entity refs directly — getRenderState() is deferred until after all ticks
    // so the viewport snapshot reflects this frame's updates, not the previous frame's.
    const viewport = canvasStore.getState().viewport;
    this.#updateVideoPlaybackBudget(viewport, deltaSeconds);
    for (const entity of this.#playingGifs.values()) {
      if (entity.mediaSource.type !== MediaType.gif || !entity.playback?.isPlaying) continue;
      const updateFrame = this.#renderer?.isEntityVisible(entity, viewport) ?? true;
      const frameChanged = canvasStore.advanceGifPlayback(entity.id, deltaSeconds, updateFrame);
      canvasStore.updateGifPlaybackTime(entity.id, entity.playback.currentTime);
      if (frameChanged) hasAnimatedFrameUpdate = true;
    }
    for (const entity of this.#playingVideos.values()) {
      if (entity.mediaSource.type !== MediaType.video || !entity.playback?.isPlaying) continue;
      if (this.#budgetSuspendedVideoIds.has(entity.id)) continue;
      const video = entity.mediaSource.videoElement;
      const isVisible = this.#renderer?.isEntityVisible(entity, viewport) ?? true;
      canvasStore.updatePlaybackTime(entity.id, video.currentTime);
      if (this.#consumeVideoFrameUpdate(entity.id, video, entity.mediaSource.fps, isVisible)) {
        canvasStore.markEntityTextureDirty(entity.id);
        hasAnimatedFrameUpdate = true;
      }
    }
    this.#cleanupInactiveVideoFrameTrackers();

    // 3. Advance all scheduler-managed animations (viewport, etc.)
    this.#deps.scheduler.tick(now);

    // 4. Process input (hover detection, drag updates)
    this.#callbacks.processInput();

    const debugMode = canvasStore.getState().debugMode;
    this.#deps.perf.onFrame(debugMode, now);

    // 7. Determine if we need to render this frame
    const needsRender =
      !this.#firstFrameRendered ||
      canvasStore.hasRenderChanges() ||
      hasAnimatedFrameUpdate ||
      this.#hasVisibleContinuousShader(canvasStore.getState().viewport) ||
      this.#deps.scheduler.hasActive ||
      this.#callbacks.isPointerDragging() ||
      this.#callbacks.isDragSelectActive() ||
      this.#renderer?.hasPendingRenderWork();

    // 8. Render only when needed (skip idle frames)
    if (this.#renderer?.isReady && needsRender) {
      // Snapshot the O(entity count) render array only after deciding that a frame is needed.
      const renderState = canvasStore.getRenderState();
      renderState.dragSelectBounds = this.#callbacks.getDragSelectBounds();
      renderState.dragSelectMode = this.#callbacks.getDragSelectRenderMode();
      renderState.multiSelectBounds = this.#callbacks.getMultiSelectBounds();
      renderState.actionLayer = this.#callbacks.getActionLayerRenderState();
      renderState.dragVisual = this.#callbacks.getDragVisualRenderState();
      renderState.disintegration = this.#callbacks.getDisintegrationRenderState(now);

      try {
        this.#renderer.render(renderState);
        this.#firstFrameRendered = true;
        this.#deps.perf.onRender(this.#renderer.getFrameStats(), debugMode);
      } catch (error) {
        this.#callbacks.onRenderError(error);
      }
    }

    // 10. Clear dirty flags
    canvasStore.clearDirtyFlags();

    // 11. Run frame-end work after the final touch-driven viewport has passed
    // through this render tick.
    this.#callbacks.onAfterFrame();

    // 12. Schedule next frame
    this.#animationFrameId = requestAnimationFrame(this.#tick);
  };

  #refreshActiveEntities(): void {
    const state = canvasStore.getState();
    if (state.entityVersion === this.#activeEntityVersion) return;

    const hasActiveSnapshot = this.#activeEntityVersion >= 0;
    this.#activeEntityVersion = state.entityVersion;
    let canPatch =
      hasActiveSnapshot &&
      this.#activeEntityCount === state.entities.size &&
      state.entitiesDirty.size > 0;
    if (canPatch) {
      for (const entityId of state.entitiesDirty) {
        if (!this.#classifiedEntityIds.has(entityId)) {
          canPatch = false;
          break;
        }
      }
    }
    this.#activeEntityCount = state.entities.size;
    if (canPatch) {
      for (const entityId of state.entitiesDirty) {
        this.#playingGifs.delete(entityId);
        this.#playingVideos.delete(entityId);
        this.#continuousShaderEntities.delete(entityId);
        const entity = state.entities.get(entityId);
        if (entity) this.#classifyActiveEntity(entity);
      }
      return;
    }

    this.#playingGifs.clear();
    this.#playingVideos.clear();
    this.#continuousShaderEntities.clear();
    this.#classifiedEntityIds.clear();
    for (const entity of state.entities.values()) {
      this.#classifiedEntityIds.add(entity.id);
      this.#classifyActiveEntity(entity);
    }
  }

  #classifyActiveEntity(entity: ShaderCanvasEntity): void {
    if (entity.mediaSource.type === MediaType.gif && entity.playback?.isPlaying) {
      this.#playingGifs.set(entity.id, entity);
    } else if (entity.mediaSource.type === MediaType.video && entity.playback?.isPlaying) {
      this.#playingVideos.set(entity.id, entity);
    }
    if (this.#renderer?.needsContinuousRenderForEntity(entity)) {
      this.#continuousShaderEntities.set(entity.id, entity);
    }
  }

  #updateVideoPlaybackBudget(viewport: Viewport, deltaSeconds: number): void {
    const { maxActiveElements, minScreenEdge } = this.#deps.videoPlayback;
    this.#videoPlaybackCandidates.length = 0;
    this.#admittedVideoIds.clear();
    const selected = canvasStore.getState().selectedEntityIds;

    for (const entity of this.#playingVideos.values()) {
      if (entity.mediaSource.type !== MediaType.video || !entity.playback?.isPlaying) continue;
      const isVisible = this.#renderer?.isEntityVisible(entity, viewport) ?? true;
      const screenEdge = Math.max(entity.size.width, entity.size.height) * viewport.zoom;
      if (isVisible && (selected.has(entity.id) || screenEdge >= minScreenEdge)) {
        this.#videoPlaybackCandidates.push(entity);
      }
    }

    if (this.#videoPlaybackCandidates.length > maxActiveElements) {
      this.#videoPlaybackCandidates.sort((left, right) => {
        const selectionDifference = Number(selected.has(right.id)) - Number(selected.has(left.id));
        if (selectionDifference !== 0) return selectionDifference;
        const rightArea = right.size.width * right.size.height;
        const leftArea = left.size.width * left.size.height;
        if (rightArea !== leftArea) return rightArea - leftArea;
        return right.zIndex - left.zIndex;
      });
    }

    const admittedCount = Math.min(maxActiveElements, this.#videoPlaybackCandidates.length);
    for (let index = 0; index < admittedCount; index++) {
      this.#admittedVideoIds.add(this.#videoPlaybackCandidates[index]!.id);
    }

    for (const entity of this.#playingVideos.values()) {
      if (entity.mediaSource.type !== MediaType.video || !entity.playback?.isPlaying) continue;
      if (this.#admittedVideoIds.has(entity.id)) this.#resumeBudgetSuspendedVideo(entity);
      else this.#suspendOrAdvanceVideo(entity, deltaSeconds);
    }
    for (const entityId of this.#budgetSuspendedVideoIds) {
      if (!this.#playingVideos.has(entityId)) this.#budgetSuspendedVideoIds.delete(entityId);
    }
    for (const entityId of this.#resumeFailedVideoIds) {
      if (!this.#playingVideos.has(entityId)) this.#resumeFailedVideoIds.delete(entityId);
    }
  }

  #suspendOrAdvanceVideo(entity: ShaderCanvasEntity, deltaSeconds: number): void {
    if (entity.mediaSource.type !== MediaType.video || !entity.playback) return;
    const video = entity.mediaSource.videoElement;
    if (!this.#budgetSuspendedVideoIds.has(entity.id)) {
      if (hasActiveVideoSource(video)) {
        entity.playback.currentTime = video.currentTime;
        suspendVideoElement(video);
        canvasStore.markEntityTextureDirty(entity.id);
      }
      this.#budgetSuspendedVideoIds.add(entity.id);
      return;
    }

    const duration = entity.mediaSource.duration;
    const next = entity.playback.currentTime + deltaSeconds * entity.playback.playbackRate;
    const currentTime =
      entity.playback.loop && duration > 0
        ? ((next % duration) + duration) % duration
        : Math.max(0, Math.min(next, duration));
    canvasStore.updatePlaybackTime(entity.id, currentTime);
  }

  #resumeBudgetSuspendedVideo(entity: ShaderCanvasEntity): void {
    if (entity.mediaSource.type !== MediaType.video || !entity.playback) return;
    const video = entity.mediaSource.videoElement;
    if (hasActiveVideoSource(video) && !video.paused) {
      this.#budgetSuspendedVideoIds.delete(entity.id);
      return;
    }
    if (this.#resumingVideoIds.has(entity.id) || this.#resumeFailedVideoIds.has(entity.id)) return;
    this.#budgetSuspendedVideoIds.add(entity.id);
    this.#resumingVideoIds.add(entity.id);
    const expectedEntity = entity;
    void activateVideoElement(video, entity.mediaSource.blob)
      .then(async () => {
        if (
          canvasStore.getState().entities.get(entity.id) !== expectedEntity ||
          !entity.playback?.isPlaying ||
          !this.#admittedVideoIds.has(entity.id)
        ) {
          suspendVideoElement(video);
          return;
        }
        video.currentTime = entity.playback!.currentTime;
        video.loop = entity.playback!.loop;
        video.muted = entity.playback!.muted;
        video.playbackRate = entity.playback!.playbackRate;
        video.volume = entity.playback!.volume;
        await video.play();
        this.#budgetSuspendedVideoIds.delete(entity.id);
        this.#resumeFailedVideoIds.delete(entity.id);
        canvasStore.markEntityTextureDirty(entity.id);
      })
      .catch((error) => {
        if (isMediaPlaybackInterruption(error)) return;
        this.#resumeFailedVideoIds.add(entity.id);
        this.#callbacks.onVideoPlaybackError(error);
      })
      .finally(() => this.#resumingVideoIds.delete(entity.id));
  }

  #hasVisibleContinuousShader(viewport: Viewport): boolean {
    for (const entity of this.#continuousShaderEntities.values()) {
      if (this.#renderer?.isEntityVisible(entity, viewport) ?? true) return true;
    }
    return false;
  }

  #consumeVideoFrameUpdate(
    entityId: string,
    video: HTMLVideoElement,
    fps: number | null,
    isVisible: boolean,
  ): boolean {
    let tracker = this.#videoFrameTrackers.get(entityId);
    if (!tracker || tracker.video !== video) {
      if (tracker) this.#cancelVideoFrameCallback(tracker);
      tracker = {
        video,
        requestId: null,
        dirty: true,
        initialized: false,
        fallbackFrameIndex: this.#getVideoFallbackFrameIndex(video, fps),
        generation: this.#videoFrameTrackerGeneration,
        visible: false,
      };
      this.#videoFrameTrackers.set(entityId, tracker);
    }

    tracker.generation = this.#videoFrameTrackerGeneration;
    const becameVisible = isVisible && !tracker.visible;
    tracker.visible = isVisible;

    if ("requestVideoFrameCallback" in video) {
      this.#scheduleVideoFrameCallback(entityId, tracker);
      if (!tracker.initialized) {
        tracker.initialized = true;
        tracker.dirty = true;
      }
      if (!tracker.dirty) return becameVisible;
      tracker.dirty = false;
      return isVisible;
    }

    const frameIndex = this.#getVideoFallbackFrameIndex(video, fps);
    if (!tracker.initialized) {
      tracker.initialized = true;
      tracker.fallbackFrameIndex = frameIndex;
      return isVisible;
    }
    if (frameIndex === tracker.fallbackFrameIndex) return becameVisible;

    tracker.fallbackFrameIndex = frameIndex;
    return isVisible;
  }

  #scheduleVideoFrameCallback(entityId: string, tracker: VideoFrameTracker): void {
    if (tracker.requestId !== null) return;
    if (!("requestVideoFrameCallback" in tracker.video)) return;

    tracker.requestId = tracker.video.requestVideoFrameCallback(() => {
      tracker.requestId = null;
      if (this.#videoFrameTrackers.get(entityId) !== tracker) return;

      tracker.dirty = true;
      if (!tracker.video.paused && !tracker.video.ended) {
        this.#scheduleVideoFrameCallback(entityId, tracker);
      }
    });
  }

  #getVideoFallbackFrameIndex(video: HTMLVideoElement, fps: number | null): number {
    const effectiveFps = fps && Number.isFinite(fps) && fps > 0 ? fps : 30;
    return Math.floor(video.currentTime * effectiveFps + 0.0001);
  }

  #cleanupInactiveVideoFrameTrackers(): void {
    for (const [entityId, tracker] of this.#videoFrameTrackers) {
      if (tracker.generation === this.#videoFrameTrackerGeneration) continue;

      this.#cancelVideoFrameCallback(tracker);
      this.#videoFrameTrackers.delete(entityId);
    }
  }

  #clearVideoFrameTrackers(): void {
    for (const tracker of this.#videoFrameTrackers.values()) {
      this.#cancelVideoFrameCallback(tracker);
    }
    this.#videoFrameTrackers.clear();
  }

  #cancelVideoFrameCallback(tracker: VideoFrameTracker): void {
    if (tracker.requestId === null) return;

    if ("cancelVideoFrameCallback" in tracker.video) {
      tracker.video.cancelVideoFrameCallback(tracker.requestId);
    }
    tracker.requestId = null;
  }
}
