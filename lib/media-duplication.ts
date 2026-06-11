import {
  MediaType,
  type MediaSource,
  type PlaybackState,
  type ShaderCanvasEntity,
} from "#types/canvas.ts";
import { createPlaybackState } from "./media-playback.ts";

export function createDuplicatePlaybackState(
  entity: ShaderCanvasEntity,
): PlaybackState | undefined {
  if (!entity.playback) return undefined;

  return createPlaybackState();
}

export function resetDuplicatedMediaPlayback(
  mediaSource: MediaSource,
  playback: PlaybackState | undefined,
): void {
  if (mediaSource.type !== MediaType.video) return;

  const safePlayback = createPlaybackState(playback);
  const video = mediaSource.videoElement;
  video.pause();
  video.currentTime = safePlayback.currentTime;
  video.muted = safePlayback.muted;
  video.volume = safePlayback.volume;
  video.loop = safePlayback.loop;
  video.playbackRate = safePlayback.playbackRate;
}
