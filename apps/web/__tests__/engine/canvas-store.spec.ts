import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { canvasStore } from "#engine";
import { isVideoEntity, type ShaderCanvasEntity } from "#types/canvas.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { createTestEntity, resetEntityCounter } from "../helpers/test-entity.ts";

let cleanup: () => void;

function getVideoCurrentTime(entity: ShaderCanvasEntity): number {
  if (!isVideoEntity(entity)) {
    throw new Error(`Expected video entity, received ${entity.mediaSource.type}`);
  }

  return entity.mediaSource.videoElement.currentTime;
}

beforeEach(() => {
  cleanup = setupCanvasTest();
  resetEntityCounter();
});

afterEach(() => {
  cleanup();
});

describe("canvasStore viewport subscriptions", () => {
  test("viewport changes do not notify general store subscribers", () => {
    let generalNotifications = 0;
    let viewportNotifications = 0;

    const unsubscribeGeneral = canvasStore.subscribe(() => {
      generalNotifications++;
    });
    const unsubscribeViewport = canvasStore.subscribeViewport(() => {
      viewportNotifications++;
    });

    canvasStore.panBy({ x: 12, y: -8 });

    expect(viewportNotifications).toBe(1);
    expect(generalNotifications).toBe(0);

    unsubscribeGeneral();
    unsubscribeViewport();
  });
});

describe("canvasStore entity versioning", () => {
  test("rejects a duplicate entity ID without replacing the existing entity", () => {
    const existing = createTestEntity({ id: "duplicate-id" });
    const replacement = createTestEntity({ id: existing.id, name: "Replacement" });
    canvasStore.addEntity(existing);

    expect(() => canvasStore.addEntity(replacement)).toThrow(
      'Cannot add duplicate entity ID "duplicate-id"',
    );
    expect(canvasStore.getState().entities.get(existing.id)).toBe(existing);
    expect(canvasStore.getState().entityIds).toEqual([existing.id]);
  });

  test("rejects duplicate IDs in a batch atomically", () => {
    const duplicateId = "duplicate-batch-id";
    const first = createTestEntity({ id: duplicateId });
    const second = createTestEntity({ id: duplicateId });

    expect(() => canvasStore.addEntities([first, second])).toThrow(
      'Cannot add duplicate entity ID "duplicate-batch-id"',
    );
    expect(canvasStore.getState().entities.size).toBe(0);
    expect(canvasStore.getState().entityIds).toEqual([]);
  });

  test("selection changes do not invalidate entity-derived caches", () => {
    const entity = createTestEntity();
    canvasStore.addEntity(entity);
    const entityVersion = canvasStore.getState().entityVersion;

    canvasStore.replaceSelection([entity.id]);
    canvasStore.clearSelection();

    expect(canvasStore.getState().entityVersion).toBe(entityVersion);
  });

  test("entity changes increment the entity version", () => {
    const entity = createTestEntity();
    const initialVersion = canvasStore.getState().entityVersion;

    canvasStore.addEntity(entity);
    canvasStore.updateEntity(entity.id, { zIndex: 4 });
    canvasStore.removeEntity(entity.id);

    expect(canvasStore.getState().entityVersion).toBe(initialVersion + 3);
  });

  test("exposes transform-cache versions without invalidating them for viewport or selection", () => {
    const entity = createTestEntity({ id: "render-version-entity" });
    canvasStore.addEntity(entity);
    const initial = canvasStore.getRenderState();
    const initialEntityVersion = initial.entityVersion;
    const initialGeometryVersion = initial.geometryVersion;

    canvasStore.panBy({ x: 20, y: 10 });
    canvasStore.replaceSelection([entity.id]);
    expect(canvasStore.getRenderState()).toMatchObject({
      entityVersion: initialEntityVersion,
      geometryVersion: initialGeometryVersion,
    });

    canvasStore.moveEntity(entity.id, { x: 5, y: -2 });
    expect(canvasStore.getRenderState()).toMatchObject({
      entityVersion: initialEntityVersion,
      geometryVersion: initialGeometryVersion + 1,
    });

    canvasStore.updateEntity(entity.id, { rotation: 15 });
    expect(canvasStore.getRenderState()).toMatchObject({
      entityVersion: initialEntityVersion + 1,
      geometryVersion: initialGeometryVersion + 1,
    });
  });
});

