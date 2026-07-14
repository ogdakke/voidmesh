import type { CanvasMediaService } from "#application/canvas/canvas-media.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { isAnimatedEntity, isGifEntity, isVideoEntity } from "#types/canvas.ts";

export interface MediaControlSource {
  id: string;
  getCurrentTime(): number;
  getDuration(): number;
  getFrameDuration(): number | null;
  getAdjacentFrameTime(direction: -1 | 1): number;
  getIsPlaying(): boolean;
  getCanToggleMuted(): boolean;
  getIsMuted(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface MediaControlActions {
  play: () => Promise<void>;
  pause: () => void;
  togglePlayback: () => Promise<void>;
  toggleMuted: () => void;
  seek: (time: number) => void;
  seekRelative: (delta: number) => void;
  seekStart: () => void;
  seekEnd: () => void;
}

export interface MediaControlSourceState {
  source: MediaControlSource | null;
  isLive: boolean;
}

interface MediaControlSnapshot {
  id: string;
  currentTime: number;
  duration: number;
  frameDuration: number | null;
  isPlaying: boolean;
  canToggleMuted: boolean;
  isMuted: boolean;
}

let lastSnapshot: MediaControlSnapshot | null = null;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getAdjacentFrameTime(
  currentTime: number,
  frameDuration: number,
  direction: -1 | 1,
): number {
  const frameIndex = currentTime / frameDuration;
  const epsilon = 1e-6;
  if (direction > 0) {
    return Math.ceil(frameIndex + epsilon) * frameDuration;
  }
  return Math.floor(frameIndex - epsilon) * frameDuration;
}

function createSnapshotSource(snapshot: MediaControlSnapshot): MediaControlSource {
  return {
    id: snapshot.id,
    getCurrentTime() {
      return snapshot.currentTime;
    },
    getDuration() {
      return snapshot.duration;
    },
    getFrameDuration() {
      return snapshot.frameDuration;
    },
    getAdjacentFrameTime(direction) {
      const frameDuration = snapshot.frameDuration ?? 0.01;
      return clamp(
        getAdjacentFrameTime(snapshot.currentTime, frameDuration, direction),
        0,
        snapshot.duration,
      );
    },
    getIsPlaying() {
      return snapshot.isPlaying;
    },
    getCanToggleMuted() {
      return snapshot.canToggleMuted;
    },
    getIsMuted() {
      return snapshot.isMuted;
    },
    subscribe() {
      return () => {};
    },
  };
}

export function captureMediaControlSnapshot(source: MediaControlSource): void {
  lastSnapshot = {
    id: source.id,
    currentTime: finiteOrZero(source.getCurrentTime()),
    duration: finiteOrZero(source.getDuration()),
    frameDuration: source.getFrameDuration(),
    isPlaying: source.getIsPlaying(),
    canToggleMuted: source.getCanToggleMuted(),
    isMuted: source.getIsMuted(),
  };
}

export function createEntityMediaControlSourceState(
  entity: ShaderCanvasEntity | undefined,
  media: CanvasMediaService,
): MediaControlSourceState {
  if (!entity || !isAnimatedEntity(entity)) {
    return { source: lastSnapshot ? createSnapshotSource(lastSnapshot) : null, isLive: false };
  }
  const entityId = entity.id;
  const getEntity = () => {
    const current = media.getEntity(entityId);
    return current && isAnimatedEntity(current) ? current : null;
  };

  const source: MediaControlSource = {
    id: entityId,
    getCurrentTime() {
      const current = getEntity();
      if (!current) return 0;
      if (isVideoEntity(current)) {
        return finiteOrZero(
          current.playback?.currentTime ?? current.mediaSource.videoElement.currentTime,
        );
      }
      return finiteOrZero(current.playback?.currentTime ?? 0);
    },
    getDuration() {
      const current = getEntity();
      if (!current) return 0;
      if (isVideoEntity(current)) {
        return finiteOrZero(
          current.mediaSource.videoElement.duration || current.mediaSource.duration,
        );
      }
      if (isGifEntity(current)) {
        return finiteOrZero(current.mediaSource.duration);
      }
      return 0;
    },
    getFrameDuration() {
      const current = getEntity();
      if (!current) return null;
      const fps = current.mediaSource.fps;
      return fps && fps > 0 ? 1 / fps : null;
    },
    getAdjacentFrameTime(direction) {
      const frameDuration = this.getFrameDuration() ?? 0.01;
      return clamp(
        getAdjacentFrameTime(this.getCurrentTime(), frameDuration, direction),
        0,
        this.getDuration(),
      );
    },
    getIsPlaying() {
      const current = getEntity();
      if (!current) return false;
      if (isVideoEntity(current)) {
        const video = current.mediaSource.videoElement;
        return current.playback?.isPlaying ?? (!video.paused && !video.ended);
      }
      return current.playback?.isPlaying ?? false;
    },
    getCanToggleMuted() {
      const current = getEntity();
      return !!current && isVideoEntity(current) && current.mediaSource.hasAudio;
    },
    getIsMuted() {
      const current = getEntity();
      if (!current || !isVideoEntity(current)) return true;
      return current.playback?.muted ?? current.mediaSource.videoElement.muted;
    },
    subscribe(listener) {
      return media.subscribe(listener);
    },
  };

  captureMediaControlSnapshot(source);
  return { source, isLive: true };
}
