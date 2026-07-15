import {
  MediaType,
  type MediaSource,
  type PlaybackState,
  type ShaderCanvasEntity,
} from "#types/canvas.ts";
import { createPlaybackState } from "./media-playback.ts";

export interface UniqueEntityNameAllocator {
  allocate(baseName: string): string;
}

/** Allocate duplicate suffixes with one monotonic cursor per base name. */
export function createUniqueEntityNameAllocator(
  existingNames: ReadonlySet<string>,
): UniqueEntityNameAllocator {
  const nextSuffixByBase = new Map<string, number>();
  const allocatedNames = new Set(existingNames);

  return {
    allocate(baseName: string): string {
      let suffix = nextSuffixByBase.get(baseName) ?? 1;
      let candidate = `${baseName} (${suffix})`;
      while (allocatedNames.has(candidate)) {
        suffix++;
        candidate = `${baseName} (${suffix})`;
      }
      nextSuffixByBase.set(baseName, suffix + 1);
      allocatedNames.add(candidate);
      return candidate;
    },
  };
}

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
