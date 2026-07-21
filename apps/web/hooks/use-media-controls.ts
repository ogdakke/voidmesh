/**
 * Media controls hooks for managing animated media (video/GIF) playback
 *
 * Split into two focused hooks for performance optimization:
 * - useMediaControlsActions: Stable action functions (no playback time subscription)
 * - usePlaybackTime: Real-time playback state for components that need it
 *
 * This prevents components that only need actions from re-rendering every frame during playback.
 */
import { useEffect, useRef, useState } from "react";
import {
  useCanvasPlaybackSnapshot,
  useCanvasMedia,
  useCanvasSelectionSnapshot,
  useCanvasVideoAudioSnapshot,
} from "#context/use-canvas.ts";
import { logger } from "#lib/client.logger.ts";
import { formatMediaTimeParts, type MediaTimeParts } from "#lib/time-format.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { isVideoEntity, isGifEntity, isAnimatedEntity, MediaType } from "#types/canvas.ts";

// ============================================================================
// Types
// ============================================================================

export type MediaControlsStateName = "idle" | "paused" | "playing" | "seeking";

export interface MediaControlsActionsOnly {
  play: () => Promise<void>;
  pause: () => void;
  togglePlayback: () => Promise<void>;
  toggleMuted: () => void;
  seek: (time: number) => void;
  /** Seek relative to current position. Reads current time directly from entity to avoid stale state. */
  seekRelative: (delta: number) => void;
  seekStart: () => void;
  seekEnd: () => void;
  isIdle: () => boolean;
  canToggleMuted: () => boolean;
  isMuted: () => boolean;
}

export interface PlaybackTimeState {
  entityId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  /** Time parts for custom styling (main + ms) */
  timeParts: MediaTimeParts;
  /** Duration parts for custom styling (main + ms) */
  durationParts: MediaTimeParts;
}

export interface SelectedVideoAudioState {
  entityId: string | null;
  canToggleMuted: boolean;
  isMuted: boolean;
}

// ============================================================================
// usePlaybackTime - Real-time playback state
// ============================================================================

const defaultTimeParts: MediaTimeParts = { main: "0", ms: "00" };

/**
 * Hook for components that need real-time playback time updates.
 * Subscribes to playbackVersion - updates every frame during playback.
 * Use sparingly - only in components that need to display current time.
 */
export function usePlaybackTime(): PlaybackTimeState {
  const playbackSnapshot = useCanvasPlaybackSnapshot();

  return {
    entityId: playbackSnapshot.entityId,
    currentTime: playbackSnapshot.currentTime,
    duration: playbackSnapshot.duration,
    isPlaying: playbackSnapshot.isPlaying,
    timeParts:
      playbackSnapshot.entityId !== null
        ? formatMediaTimeParts(playbackSnapshot.currentTime)
        : defaultTimeParts,
    durationParts:
      playbackSnapshot.entityId !== null
        ? formatMediaTimeParts(playbackSnapshot.duration)
        : defaultTimeParts,
  };
}

/**
 * Hook for playback time with frozen state support for exit animations.
 * Returns the last known values when no entity is selected, allowing
 * CSS exit animations to display the frozen time values.
 */
export function useFrozenPlaybackTime(): PlaybackTimeState {
  const liveState = usePlaybackTime();
  const [frozen, setFrozen] = useState<PlaybackTimeState>(liveState);

  // Update frozen state when we have active playback (adjust state during render)
  if (liveState.entityId !== null && liveState !== frozen) {
    setFrozen(liveState);
  }

  // Return frozen state during idle (for exit animation), live state otherwise
  return liveState.entityId !== null ? liveState : frozen;
}

export function useSelectedVideoAudioState(): SelectedVideoAudioState {
  const audioSnapshot = useCanvasVideoAudioSnapshot();

  return {
    entityId: audioSnapshot.entityId,
    canToggleMuted: audioSnapshot.canToggleMuted,
    isMuted: audioSnapshot.muted,
  };
}

