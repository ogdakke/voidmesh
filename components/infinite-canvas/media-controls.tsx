import { useSelectedEntity } from "#context/use-canvas.ts";
import {
  useMediaControlsActions,
  useFrozenPlaybackTime,
  type MediaControlsActionsOnly,
} from "#hooks/use-media-controls.ts";
import { PauseSolid, PlaySolid } from "iconoir-react";
import { Slider as BaseSlider } from "@base-ui/react/slider";
import "./media-controls.css";

/**
 * Displays formatted playback time.
 * Uses frozen playback time to retain values during exit animation.
 */
function PlaybackTimeDisplay() {
  const time = useFrozenPlaybackTime();

  return (
    <>
      <span className="media-progress-value">
        {time.timeParts.main}
        <span className="media-time-ms">:{time.timeParts.ms}</span>
      </span>
      <span className="media-duration-value">
        {time.durationParts.main}
        <span className="media-time-ms">:{time.durationParts.ms}</span>
      </span>
    </>
  );
}

/**
 * Play/Pause button.
 * Uses frozen playback time to retain state during exit animation.
 */
function PlayPauseButton({ actions }: { actions: MediaControlsActionsOnly }) {
  const time = useFrozenPlaybackTime();
  const isPlaying = time.isPlaying;

  return (
    <button
      type="button"
      className="controls-state icon-crossfade"
      onClick={actions.togglePlayback}
      aria-label={isPlaying ? "Pause" : "Play"}
    >
      <PauseSolid className={isPlaying ? "icon-visible" : "icon-hidden"} />
      <PlaySolid className={isPlaying ? "icon-hidden" : "icon-visible"} />
    </button>
  );
}

/**
 * Media progress slider.
 * Uses frozen playback time to retain slider position during exit animation.
 */
function MediaSlider({ actions }: { actions: MediaControlsActionsOnly }) {
  const time = useFrozenPlaybackTime();

  return (
    <BaseSlider.Root
      className="media-progress-root"
      name="media-progress"
      value={time.currentTime}
      min={0}
      max={time.duration || 1}
      step={0.01}
      onValueChange={(value) => {
        // Enter seeking mode on first value change if not already seeking
        actions.seekStart();
        actions.seek(value);
      }}
      onValueCommitted={() => {
        // Called on drag end, track press, keyboard commit, etc.
        actions.seekEnd();
      }}
      onKeyDown={async (e) => {
        if (e.key === " ") {
          await actions.togglePlayback();
        }
      }}
    >
      <PlaybackTimeDisplay />
      <BaseSlider.Control className="media-progress-control">
        <BaseSlider.Track className="media-progress-track">
          {/* Custom indicator to skip base-ui's expensive style calculations for indicator */}
          <div
            className="media-progress-indicator"
            style={{
              transform: `scaleX(${time.duration ? time.currentTime / time.duration : 0})`,
            }}
          />
          <BaseSlider.Thumb className="media-progress-thumb" />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}

/**
 * Main MediaControls component.
 * Only re-renders on entity selection changes, NOT every frame during playback.
 * Child components (PlayPauseButton, MediaSlider, PlaybackTimeDisplay) handle
 * their own subscriptions to playback time and use frozen state for exit animation.
 */
export function MediaControls() {
  const selectedEntity = useSelectedEntity();
  const actions = useMediaControlsActions(selectedEntity);

  // isIdle checks entity state, not playback time
  const isVisible = !actions.isIdle();

  return (
    <div className="media-controls" hidden={!isVisible}>
      <div className="media-controls__container">
        <PlayPauseButton actions={actions} />
        <MediaSlider actions={actions} />
      </div>
    </div>
  );
}
