import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { canvasStore } from "#engine";
import { serializePlayback } from "#lib/serialization/serialize.ts";
import { toPlaybackState } from "#lib/serialization/types.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { createTestEntity, resetEntityCounter } from "../helpers/test-entity.ts";

let cleanup: () => void;

beforeEach(() => {
  cleanup?.();
  cleanup = setupCanvasTest();
  resetEntityCounter();
});

afterEach(() => {
  cleanup();
});

describe("serialized playback audio state", () => {
  test("serializes muted and volume", () => {
    const playback = toPlaybackState({
      currentTime: 4,
      loop: true,
      playbackRate: 1,
      muted: false,
      volume: 0.35,
      isPlaying: false,
    });

    expect(serializePlayback(playback)).toEqual({
      currentTime: 4,
      loop: true,
      playbackRate: 1,
      muted: false,
      volume: 0.35,
      isPlaying: false,
    });
  });

  test("defaults old playback data to muted at full volume", () => {
    expect(
      toPlaybackState({
        currentTime: 0,
        loop: true,
        playbackRate: 1,
      }),
    ).toMatchObject({
      muted: true,
      volume: 1,
    });
  });

  test("restored playback audio state is applied when entity enters the store", () => {
    const entity = createTestEntity({
      mediaType: "video",
      videoHasAudio: true,
      muted: false,
      volume: 0.4,
    });

    canvasStore.addEntity(entity);

    expect(entity.mediaSource.type === "video" && entity.mediaSource.videoElement.muted).toBe(
      false,
    );
    expect(entity.mediaSource.type === "video" && entity.mediaSource.videoElement.volume).toBe(0.4);
  });
});