// ============================================================================
// useMediaControlsActions - Stable action functions
// ============================================================================

/**
 * Hook for media control actions without playback time subscription.
 * Returns stable action functions that don't cause re-renders during playback.
 * Use this for keybind handlers and components that don't need real-time time display.
 */
export function useMediaControlsActions(
  selectedEntity: ShaderCanvasEntity | undefined,
): MediaControlsActionsOnly {
  // Track seeking state locally (transient UI state, not in store)
  const seekingRef = useRef(false);
  const media = useCanvasMedia();
  const wasPlayingBeforeSeekRef = useRef(false);
  const seekTimeRef = useRef(0);

  // Subscribe ONLY to selection changes, NOT playback time
  const storeSnapshot = useCanvasSelectionSnapshot();

  // Get entity from store to ensure we have latest state
  const entity = selectedEntity?.id ? storeSnapshot.entities.get(selectedEntity.id) : undefined;
  const isAnimatedSelected = entity && isAnimatedEntity(entity);

  // ---- Actions ----

  const play = async () => {
    if (!entity?.id) return;
    logger.debug("[MediaControls] play() called", {
      entityId: entity.id,
      seekingRef: seekingRef.current,
    });
    if (isVideoEntity(entity)) {
      await media.play(entity.id);
    } else if (isGifEntity(entity)) {
      await media.play(entity.id);
    }
  };

  const pause = () => {
    if (!entity?.id) return;
    logger.debug("[MediaControls] pause() called", {
      entityId: entity.id,
      seekingRef: seekingRef.current,
    });
    if (isVideoEntity(entity)) {
      media.pause(entity.id);
    } else if (isGifEntity(entity)) {
      media.pause(entity.id);
    }
  };

  const togglePlayback = async () => {
    logger.debug("[MediaControls] togglePlayback() called", {
      entityId: entity?.id,
      seekingRef: seekingRef.current,
    });
    if (entity?.id) {
      await media.togglePlayback(entity.id);
    }
  };

  const toggleMuted = () => {
    if (!entity?.id || !isVideoEntity(entity) || !entity.mediaSource.hasAudio) return;
    logger.debug("[MediaControls] toggleMuted() called", {
      entityId: entity.id,
      muted: entity.playback?.muted,
    });
    media.toggleMuted(entity.id);
  };

  const seek = (time: number) => {
    if (!entity?.id) return;
    logger.debug("[MediaControls] seek()", {
      entityId: entity.id,
      time,
      seekingRef: seekingRef.current,
    });
    seekTimeRef.current = time;
    if (isVideoEntity(entity)) {
      media.seek(entity.id, time);
    } else if (isGifEntity(entity)) {
      media.seek(entity.id, time);
    }
  };

  /**
   * Seek relative to current position by a delta amount.
   * Reads current time directly from entity to avoid stale closure issues
   * when called rapidly (e.g., from keyboard handlers).
   * Wraps around at boundaries (seeking past end wraps to start, and vice versa).
   */
  const seekRelative = (delta: number) => {
    if (!entity?.id || !isAnimatedEntity(entity)) return;

    // Read current time directly from entity to avoid stale React state
    const currentTime = entity.playback?.currentTime ?? 0;
    const duration =
      entity.mediaSource.type === MediaType.video
        ? entity.mediaSource.videoElement.duration || 0
        : entity.mediaSource.duration;

    let newTime = currentTime + delta;

    // Clamp at start, wrap at end (with two-step behavior)
    if (duration > 0) {
      if (newTime < 0) {
        newTime = 0;
      } else if (newTime > duration) {
        // Check if already at end (within small epsilon)
        const atEnd = duration - currentTime < 0.001;
        if (atEnd) {
          // Already at end, wrap to 0
          newTime = 0;
        } else {
          // Not at end yet, clamp to end
          newTime = duration;
        }
      }
    }

    logger.debug("[MediaControls] seekRelative()", {
      entityId: entity.id,
      delta,
      currentTime,
      newTime,
    });

    seekTimeRef.current = newTime;
    if (isVideoEntity(entity)) {
      media.seek(entity.id, newTime);
    } else if (isGifEntity(entity)) {
      media.seek(entity.id, newTime);
    }
  };

  const seekStart = () => {
    if (!entity || !isAnimatedEntity(entity)) return;
    // Idempotent - only act if not already seeking
    if (seekingRef.current) return;

    logger.debug("[MediaControls] seekStart()", {
      entityId: entity.id,
      wasPlaying: entity.playback?.isPlaying,
    });

    seekingRef.current = true;
    wasPlayingBeforeSeekRef.current = entity.playback?.isPlaying ?? false;

    // Pause during seek
    if (wasPlayingBeforeSeekRef.current) {
      if (isVideoEntity(entity)) {
        media.pause(entity.id);
      } else if (isGifEntity(entity)) {
        media.pause(entity.id);
      }
    }
  };

  const seekEnd = () => {
    if (!entity?.id) return;
    // Idempotent - only act if currently seeking
    if (!seekingRef.current) return;

    logger.debug("[MediaControls] seekEnd()", {
      entityId: entity.id,
      seekingRefBefore: seekingRef.current,
      wasPlayingBeforeSeek: wasPlayingBeforeSeekRef.current,
    });

    seekingRef.current = false;

    // Resume if was playing before seek
    if (wasPlayingBeforeSeekRef.current) {
      if (isVideoEntity(entity)) {
        void media.play(entity.id);
      } else if (isGifEntity(entity)) {
        void media.play(entity.id);
      }
    }
  };

  const isIdle = () => {
    return !entity || !isAnimatedEntity(entity);
  };

  const canToggleMuted = () => {
    return !!entity && isVideoEntity(entity) && entity.mediaSource.hasAudio;
  };

  const isMuted = () => {
    if (!entity || !isVideoEntity(entity)) return true;
    return entity.playback?.muted ?? entity.mediaSource.videoElement.muted;
  };

  // Handle video edge case events (seeked, ended, play)
  // Note: Regular time updates are handled by the game loop
  useEffect(() => {
    if (!isAnimatedSelected || !entity) return;

    if (isVideoEntity(entity)) {
      const video = entity.mediaSource.videoElement;

      // Firefox sometimes doesn't fire timeupdate after seek completes
      // Force an immediate update (bypasses throttle) to ensure UI syncs
      const handleSeeked = () => {
        logger.debug("[MediaControls] seeked event", {
          entityId: entity.id,
          seekingRef: seekingRef.current,
          currentTime: video.currentTime,
        });
        if (!seekingRef.current) {
          media.notifyPlayback(entity.id, video.currentTime);
        }
      };

      // When video ends, ensure we update the final time immediately
      const handleEnded = () => {
        logger.debug("[MediaControls] ended event", {
          entityId: entity.id,
          duration: video.duration,
        });
        media.notifyPlayback(entity.id, video.duration);
      };

      // Force sync when playback starts (important for Firefox boundary cases)
      const handlePlay = () => {
        logger.debug("[MediaControls] play event", {
          entityId: entity.id,
          seekingRef: seekingRef.current,
          currentTime: video.currentTime,
        });
        if (!seekingRef.current) {
          media.notifyPlayback(entity.id, video.currentTime);
        }
      };

      video.addEventListener("seeked", handleSeeked);
      video.addEventListener("ended", handleEnded);
      video.addEventListener("play", handlePlay);

      return () => {
        video.removeEventListener("seeked", handleSeeked);
        video.removeEventListener("ended", handleEnded);
        video.removeEventListener("play", handlePlay);
      };
    }
  }, [isAnimatedSelected, entity, media]);

  return {
    play,
    pause,
    togglePlayback,
    toggleMuted,
    seek,
    seekRelative,
    seekStart,
    seekEnd,
    isIdle,
    canToggleMuted,
    isMuted,
  };
}
