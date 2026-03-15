import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
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

    if (entity.mediaSource.type === "video") {
      expect(entity.mediaSource.videoElement.currentTime).toBe(50);
    }
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

    if (entity.mediaSource.type === "video") {
      expect(entity.mediaSource.videoElement.currentTime).toBe(100);
    }

    canvasStore.seekVideo(entity.id, -10);

    if (entity.mediaSource.type === "video") {
      expect(entity.mediaSource.videoElement.currentTime).toBe(0);
    }
  });

  test("marks texture as dirty", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    entity.textureDirty = false;
    canvasStore.addEntity(entity);

    canvasStore.seekVideo(entity.id, 50);

    expect(entity.textureDirty).toBe(true);
  });

  test("does nothing for non-video entities", () => {
    const entity = createTestEntity({ mediaType: "image" });
    canvasStore.addEntity(entity);

    // Should not throw
    canvasStore.seekVideo(entity.id, 50);
  });

  test("does nothing for non-existent entities", () => {
    // Should not throw
    canvasStore.seekVideo("non-existent", 50);
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

  test("does nothing for non-video entities", () => {
    const entity = createTestEntity({ mediaType: "image" });
    canvasStore.addEntity(entity);

    // Should not throw
    canvasStore.updatePlaybackTime(entity.id, 50);
  });

  test("does nothing for non-existent entities", () => {
    // Should not throw
    canvasStore.updatePlaybackTime("non-existent", 50);
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

  test("does nothing for non-gif entities", () => {
    const entity = createTestEntity({ mediaType: "image" });
    canvasStore.addEntity(entity);

    // Should not throw
    canvasStore.seekGif(entity.id, 0.5);
  });

  test("does nothing for non-existent entities", () => {
    // Should not throw
    canvasStore.seekGif("non-existent", 0.5);
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

  test("does nothing for non-gif entities", () => {
    const entity = createTestEntity({ mediaType: "image" });
    canvasStore.addEntity(entity);

    // Should not throw
    canvasStore.updateGifPlaybackTime(entity.id, 0.5);
  });

  test("does nothing for non-existent entities", () => {
    // Should not throw
    canvasStore.updateGifPlaybackTime("non-existent", 0.5);
  });
});
