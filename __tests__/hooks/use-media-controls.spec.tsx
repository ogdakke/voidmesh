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
import { act } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { canvasStore } from "#engine";
import { useKeybinds, useRegisterKeybinds } from "#context/keybind-context.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { createTestEntity, createEntityInput, resetEntityCounter } from "../helpers/test-entity.ts";
import {
  useMediaControlsActions,
  usePlaybackTime,
  type MediaControlsActionsOnly,
  type PlaybackTimeState,
} from "#hooks/use-media-controls.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";

// Skip providers we don't need for hook callback tests
const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

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

      if (entity.mediaSource.type === "video") {
        entity.mediaSource.videoElement.currentTime = 25;
      }
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

/**
 * Helper to render a component that captures the hook results.
 */
function renderWithMediaHooks() {
  let actionsRef: MediaControlsActionsOnly | null = null;
  let timeRef: PlaybackTimeState | null = null;

  function HooksCapture({ children }: { children?: ReactNode }) {
    // Subscribe to store changes to ensure we re-render and get fresh callbacks
    const storeSnapshot = React.useSyncExternalStore(
      canvasStore.subscribe.bind(canvasStore),
      canvasStore.getSelectionSnapshot.bind(canvasStore),
    );
    const selectedEntity =
      storeSnapshot.selectedEntityIds.size === 1
        ? storeSnapshot.entities.get([...storeSnapshot.selectedEntityIds][0]!)
        : undefined;
    actionsRef = useMediaControlsActions(selectedEntity);
    timeRef = usePlaybackTime();
    return <>{children}</>;
  }

  const { rerender: baseRerender, ...result } = renderWithCanvas(<HooksCapture />, {
    skip: skipProviders,
  });

  return {
    ...result,
    getActions: () => actionsRef!,
    getTime: () => timeRef!,
    rerender: () => baseRerender(<HooksCapture />),
  };
}

