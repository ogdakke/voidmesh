import { useSelectedEntity } from "#context/use-canvas.ts";
import { createEntityMediaControlSourceState } from "#hooks/use-media-control-source.ts";
import { useMediaControlsActions } from "#hooks/use-media-controls.ts";
import { MediaControlSurface } from "./media-control-surface.tsx";
import { MediaMuteButton } from "./media-mute-button.tsx";
import { MediaPlayButton } from "./media-play-button.tsx";
import { MediaProgressCanvas } from "./media-progress-canvas.tsx";
import "./media-controls.css";

export function MediaControls({ hidden = false }: { hidden?: boolean }) {
  const selectedEntity = useSelectedEntity();
  const actions = useMediaControlsActions(selectedEntity);
  const { source, isLive } = createEntityMediaControlSourceState(selectedEntity);

  return (
    <MediaControlSurface hidden={hidden || !isLive}>
      {source && (
        <>
          <MediaPlayButton key={`${source.id}:${isLive}:play`} source={source} actions={actions} />
          <MediaProgressCanvas source={source} actions={actions} />
          <MediaMuteButton key={`${source.id}:${isLive}:mute`} source={source} actions={actions} />
        </>
      )}
    </MediaControlSurface>
  );
}