describe("canvasStore large selection access", () => {
  test("selects all entities without an intermediate caller-owned ID array", () => {
    const entities = [
      createTestEntity({ id: "select-all-first" }),
      createTestEntity({ id: "select-all-second" }),
    ];
    canvasStore.addEntities(entities);
    const listener = vi.fn<() => void>();
    const unsubscribe = canvasStore.subscribe(listener);

    canvasStore.selectAll();
    canvasStore.selectAll();

    expect([...canvasStore.getSelectedEntityIds()]).toEqual(entities.map(({ id }) => id));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("materializes selected entities once per selection version", () => {
    const entities = [
      createTestEntity({ id: "stable-selection-first" }),
      createTestEntity({ id: "stable-selection-second" }),
    ];
    canvasStore.addEntities(entities);
    canvasStore.selectAll();
    const materialize = vi.spyOn(canvasStore, "getSelectedEntities");

    const first = canvasStore.getSelectedEntitiesStable();
    const second = canvasStore.getSelectedEntitiesStable();

    expect(second).toBe(first);
    expect(materialize).toHaveBeenCalledTimes(1);

    canvasStore.clearSelection();
    expect(canvasStore.getSelectedEntitiesStable()).toEqual([]);
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  test("deduplicates structurally equal object params across cloned entities", () => {
    const first = createTestEntity({ id: "cloned-param-first" });
    const second = createTestEntity({
      id: "cloned-param-second",
      shaderParams: { palette: structuredClone(first.shaderParams.palette) },
    });
    canvasStore.addEntities([first, second]);
    canvasStore.selectAll();

    const palette = canvasStore.getParamResult("palette", null);

    expect(palette.isMixed).toBe(false);
    expect(palette.values.size).toBe(1);
  });
});

// ============================================================================
// Video Playback Store Methods
// ============================================================================

describe("canvasStore.seekVideo", () => {
  test("updates video currentTime", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);

    canvasStore.seekVideo(entity.id, 50);

    expect(getVideoCurrentTime(entity)).toBe(50);
  });

  test("updates playback.currentTime", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);

    canvasStore.seekVideo(entity.id, 50);

    expect(entity.playback?.currentTime).toBe(50);
  });

  test("clamps to valid range", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);

    canvasStore.seekVideo(entity.id, 150);

    expect(getVideoCurrentTime(entity)).toBe(100);

    canvasStore.seekVideo(entity.id, -10);

    expect(getVideoCurrentTime(entity)).toBe(0);
  });

  test("marks texture as dirty", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    entity.textureDirty = false;
    canvasStore.addEntity(entity);

    canvasStore.seekVideo(entity.id, 50);

    expect(entity.textureDirty).toBe(true);
  });

  test("updates logical time without opening a dormant decoder", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    if (entity.mediaSource.type !== "video") throw new Error("Expected video entity");
    entity.mediaSource.videoElement.removeAttribute("src");
    canvasStore.addEntity(entity);

    canvasStore.seekVideo(entity.id, 50);

    expect(entity.mediaSource.videoElement.currentTime).toBe(0);
    expect(entity.playback?.currentTime).toBe(50);
  });

  test("invalidates the decoded texture when an asynchronous seek finishes", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    if (entity.mediaSource.type !== "video") throw new Error("Expected video entity");
    const seekedListeners: EventListener[] = [];
    const addEventListener = vi.fn<
      (type: string, listener: EventListenerOrEventListenerObject) => void
    >((type, listener) => {
      if (type === "seeked" && typeof listener === "function") seekedListeners.push(listener);
    });
    entity.mediaSource.videoElement.addEventListener = addEventListener;
    canvasStore.addEntity(entity);
    entity.textureDirty = false;

    canvasStore.seekVideo(entity.id, 50);
    entity.textureDirty = false;
    seekedListeners[0]?.(new Event("seeked"));

    expect(entity.textureDirty).toBe(true);
    expect(canvasStore.getState().entitiesDirty.has(entity.id)).toBe(true);
  });
});