describe("useMediaControlsActions hook callbacks", () => {
  describe("play/pause", () => {
    test("play() sets video to playing", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 60 }));
        canvas.selectEntity(videoId);
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.isPlaying).toBe(false);

      await act(async () => {
        await getActions().play();
      });

      const updatedEntity = canvasStore.getState().entities.get(videoId!);
      expect(updatedEntity?.playback?.isPlaying).toBe(true);
    });

    test("play() sets GIF to playing", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let gifId: string;
      await act(async () => {
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(gifId);
      });

      const entity = canvasStore.getState().entities.get(gifId!);
      expect(entity?.playback?.isPlaying).toBe(false);

      await act(async () => {
        await getActions().play();
      });

      const updatedEntity = canvasStore.getState().entities.get(gifId!);
      expect(updatedEntity?.playback?.isPlaying).toBe(true);
    });

    test("pause() sets video to paused", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 60 }));
        canvas.selectEntity(videoId);
      });

      // First play using the hook
      await act(async () => {
        await getActions().play();
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.isPlaying).toBe(true);

      // Now pause using the hook
      await act(async () => {
        getActions().pause();
      });

      const updatedEntity = canvasStore.getState().entities.get(videoId!);
      expect(updatedEntity?.playback?.isPlaying).toBe(false);
    });

    test("pause() sets GIF to paused", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let gifId: string;
      await act(async () => {
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(gifId);
      });

      // First play using the hook
      await act(async () => {
        await getActions().play();
      });

      const entity = canvasStore.getState().entities.get(gifId!);
      expect(entity?.playback?.isPlaying).toBe(true);

      // Now pause using the hook
      await act(async () => {
        getActions().pause();
      });

      const updatedEntity = canvasStore.getState().entities.get(gifId!);
      expect(updatedEntity?.playback?.isPlaying).toBe(false);
    });

    test("togglePlayback() toggles video between play and pause", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 60 }));
        canvas.selectEntity(videoId);
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.isPlaying).toBe(false);

      await act(async () => {
        await getActions().togglePlayback();
      });

      let updatedEntity = canvasStore.getState().entities.get(videoId!);
      expect(updatedEntity?.playback?.isPlaying).toBe(true);

      await act(async () => {
        await getActions().togglePlayback();
      });

      updatedEntity = canvasStore.getState().entities.get(videoId!);
      expect(updatedEntity?.playback?.isPlaying).toBe(false);
    });

    test("togglePlayback() toggles GIF between play and pause", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let gifId: string;
      await act(async () => {
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(gifId);
      });

      const entity = canvasStore.getState().entities.get(gifId!);
      expect(entity?.playback?.isPlaying).toBe(false);

      await act(async () => {
        await getActions().togglePlayback();
      });

      let updatedEntity = canvasStore.getState().entities.get(gifId!);
      expect(updatedEntity?.playback?.isPlaying).toBe(true);

      await act(async () => {
        await getActions().togglePlayback();
      });

      updatedEntity = canvasStore.getState().entities.get(gifId!);
      expect(updatedEntity?.playback?.isPlaying).toBe(false);
    });
  });

  describe("audio", () => {
    test("reports and toggles selected video mute state", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(
          createEntityInput({ mediaType: "video", videoDuration: 60, videoHasAudio: true }),
        );
        canvas.selectEntity(videoId);
      });

      expect(getActions().canToggleMuted()).toBe(true);
      expect(getActions().isMuted()).toBe(true);

      await act(async () => {
        getActions().toggleMuted();
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.muted).toBe(false);
      expect(getActions().isMuted()).toBe(false);
    });

    test("does not expose mute controls for GIFs or silent videos", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      let gifId: string;
      await act(async () => {
        videoId = canvas.addEntity(
          createEntityInput({ mediaType: "video", videoDuration: 60, videoHasAudio: false }),
        );
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(videoId);
      });

      expect(getActions().canToggleMuted()).toBe(false);

      await act(async () => {
        canvas.selectEntity(gifId!);
      });

      expect(getActions().canToggleMuted()).toBe(false);
    });
  });

  describe("seek", () => {
    test("seek() updates video currentTime", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
        canvas.selectEntity(videoId);
      });

      await act(async () => {
        getActions().seek(50);
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.currentTime).toBe(50);
    });

    test("seek() updates GIF currentTime", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let gifId: string;
      await act(async () => {
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(gifId);
      });

      await act(async () => {
        getActions().seek(1.0);
      });

      const entity = canvasStore.getState().entities.get(gifId!);
      expect(entity?.playback?.currentTime).toBe(1.0);
    });
  });

  describe("seekRelative", () => {
    describe("basic forward/backward seeking", () => {
      test("seekRelative(positive) moves video forward", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let videoId: string;
        await act(async () => {
          videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
          canvas.selectEntity(videoId);
        });

        // Set initial position
        await act(async () => {
          getActions().seek(50);
        });

        // Seek forward
        await act(async () => {
          getActions().seekRelative(0.1);
        });

        const entity = canvasStore.getState().entities.get(videoId!);
        expect(entity?.playback?.currentTime).toBeCloseTo(50.1, 5);
      });

      test("seekRelative(negative) moves video backward", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let videoId: string;
        await act(async () => {
          videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
          canvas.selectEntity(videoId);
        });

        // Set initial position
        await act(async () => {
          getActions().seek(50);
        });

        // Seek backward
        await act(async () => {
          getActions().seekRelative(-0.1);
        });

        const entity = canvasStore.getState().entities.get(videoId!);
        expect(entity?.playback?.currentTime).toBeCloseTo(49.9, 5);
      });

      test("seekRelative(positive) moves GIF forward", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let gifId: string;
        await act(async () => {
          gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
          canvas.selectEntity(gifId);
        });

        // Set initial position
        await act(async () => {
          getActions().seek(1.0);
        });

        // Seek forward
        await act(async () => {
          getActions().seekRelative(0.1);
        });

        const entity = canvasStore.getState().entities.get(gifId!);
        expect(entity?.playback?.currentTime).toBeCloseTo(1.1, 5);
      });

      test("seekRelative(negative) moves GIF backward", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let gifId: string;
        await act(async () => {
          gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
          canvas.selectEntity(gifId);
        });

        // Set initial position
        await act(async () => {
          getActions().seek(1.0);
        });

        // Seek backward
        await act(async () => {
          getActions().seekRelative(-0.1);
        });

        const entity = canvasStore.getState().entities.get(gifId!);
        expect(entity?.playback?.currentTime).toBeCloseTo(0.9, 5);
      });
    });

    describe("boundary behavior", () => {
      test("seekRelative clamps to 0 when seeking backward past start", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let videoId: string;
        await act(async () => {
          videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
          canvas.selectEntity(videoId);
        });

        // Set position near start
        await act(async () => {
          getActions().seek(0.05);
        });

        // Seek backward past 0 - should clamp to 0
        await act(async () => {
          getActions().seekRelative(-1);
        });

        const entity = canvasStore.getState().entities.get(videoId!);
        expect(entity?.playback?.currentTime).toBe(0);
      });

      test("seekRelative clamps to end when seeking forward past end (not yet at end)", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let videoId: string;
        await act(async () => {
          videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
          canvas.selectEntity(videoId);
        });

        // Set position near end (but not at end)
        await act(async () => {
          getActions().seek(99.5);
        });

        // Seek forward past duration - should clamp to end first
        await act(async () => {
          getActions().seekRelative(1);
        });

        const entity = canvasStore.getState().entities.get(videoId!);
        expect(entity?.playback?.currentTime).toBe(100);
      });

      test("seekRelative wraps to 0 when already at end and seeking forward", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let videoId: string;
        await act(async () => {
          videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
          canvas.selectEntity(videoId);
        });

        // Seek to end
        await act(async () => {
          getActions().seek(100);
        });

        // Already at end, seek forward - should wrap to 0
        await act(async () => {
          getActions().seekRelative(0.1);
        });

        const entity = canvasStore.getState().entities.get(videoId!);
        expect(entity?.playback?.currentTime).toBe(0);
      });

      test("seekRelative at 0 with negative delta stays at 0", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let videoId: string;
        await act(async () => {
          videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
          canvas.selectEntity(videoId);
        });

        // Already at 0, seek backward - should stay at 0
        await act(async () => {
          getActions().seekRelative(-0.1);
        });

        const entity = canvasStore.getState().entities.get(videoId!);
        expect(entity?.playback?.currentTime).toBe(0);
      });

      test("GIF seekRelative clamps to end then wraps on next seek", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let gifId: string;
        await act(async () => {
          gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
          canvas.selectEntity(gifId);
        });

        // Seek to near end
        await act(async () => {
          getActions().seek(1.5);
        });

        // Seek forward past duration - should clamp to end first
        await act(async () => {
          getActions().seekRelative(1);
        });

        let entity = canvasStore.getState().entities.get(gifId!);
        expect(entity?.playback?.currentTime).toBe(2);

        // Now at end, seek forward again - should wrap to 0
        await act(async () => {
          getActions().seekRelative(0.1);
        });

        entity = canvasStore.getState().entities.get(gifId!);
        expect(entity?.playback?.currentTime).toBe(0);
      });
    });

    describe("rapid successive calls", () => {
      test("multiple seekRelative calls accumulate correctly for video", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let videoId: string;
        await act(async () => {
          videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
          canvas.selectEntity(videoId);
        });

        // Set initial position
        await act(async () => {
          getActions().seek(50);
        });

        // Simulate rapid key presses - 5 forward seeks of 0.1 each
        await act(async () => {
          getActions().seekRelative(0.1);
          getActions().seekRelative(0.1);
          getActions().seekRelative(0.1);
          getActions().seekRelative(0.1);
          getActions().seekRelative(0.1);
        });

        const entity = canvasStore.getState().entities.get(videoId!);
        // Should be 50 + (5 * 0.1) = 50.5
        expect(entity?.playback?.currentTime).toBeCloseTo(50.5, 5);
      });

      test("multiple seekRelative calls accumulate correctly for GIF", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let gifId: string;
        await act(async () => {
          gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 10 }));
          canvas.selectEntity(gifId);
        });

        // Set initial position
        await act(async () => {
          getActions().seek(5);
        });

        // Simulate rapid key presses - 5 forward seeks of 0.1 each
        await act(async () => {
          getActions().seekRelative(0.1);
          getActions().seekRelative(0.1);
          getActions().seekRelative(0.1);
          getActions().seekRelative(0.1);
          getActions().seekRelative(0.1);
        });

        const entity = canvasStore.getState().entities.get(gifId!);
        // Should be 5 + (5 * 0.1) = 5.5
        expect(entity?.playback?.currentTime).toBeCloseTo(5.5, 5);
      });

      test("mixed forward and backward seekRelative calls work correctly", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        let videoId: string;
        await act(async () => {
          videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
          canvas.selectEntity(videoId);
        });

        // Set initial position
        await act(async () => {
          getActions().seek(50);
        });

        // Mix of forward and backward
        await act(async () => {
          getActions().seekRelative(0.1); // 50.1
          getActions().seekRelative(0.1); // 50.2
          getActions().seekRelative(-0.1); // 50.1
          getActions().seekRelative(1); // 51.1 (shift+arrow)
          getActions().seekRelative(-1); // 50.1 (shift+arrow back)
        });

        const entity = canvasStore.getState().entities.get(videoId!);
        expect(entity?.playback?.currentTime).toBeCloseTo(50.1, 5);
      });
    });

    describe("idle state handling", () => {
      test("isIdle returns true when no entity selected", async () => {
        const { getActions } = renderWithMediaHooks();

        // No entity selected - should return true for isIdle
        expect(getActions().isIdle()).toBe(true);
      });

      test("isIdle returns true for non-animated entity", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        await act(async () => {
          const imageId = canvas.addEntity(createEntityInput({ mediaType: "image" }));
          canvas.selectEntity(imageId);
        });

        expect(getActions().isIdle()).toBe(true);
      });

      test("isIdle returns false for video entity", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        await act(async () => {
          const videoId = canvas.addEntity(
            createEntityInput({ mediaType: "video", videoDuration: 60 }),
          );
          canvas.selectEntity(videoId);
        });

        expect(getActions().isIdle()).toBe(false);
      });

      test("isIdle returns false for GIF entity", async () => {
        const { canvas, getActions } = renderWithMediaHooks();

        await act(async () => {
          const gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
          canvas.selectEntity(gifId);
        });

        expect(getActions().isIdle()).toBe(false);
      });
    });
  });

  describe("seekStart/seekEnd", () => {
    test("seekStart() pauses playback during seek", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
        canvas.selectEntity(videoId);
      });

      // Start playing
      await act(async () => {
        await getActions().play();
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.isPlaying).toBe(true);

      // Start seeking - should pause
      await act(async () => {
        getActions().seekStart();
      });

      const updatedEntity = canvasStore.getState().entities.get(videoId!);
      expect(updatedEntity?.playback?.isPlaying).toBe(false);
    });

    test("seekEnd() does not resume if was paused before seek", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
        canvas.selectEntity(videoId);
      });

      // Video starts paused, start seeking
      await act(async () => {
        getActions().seekStart();
      });

      // End seeking - should stay paused
      await act(async () => {
        getActions().seekEnd();
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.isPlaying).toBe(false);
    });
  });

  describe("boundary conditions (Firefox edge cases)", () => {
    test("seek to 0 (start) then play should work", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
        canvas.selectEntity(videoId);
      });

      // Seek to start
      await act(async () => {
        getActions().seek(0);
      });

      // Start playing
      await act(async () => {
        await getActions().play();
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.isPlaying).toBe(true);
      expect(entity?.playback?.currentTime).toBe(0);
    });

    test("seek to duration (end) then play should restart from beginning", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
        canvas.selectEntity(videoId);
      });

      // Seek to end
      await act(async () => {
        getActions().seek(100);
      });

      // Start playing - should restart from beginning
      await act(async () => {
        await getActions().play();
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.isPlaying).toBe(true);
      // Should have restarted from beginning (or very close to it)
      expect(entity?.playback?.currentTime).toBeLessThan(1);
    });

    test("seek very close to end boundary then play", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let videoId: string;
      await act(async () => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
        canvas.selectEntity(videoId);
      });

      // Seek to very close to end (within epsilon)
      await act(async () => {
        getActions().seek(99.999);
      });

      await act(async () => {
        await getActions().play();
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.isPlaying).toBe(true);
    });

    test("GIF seek to 0 then play should work", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let gifId: string;
      await act(async () => {
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(gifId);
      });

      // Seek to start
      await act(async () => {
        getActions().seek(0);
      });

      // Start playing
      await act(async () => {
        await getActions().play();
      });

      const entity = canvasStore.getState().entities.get(gifId!);
      expect(entity?.playback?.isPlaying).toBe(true);
      expect(entity?.playback?.currentTime).toBe(0);
    });

    test("GIF seek to duration then play should work", async () => {
      const { canvas, getActions } = renderWithMediaHooks();

      let gifId: string;
      await act(async () => {
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(gifId);
      });

      // Seek to end
      await act(async () => {
        getActions().seek(2);
      });

      // Start playing
      await act(async () => {
        await getActions().play();
      });

      const entity = canvasStore.getState().entities.get(gifId!);
      expect(entity?.playback?.isPlaying).toBe(true);
    });
  });
});

