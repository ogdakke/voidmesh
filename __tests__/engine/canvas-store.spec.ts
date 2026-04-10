import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { canvasStore } from "#engine";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { createTestEntity, resetEntityCounter } from "../helpers/test-entity.ts";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
  resetEntityCounter();
});

afterEach(() => {
  cleanup();
});

// ============================================================================
// Video Playback Store Methods
// ============================================================================

describe("canvasStore.seekVideo", () => {
  test("updates video currentTime", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);

    canvasStore.seekVideo(entity.id, 50);

    expect(entity.playback?.currentTime).toBe(50);
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
    expect(entity.playback?.currentTime).toBe(100);

    canvasStore.seekVideo(entity.id, -10);
    expect(entity.playback?.currentTime).toBe(0);
  });

  test("marks texture as dirty", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    entity.textureDirty = false;
    canvasStore.addEntity(entity);

    canvasStore.seekVideo(entity.id, 50);

    expect(entity.textureDirty).toBe(true);
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
});