describe("canvasStore.playVideo", () => {
  test("activates a dormant decoder at its logical playback time", async () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    if (entity.mediaSource.type !== "video" || !entity.playback) {
      throw new Error("Expected video entity with playback");
    }
    entity.mediaSource.videoElement.removeAttribute("src");
    entity.playback.currentTime = 24;
    canvasStore.addEntity(entity);

    await canvasStore.playVideo(entity.id);

    expect(entity.mediaSource.videoElement.src).toMatch(/^blob:mock-/);
    expect(entity.mediaSource.videoElement.currentTime).toBe(24);
    expect(entity.playback.isPlaying).toBe(true);
  });
});

describe("canvasStore.setVideoPlaybackIntent", () => {
  test("starts logical playback without opening a dormant decoder", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    if (entity.mediaSource.type !== "video" || !entity.playback) {
      throw new Error("Expected video entity with playback");
    }
    entity.mediaSource.videoElement.removeAttribute("src");
    canvasStore.addEntity(entity);

    const hasDecoder = canvasStore.setVideoPlaybackIntent(
      entity.id,
      { currentTime: 24, isPlaying: true, loop: true, playbackRate: 1.5 },
      true,
    );

    expect(hasDecoder).toBe(false);
    expect(entity.mediaSource.videoElement.src).toBe("");
    expect(entity.playback).toMatchObject({
      currentTime: 24,
      isPlaying: true,
      loop: true,
      playbackRate: 1.5,
    });
  });

  test("seeks a newly activated decoder to the existing logical intent", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    if (entity.mediaSource.type !== "video" || !entity.playback) {
      throw new Error("Expected video entity with playback");
    }
    entity.mediaSource.videoElement.src = "blob:active";
    entity.mediaSource.videoElement.currentTime = 0;
    entity.playback.currentTime = 24;
    canvasStore.addEntity(entity);

    const hasDecoder = canvasStore.setVideoPlaybackIntent(
      entity.id,
      { currentTime: 24, isPlaying: false, loop: false, playbackRate: 1 },
      true,
    );

    expect(hasDecoder).toBe(true);
    expect(entity.mediaSource.videoElement.currentTime).toBe(24);
  });
});

describe("canvasStore video audio controls", () => {
  test("setVideoMuted updates playback and video element muted state", () => {
    const entity = createTestEntity({ mediaType: "video", videoHasAudio: true });
    canvasStore.addEntity(entity);

    canvasStore.setVideoMuted(entity.id, false);

    expect(entity.playback?.muted).toBe(false);
    expect(entity.mediaSource.type === "video" && entity.mediaSource.videoElement.muted).toBe(
      false,
    );
  });

  test("toggleVideoMuted flips playback and video element muted state", () => {
    const entity = createTestEntity({
      mediaType: "video",
      videoDuration: 100,
      videoHasAudio: true,
      muted: true,
    });
    canvasStore.addEntity(entity);

    canvasStore.toggleVideoMuted(entity.id);

    expect(entity.playback?.muted).toBe(false);
    expect(entity.mediaSource.type === "video" && entity.mediaSource.videoElement.muted).toBe(
      false,
    );
  });

  test("does not change timing, playing state, or selected entity when muting", () => {
    const entity = createTestEntity({
      mediaType: "video",
      videoDuration: 100,
      videoHasAudio: true,
      muted: true,
    });
    canvasStore.addEntity(entity);
    canvasStore.replaceSelection([entity.id]);
    canvasStore.seekVideo(entity.id, 12);
    if (entity.playback) entity.playback.isPlaying = true;

    const selectedBefore = canvasStore.getSelectedEntity()?.id;

    canvasStore.toggleVideoMuted(entity.id);

    expect(entity.playback?.currentTime).toBe(12);
    expect(getVideoCurrentTime(entity)).toBe(12);
    expect(entity.playback?.isPlaying).toBe(true);
    expect(canvasStore.getSelectedEntity()?.id).toBe(selectedBefore);
  });
});