describe("media mute keybind", () => {
  function MuteKeybindHarness() {
    const keybindStore = useKeybinds();
    const storeSnapshot = React.useSyncExternalStore(
      canvasStore.subscribe.bind(canvasStore),
      canvasStore.getSelectionSnapshot.bind(canvasStore),
    );
    const selectedEntity =
      storeSnapshot.selectedEntityIds.size === 1
        ? storeSnapshot.entities.get([...storeSnapshot.selectedEntityIds][0]!)
        : undefined;
    const actions = useMediaControlsActions(selectedEntity);

    React.useEffect(() => {
      keybindStore.setActiveContext("selection");
      return () => keybindStore.setActiveContext("global");
    }, [keybindStore]);

    useRegisterKeybinds("selection", [
      {
        id: "test_toggle_media_mute",
        bind: (bb) => bb.withBind("m").withSensitive(false),
        group: "video",
        label: "Mute/Unmute media",
        action: (e: KeyboardEvent) => {
          if (!actions.canToggleMuted()) return;
          e.preventDefault();
          actions.toggleMuted();
        },
      },
    ]);

    return null;
  }

  test("pressing m toggles muted state for selected videos with audio", async () => {
    const { canvas } = renderWithCanvas(<MuteKeybindHarness />);

    let videoId: string;
    await act(async () => {
      videoId = canvas.addEntity(
        createEntityInput({ mediaType: "video", videoDuration: 60, videoHasAudio: true }),
      );
      canvas.selectEntity(videoId);
    });

    expect(canvasStore.getState().entities.get(videoId!)?.playback?.muted).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));
    });

    expect(canvasStore.getState().entities.get(videoId!)?.playback?.muted).toBe(false);
  });

  test("pressing m is ignored for selected videos without audio", async () => {
    const { canvas } = renderWithCanvas(<MuteKeybindHarness />);

    let videoId: string;
    await act(async () => {
      videoId = canvas.addEntity(
        createEntityInput({ mediaType: "video", videoDuration: 60, videoHasAudio: false }),
      );
      canvas.selectEntity(videoId);
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));
    });

    expect(canvasStore.getState().entities.get(videoId!)?.playback?.muted).toBe(true);
  });
});

