import type { PlaybackState } from "#types/canvas.ts";

export const DEFAULT_PLAYBACK_STATE: PlaybackState = {
  isPlaying: false,
  currentTime: 0,
  loop: true,
  playbackRate: 1,
  muted: true,
  volume: 1,
};

export function createPlaybackState(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    isPlaying: overrides.isPlaying ?? DEFAULT_PLAYBACK_STATE.isPlaying,
    currentTime: overrides.currentTime ?? DEFAULT_PLAYBACK_STATE.currentTime,
    loop: overrides.loop ?? DEFAULT_PLAYBACK_STATE.loop,
    playbackRate: overrides.playbackRate ?? DEFAULT_PLAYBACK_STATE.playbackRate,
    muted: overrides.muted ?? DEFAULT_PLAYBACK_STATE.muted,
    volume: overrides.volume ?? DEFAULT_PLAYBACK_STATE.volume,
  };
}