describe("canvasStore.updatePlaybackTime", () => {
  test("updates playback.currentTime", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);
    canvasStore.replaceSelection([entity.id]);

    canvasStore.updatePlaybackTime(entity.id, 50);

    expect(entity.playback?.currentTime).toBe(50);
  });

  test("does not increment selectionVersion", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);
    canvasStore.replaceSelection([entity.id]);

    const initialSelectionVersion = canvasStore.getSelectionSnapshot().version;

    canvasStore.updatePlaybackTime(entity.id, 50);

    // Selection version should NOT change
    expect(canvasStore.getSelectionSnapshot().version).toBe(initialSelectionVersion);
  });

  test("does not increment playbackVersion for unselected videos", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);

    const initialVersion = canvasStore.getPlaybackSnapshot().version;

    canvasStore.updatePlaybackTime(entity.id, 50);

    expect(entity.playback?.currentTime).toBe(50);
    expect(canvasStore.getPlaybackSnapshot().version).toBe(initialVersion);
  });

  test("increments playbackVersion via forcePlaybackNotify", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);
    canvasStore.replaceSelection([entity.id]);

    const initialVersion = canvasStore.getPlaybackSnapshot().version;

    // updatePlaybackTime is throttled (60fps cap), use forcePlaybackNotify for immediate notification
    canvasStore.forcePlaybackNotify(entity.id, 50);

    expect(canvasStore.getPlaybackSnapshot().version).toBe(initialVersion + 1);
  });

  test("updates playback snapshot currentTime", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);
    canvasStore.replaceSelection([entity.id]);

    canvasStore.updatePlaybackTime(entity.id, 75);

    const snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.currentTime).toBe(75);
    expect(snapshot.entityId).toBe(entity.id);
  });
});

describe("canvasStore.pauseVideo", () => {
  test("replaces the pause snapshot bitmap and closes the previous fallback bitmap", async () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    const previousClose = vi.fn<() => void>();
    entity.imageBitmap = { ...entity.imageBitmap, close: previousClose };
    canvasStore.addEntity(entity);

    canvasStore.pauseVideo(entity.id);
    await Promise.resolve();

    expect(previousClose).toHaveBeenCalledOnce();
    expect(entity.textureDirty).toBe(true);
  });

  test("preserves logical time and the poster while the decoder is dormant", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    if (entity.mediaSource.type !== "video" || !entity.playback) {
      throw new Error("Expected video entity with playback");
    }
    entity.mediaSource.videoElement.removeAttribute("src");
    entity.playback.currentTime = 24;
    entity.playback.isPlaying = true;
    const poster = entity.imageBitmap;
    canvasStore.addEntity(entity);

    canvasStore.pauseVideo(entity.id);

    expect(entity.playback.currentTime).toBe(24);
    expect(entity.playback.isPlaying).toBe(false);
    expect(entity.imageBitmap).toBe(poster);
  });
});

// ============================================================================
// GIF Playback Store Methods
// ============================================================================

describe("canvasStore.seekGif", () => {
  test("updates playback.currentTime", () => {
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 2, gifFrameCount: 20 });
    canvasStore.addEntity(entity);

    canvasStore.seekGif(entity.id, 1.0);

    expect(entity.playback?.currentTime).toBe(1.0);
  });

  test("clamps to valid range", () => {
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 2, gifFrameCount: 20 });
    canvasStore.addEntity(entity);

    canvasStore.seekGif(entity.id, 5.0);
    expect(entity.playback?.currentTime).toBe(2.0);

    canvasStore.seekGif(entity.id, -1.0);
    expect(entity.playback?.currentTime).toBe(0);
  });

  test("updates imageBitmap to correct frame", () => {
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 1, gifFrameCount: 10 });
    canvasStore.addEntity(entity);

    // Seek to middle of GIF
    canvasStore.seekGif(entity.id, 0.5);

    // imageBitmap should be updated to the frame at seek position
    expect(entity.imageBitmap).toBeDefined();
  });

  test("marks texture as dirty", () => {
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 2, gifFrameCount: 20 });
    entity.textureDirty = false;
    canvasStore.addEntity(entity);

    canvasStore.seekGif(entity.id, 1.0);

    expect(entity.textureDirty).toBe(true);
  });
});

