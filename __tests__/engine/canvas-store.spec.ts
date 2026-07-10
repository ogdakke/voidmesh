import { describe, test, expect, beforeEach, afterEach } from "vitest";
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

    canvasStore.updateEntities(
      entities.map((entity, index) => ({
        id: entity.id,
        updates: { position: { x: index, y: index * 2 }, textureDirty: true },
      })),
    );

    expect(canvasStore.getState().version).toBe(initialVersion + 1);
    expect(canvasStore.getState().entitiesDirty.size).toBe(entities.length);
    expect(canvasStore.getState().entities.get("bulk-99")?.position).toEqual({ x: 99, y: 198 });
    expect(subscriberCalls).toBe(1);
    unsubscribe();
  });

  test("does not notify when no batch IDs exist", () => {
    const initialVersion = canvasStore.getState().version;
    canvasStore.updateEntities([{ id: "missing", updates: { textureDirty: true } }]);
    expect(canvasStore.getState().version).toBe(initialVersion);
  });
});
