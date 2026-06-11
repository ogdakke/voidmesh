import { describe, expect, test } from "vitest";
import {
  createDuplicatePlaybackState,
  resetDuplicatedMediaPlayback,
} from "#lib/media-duplication.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("media duplication playback", () => {
  test("resets duplicated video playback to paused at the beginning", () => {
    const entity = createTestEntity({
      mediaType: "video",
      videoDuration: 120,
      videoHasAudio: true,
      muted: false,
      volume: 0.4,
    });

    if (entity.mediaSource.type !== "video") throw new Error("Expected video entity");
    entity.mediaSource.videoElement.currentTime = 42;
    entity.mediaSource.videoElement.muted = false;
    entity.mediaSource.videoElement.volume = 0.4;
    entity.mediaSource.videoElement.loop = false;
    entity.mediaSource.videoElement.playbackRate = 2;
    if (entity.playback) {
      entity.playback.isPlaying = true;
      entity.playback.currentTime = 42;
      entity.playback.loop = false;
      entity.playback.playbackRate = 2;
      entity.playback.muted = false;
      entity.playback.volume = 0.4;
    }

    const playback = createDuplicatePlaybackState(entity);
    resetDuplicatedMediaPlayback(entity.mediaSource, playback);

    expect(playback).toEqual({
      isPlaying: false,
      currentTime: 0,
      loop: true,
      playbackRate: 1,
      muted: true,
      volume: 1,
    });
    expect(entity.mediaSource.videoElement.paused).toBe(true);
    expect(entity.mediaSource.videoElement.currentTime).toBe(0);
    expect(entity.mediaSource.videoElement.muted).toBe(true);
    expect(entity.mediaSource.videoElement.volume).toBe(1);
    expect(entity.mediaSource.videoElement.loop).toBe(true);
    expect(entity.mediaSource.videoElement.playbackRate).toBe(1);
  });
});