describe("canvasStore.updateGifPlaybackTime", () => {
  test("updates playback.currentTime", () => {
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 2 });
    canvasStore.addEntity(entity);
    canvasStore.replaceSelection([entity.id]);

    canvasStore.updateGifPlaybackTime(entity.id, 1.0);

    expect(entity.playback?.currentTime).toBe(1.0);
  });

  test("does not increment selectionVersion", () => {
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 2 });
    canvasStore.addEntity(entity);
    canvasStore.replaceSelection([entity.id]);

    const initialSelectionVersion = canvasStore.getSelectionSnapshot().version;

    canvasStore.updateGifPlaybackTime(entity.id, 1.0);

    expect(canvasStore.getSelectionSnapshot().version).toBe(initialSelectionVersion);
  });

  test("does not increment playbackVersion for unselected GIFs", () => {
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 2 });
    canvasStore.addEntity(entity);

    const initialVersion = canvasStore.getPlaybackSnapshot().version;

    canvasStore.updateGifPlaybackTime(entity.id, 1.0);

    expect(entity.playback?.currentTime).toBe(1.0);
    expect(canvasStore.getPlaybackSnapshot().version).toBe(initialVersion);
  });

  test("increments playbackVersion via forcePlaybackNotify", () => {
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 2 });
    canvasStore.addEntity(entity);
    canvasStore.replaceSelection([entity.id]);

    const initialVersion = canvasStore.getPlaybackSnapshot().version;

    // updateGifPlaybackTime is throttled (60fps cap), use forcePlaybackNotify for immediate notification
    canvasStore.forcePlaybackNotify(entity.id, 1.0);

    expect(canvasStore.getPlaybackSnapshot().version).toBe(initialVersion + 1);
  });
});

describe("canvasStore.moveEntity", () => {
  test("reuses one render state and entity array across viewport-only frames", () => {
    const firstEntity = createTestEntity({ id: "stable-render-first", zIndex: 2 });
    const secondEntity = createTestEntity({ id: "stable-render-second", zIndex: 1 });
    canvasStore.addEntities([firstEntity, secondEntity]);

    const first = canvasStore.getRenderState();
    const entities = first.entities;
    const initialOffset = { ...first.viewport.offset };
    expect(entities.map(({ id }) => id)).toEqual([secondEntity.id, firstEntity.id]);

    canvasStore.panBy({ x: 40, y: 20 });
    const second = canvasStore.getRenderState();
    expect(second).toBe(first);
    expect(second.entities).toBe(entities);
    expect(second.viewport.offset).toEqual({
      x: initialOffset.x + 40,
      y: initialOffset.y + 20,
    });
  });

  test("patches changed entity references in the stable render array", () => {
    const firstEntity = createTestEntity({ id: "render-patch-first", zIndex: 1 });
    const secondEntity = createTestEntity({ id: "render-patch-second", zIndex: 2 });
    canvasStore.addEntities([firstEntity, secondEntity]);
    const initial = canvasStore.getRenderState();
    const entities = initial.entities;
    canvasStore.clearDirtyFlags();

    const shaderParams = { ...secondEntity.shaderParams, size: secondEntity.shaderParams.size + 1 };
    canvasStore.updateEntity(secondEntity.id, { shaderParams, textureDirty: true });
    const updated = canvasStore.getRenderState();

    expect(updated.entities).toBe(entities);
    expect(updated.entities[0]).toBe(firstEntity);
    expect(updated.entities[1]).not.toBe(secondEntity);
    expect(updated.entities[1]?.shaderParams).toBe(shaderParams);
    expect(updated.dirtyEntityIds).toEqual(new Set([secondEntity.id]));
  });

  test("marks render state dirty for position-only updates", () => {
    const entity = createTestEntity();
    canvasStore.addEntity(entity);
    canvasStore.clearDirtyFlags();

    canvasStore.moveEntity(entity.id, { x: 24, y: -12 });

    const renderState = canvasStore.getRenderState();
    const moved = renderState.entities.find(({ id }) => id === entity.id);

    expect(moved?.position).toEqual({ x: 24, y: -12 });
    expect(renderState.dirty).toBe(true);
  });

  test("dirty flag clears after render bookkeeping", () => {
    const entity = createTestEntity();
    canvasStore.addEntity(entity);
    canvasStore.clearDirtyFlags();

    canvasStore.moveEntity(entity.id, { x: 1, y: 1 });
    expect(canvasStore.getRenderState().dirty).toBe(true);

    canvasStore.clearDirtyFlags();

    expect(canvasStore.getRenderState().dirty).toBe(false);
  });

  test("reports render changes without allocating a render snapshot", () => {
    const entity = createTestEntity();
    canvasStore.addEntity(entity);
    expect(canvasStore.hasRenderChanges()).toBe(true);

    canvasStore.clearDirtyFlags();
    expect(canvasStore.hasRenderChanges()).toBe(false);

    canvasStore.moveEntity(entity.id, { x: 2, y: 3 });
    expect(canvasStore.hasRenderChanges()).toBe(true);
  });

  test("moves a batch with one geometry-version increment and no dirty-ID population", () => {
    const first = createTestEntity({ id: "move-batch-first" });
    const second = createTestEntity({ id: "move-batch-second", position: { x: 300, y: 0 } });
    canvasStore.addEntities([first, second]);
    canvasStore.clearDirtyFlags();
    const initialGeometryVersion = canvasStore.getState().geometryVersion;

    expect(canvasStore.moveEntities(new Set([first.id, second.id]), { x: 25, y: -10 })).toBe(2);

    expect(first.position).toEqual({ x: 25, y: -10 });
    expect(second.position).toEqual({ x: 325, y: -10 });
    expect(canvasStore.getState().geometryVersion).toBe(initialGeometryVersion + 1);
    expect(canvasStore.getState().entitiesDirty.size).toBe(0);
    expect(canvasStore.hasRenderChanges()).toBe(true);
  });
});