describe("usePlaybackTime hook", () => {
  test("returns current time and duration", async () => {
    const { canvas, getTime } = renderWithMediaHooks();

    await act(async () => {
      const videoId = canvas.addEntity(
        createEntityInput({ mediaType: "video", videoDuration: 100 }),
      );
      canvas.selectEntity(videoId);
    });

    const time = getTime();
    expect(time.currentTime).toBe(0);
    expect(time.duration).toBe(100);
  });

  test("returns formatted time parts", async () => {
    const { canvas, getTime } = renderWithMediaHooks();

    await act(async () => {
      const videoId = canvas.addEntity(
        createEntityInput({ mediaType: "video", videoDuration: 100 }),
      );
      canvas.selectEntity(videoId);
      canvasStore.seekVideo(videoId, 45.32);
    });

    const time = getTime();
    expect(time.timeParts.main).toBe("45");
    expect(time.timeParts.ms).toBe("32");
  });

  test("returns isPlaying state", async () => {
    const { canvas, getTime, getActions } = renderWithMediaHooks();

    let videoId: string;
    await act(async () => {
      videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
      canvas.selectEntity(videoId);
    });

    expect(getTime().isPlaying).toBe(false);

    await act(async () => {
      await getActions().play();
    });

    expect(getTime().isPlaying).toBe(true);
  });
});
