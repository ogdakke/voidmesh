/**
 * Tests for media control hooks
 *
 * Two hooks are tested:
 * - useMediaControlsActions: Stable action functions for play/pause/seek
 * - usePlaybackTime: Real-time playback state
 *
 * State machine:
 * - idle: No animated entity (video/GIF) selected
 * - paused: Animated entity selected, not playing
 * - playing: Playing
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import React, { useEffect, useState } from "react";
import { canvasStore } from "#engine";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { createTestEntity, resetEntityCounter } from "../helpers/test-entity.ts";
import {
  useMediaControlsActions,
  usePlaybackTime,
  type MediaControlsActionsOnly,
  type PlaybackTimeState,
} from "#hooks/use-media-controls.ts";
import { renderWithProviders } from "../helpers/render-with-providers.tsx";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
  resetEntityCounter();
});

afterEach(() => {
  cleanup();
});

// ============================================================================
// Store-based state tests (pure functions, no React)
// ============================================================================

describe("playback state via store", () => {
  describe("state detection", () => {
    test("returns null entityId when no entity selected", () => {
      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.entityId).toBeNull();
    });

    test("returns null entityId when non-animated entity selected", () => {
      const entity = createTestEntity({ mediaType: "image" });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.entityId).toBeNull();
    });

    test("returns entityId for video entity", () => {
      const entity = createTestEntity({ mediaType: "video", videoDuration: 30 });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.entityId).toBe(entity.id);
    });

    test("returns entityId for GIF entity", () => {
      const entity = createTestEntity({ mediaType: "gif", gifDuration: 2 });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.entityId).toBe(entity.id);
    });
  });

  describe("playback properties", () => {
    test("includes video properties", () => {
      const entity = createTestEntity({ mediaType: "video", videoDuration: 30 });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.entityId).toBe(entity.id);
      expect(snapshot.duration).toBe(30);
      expect(snapshot.currentTime).toBe(0);
      expect(snapshot.isPlaying).toBe(false);
    });

    test("includes GIF properties", () => {
      const entity = createTestEntity({ mediaType: "gif", gifDuration: 2 });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.entityId).toBe(entity.id);
      expect(snapshot.duration).toBe(2);
      expect(snapshot.currentTime).toBe(0);
      expect(snapshot.isPlaying).toBe(false);
    });

    test("isPlaying reflects video playback state", () => {
      const entity = createTestEntity({ mediaType: "video", videoDuration: 30 });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      if (entity.playback) {
        entity.playback.isPlaying = true;
      }

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.isPlaying).toBe(true);
    });

    test("isPlaying reflects GIF playback state", () => {
      const entity = createTestEntity({ mediaType: "gif", gifDuration: 2 });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      if (entity.playback) {
        entity.playback.isPlaying = true;
      }

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.isPlaying).toBe(true);
    });
  });

  describe("time tracking", () => {
    test("returns currentTime from video playback state", () => {
      const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      if (entity.playback) {
        entity.playback.currentTime = 25;
      }

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.currentTime).toBe(25);
    });

    test("returns currentTime from GIF playback state", () => {
      const entity = createTestEntity({ mediaType: "gif", gifDuration: 2 });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      if (entity.playback) {
        entity.playback.currentTime = 1.0;
      }

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.currentTime).toBe(1.0);
    });

    test("handles zero duration gracefully", () => {
      const entity = createTestEntity({ mediaType: "video", videoDuration: 0 });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const snapshot = canvasStore.getPlaybackSnapshot();
      expect(snapshot.currentTime).toBe(0);
      expect(snapshot.duration).toBe(0);
    });
  });
});

// ============================================================================
// Entity switching tests (pure store tests)
// ============================================================================

describe("entity switching", () => {
  test("playback snapshot returns correct entity after switching", () => {
    const entityA = createTestEntity({ mediaType: "video", videoDuration: 100 });
    const entityB = createTestEntity({ mediaType: "video", videoDuration: 200 });
    canvasStore.addEntity(entityA);
    canvasStore.addEntity(entityB);

    if (entityA.playback) entityA.playback.currentTime = 25;
    if (entityB.playback) entityB.playback.currentTime = 75;

    canvasStore.replaceSelection([entityA.id]);
    let snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.entityId).toBe(entityA.id);
    expect(snapshot.currentTime).toBe(25);

    canvasStore.replaceSelection([entityB.id]);
    snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.entityId).toBe(entityB.id);
    expect(snapshot.currentTime).toBe(75);
  });

  test("returns null entityId when deselecting video", () => {
    const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    canvasStore.addEntity(entity);

    canvasStore.replaceSelection([entity.id]);
    let snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.entityId).toBe(entity.id);

    canvasStore.replaceSelection([]);
    snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.entityId).toBeNull();
  });

  test("playback snapshot tracks correct entity after switching", () => {
    const entityA = createTestEntity({ mediaType: "video", videoDuration: 100 });
    const entityB = createTestEntity({ mediaType: "video", videoDuration: 200 });
    canvasStore.addEntity(entityA);
    canvasStore.addEntity(entityB);

    canvasStore.replaceSelection([entityA.id]);
    canvasStore.updatePlaybackTime(entityA.id, 30);

    let snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.entityId).toBe(entityA.id);
    expect(snapshot.currentTime).toBe(30);

    canvasStore.replaceSelection([entityB.id]);
    canvasStore.updatePlaybackTime(entityB.id, 80);

    snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.entityId).toBe(entityB.id);
    expect(snapshot.currentTime).toBe(80);
  });

  test("playback snapshot entityId matches selected entity immediately after switch", () => {
    const entityA = createTestEntity({ mediaType: "video", videoDuration: 100 });
    const entityB = createTestEntity({ mediaType: "video", videoDuration: 200 });
    canvasStore.addEntity(entityA);
    canvasStore.addEntity(entityB);

    canvasStore.replaceSelection([entityA.id]);
    canvasStore.updatePlaybackTime(entityA.id, 50);

    canvasStore.replaceSelection([entityB.id]);

    const snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.entityId).toBe(entityB.id);
  });

  test("switching from video to non-video returns null entityId", () => {
    const videoEntity = createTestEntity({ mediaType: "video", videoDuration: 100 });
    const imageEntity = createTestEntity({ mediaType: "image" });
    canvasStore.addEntity(videoEntity);
    canvasStore.addEntity(imageEntity);

    canvasStore.replaceSelection([videoEntity.id]);
    let snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.entityId).toBe(videoEntity.id);

    canvasStore.replaceSelection([imageEntity.id]);
    snapshot = canvasStore.getPlaybackSnapshot();
    expect(snapshot.entityId).toBeNull();
  });
});

// ============================================================================
// Hook tests with React
// ============================================================================
const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

describe("media control hooks", () => {
  test("play and pause update selected video playback", async () => {
    let actions: MediaControlsActionsOnly | null = null;
    let entityId: string | null = null;

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (ready) return;
        const entity = createTestEntity({ mediaType: "video", videoDuration: 60 });
        canvasStore.addEntity(entity);
        canvasStore.replaceSelection([entity.id]);
        entityId = entity.id;
        setReady(true);
      }, [ready]);

      actions = useMediaControlsActions(canvasStore.getSelectedEntity());
      usePlaybackTime();
      return null;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => entityId !== null && actions !== null);

    await act(async () => {
      await actions!.play();
    });
    expect(canvasStore.getState().entities.get(entityId!)?.playback?.isPlaying).toBe(true);

    await act(async () => {
      actions!.pause();
    });
    expect(canvasStore.getState().entities.get(entityId!)?.playback?.isPlaying).toBe(false);
  });

  test("seekRelative updates selected GIF playback time", async () => {
    let actions: MediaControlsActionsOnly | null = null;
    let entityId: string | null = null;

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (ready) return;
        const entity = createTestEntity({ mediaType: "gif", gifDuration: 2, gifFrameCount: 20 });
        canvasStore.addEntity(entity);
        canvasStore.replaceSelection([entity.id]);
        entityId = entity.id;
        setReady(true);
      }, [ready]);

      actions = useMediaControlsActions(canvasStore.getSelectedEntity());
      usePlaybackTime();
      return null;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => entityId !== null && actions !== null);

    await act(async () => {
      actions!.seek(1);
      actions!.seekRelative(0.25);
    });

    expect(canvasStore.getState().entities.get(entityId!)?.playback?.currentTime).toBeCloseTo(
      1.25,
      5,
    );
  });

  test("usePlaybackTime reflects selected animated entity", async () => {
    let time: PlaybackTimeState | null = null;
    let entityId: string | null = null;

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (ready) return;
        const entity = createTestEntity({ mediaType: "video", videoDuration: 100 });
        canvasStore.addEntity(entity);
        canvasStore.replaceSelection([entity.id]);
        canvasStore.updatePlaybackTime(entity.id, 45.32);
        entityId = entity.id;
        setReady(true);
      }, [ready]);

      useMediaControlsActions(canvasStore.getSelectedEntity());
      time = usePlaybackTime();
      return null;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => time?.entityId === entityId);

    const snapshot = time!;
    expect(snapshot.currentTime).toBe(45.32);
    expect(snapshot.duration).toBe(100);
    expect(snapshot.timeParts.main).toBe("45");
    expect(snapshot.timeParts.ms).toBe("32");
  });
});