describe("canvasStore.addEntities", () => {
  test("adds a batch with one version notification", () => {
    const first = createTestEntity({ id: "batch-first" });
    const second = createTestEntity({ id: "batch-second" });
    const initialVersion = canvasStore.getState().version;

    canvasStore.addEntities([first, second]);

    expect(canvasStore.getState().version).toBe(initialVersion + 1);
    expect(canvasStore.getState().entities.size).toBe(2);
    expect(canvasStore.getState().entitiesDirty).toEqual(new Set([first.id, second.id]));
  });
});

describe("canvasStore.restoreWorkspace", () => {
  test("restores entities, viewport, and spatial state with one notification", () => {
    const entities = Array.from({ length: 100 }, (_, index) =>
      createTestEntity({
        id: `restored-${index}`,
        position: { x: index * 20, y: 0 },
        size: { width: 10, height: 10 },
        zIndex: index,
      }),
    );
    let generalNotifications = 0;
    let viewportNotifications = 0;
    const unsubscribeGeneral = canvasStore.subscribe(() => generalNotifications++);
    const unsubscribeViewport = canvasStore.subscribeViewport(() => viewportNotifications++);

    canvasStore.restoreWorkspace(entities, {
      offset: { x: 500, y: 250 },
      zoom: 0.5,
    });

    expect(generalNotifications).toBe(1);
    expect(viewportNotifications).toBe(1);
    expect(canvasStore.getState().entitiesDirty.size).toBe(0);
    expect(canvasStore.getRenderState().dirty).toBe(true);
    expect(canvasStore.getViewport()).toEqual({ offset: { x: 500, y: 250 }, zoom: 0.5 });
    expect(canvasStore.queryEntitiesInBounds({ x: 401, y: 1, width: 1, height: 1 }, [])).toEqual([
      entities[20],
    ]);

    unsubscribeGeneral();
    unsubscribeViewport();
  });

  test("rejects duplicate IDs without replacing the current workspace", () => {
    const existing = createTestEntity({ id: "existing" });
    const first = createTestEntity({ id: "duplicate" });
    const second = createTestEntity({ id: "duplicate" });
    canvasStore.addEntity(existing);
    const previousViewport = structuredClone(canvasStore.getViewport());

    expect(() =>
      canvasStore.restoreWorkspace([first, second], {
        offset: { x: 100, y: 200 },
        zoom: 0.5,
      }),
    ).toThrow('Cannot restore duplicate entity ID "duplicate"');

    expect(canvasStore.getState().entities).toEqual(new Map([[existing.id, existing]]));
    expect(canvasStore.getViewport()).toEqual(previousViewport);
  });
});

describe("canvasStore spatial queries", () => {
  test("tracks batch insertion, movement, and removal", () => {
    const first = createTestEntity({
      id: "indexed-first",
      position: { x: 0, y: 0 },
      size: { width: 10, height: 10 },
      zIndex: 2,
    });
    const second = createTestEntity({
      id: "indexed-second",
      position: { x: 5, y: 5 },
      size: { width: 10, height: 10 },
      zIndex: 1,
    });
    canvasStore.addEntities([first, second]);

    expect(
      canvasStore
        .queryEntitiesInBounds({ x: 0, y: 0, width: 20, height: 20 }, [])
        .map((entity) => entity.id),
    ).toEqual([second.id, first.id]);

    canvasStore.moveEntity(first.id, { x: 100, y: 100 });
    canvasStore.removeEntity(second.id);

    expect(canvasStore.queryEntitiesInBounds({ x: 0, y: 0, width: 20, height: 20 }, [])).toEqual(
      [],
    );
    expect(canvasStore.queryEntitiesInBounds({ x: 95, y: 95, width: 20, height: 20 }, [])).toEqual([
      first,
    ]);
  });
});

describe("canvasStore.removeEntities", () => {
  test("compacts entity and selection state with one notification", () => {
    const entities = Array.from({ length: 1_000 }, (_, index) =>
      createTestEntity({ id: `remove-${index}`, zIndex: index }),
    );
    canvasStore.addEntities(entities);
    const removedIds = new Set(entities.filter((_, index) => index % 2 === 0).map(({ id }) => id));
    canvasStore.replaceSelection(entities.map(({ id }) => id));
    let notifications = 0;
    const unsubscribe = canvasStore.subscribe(() => notifications++);

    expect(canvasStore.removeEntities(removedIds)).toBe(500);

    expect(notifications).toBe(1);
    expect(canvasStore.getState().entityIds).toEqual(
      entities.filter((_, index) => index % 2 === 1).map(({ id }) => id),
    );
    expect(canvasStore.getSelectedEntityIds().size).toBe(500);
    expect(
      canvasStore.queryEntitiesInBounds({ x: -1, y: -1, width: 1_000, height: 1_000 }, []),
    ).toEqual(entities.filter((_, index) => index % 2 === 1));

    unsubscribe();
  });
});

describe("canvasStore.updateEntities", () => {
  test("updates a large batch with one version notification", () => {
    const entities = Array.from({ length: 100 }, (_, index) =>
      createTestEntity({ id: `bulk-${index}` }),
    );
    canvasStore.addEntities(entities);
    canvasStore.replaceSelection(entities.map((entity) => entity.id));
    canvasStore.clearDirtyFlags();
    const initialVersion = canvasStore.getState().version;
    let subscriberCalls = 0;
    const unsubscribe = canvasStore.subscribe(() => {
      subscriberCalls++;
      canvasStore.getSelectedEntitiesStable();
    });

    const updatedCount = canvasStore.updateEntities(
      entities.map((entity, index) => ({
        id: entity.id,
        updates: { position: { x: index, y: index * 2 }, textureDirty: true },
      })),
    );

    expect(canvasStore.getState().version).toBe(initialVersion + 1);
    expect(updatedCount).toBe(entities.length);
    expect(canvasStore.getState().entitiesDirty.size).toBe(entities.length);
    expect(canvasStore.getState().entities.get("bulk-99")?.position).toEqual({ x: 99, y: 198 });
    expect(subscriberCalls).toBe(1);
    unsubscribe();
  });

  test("does not notify when no batch IDs exist", () => {
    const initialVersion = canvasStore.getState().version;
    expect(canvasStore.updateEntities([{ id: "missing", updates: { textureDirty: true } }])).toBe(
      0,
    );
    expect(canvasStore.getState().version).toBe(initialVersion);
  });

  test("refreshes indexed entity references for non-spatial updates", () => {
    const entity = createTestEntity({ id: "indexed-param-update" });
    canvasStore.addEntity(entity);

    canvasStore.updateEntity(entity.id, { edited: true });

    const [indexed] = canvasStore.queryEntitiesInBounds(
      { x: entity.position.x, y: entity.position.y, width: 1, height: 1 },
      [],
    );
    expect(indexed).toBe(canvasStore.getState().entities.get(entity.id));
    expect(indexed?.edited).toBe(true);
  });
});
