import { useState } from "react";
import { SoundHigh, SoundOff } from "iconoir-react";
import type { MediaControlActions, MediaControlSource } from "#hooks/use-media-control-source.ts";

export function MediaMuteButton({
  source,
  actions,
}: {
  source: MediaControlSource;
  actions: Pick<MediaControlActions, "toggleMuted">;
}) {
  const [isMuted, setIsMuted] = useState(() => source.getIsMuted());

  if (!source.getCanToggleMuted()) return null;

  const handleClick = () => {
    actions.toggleMuted();
    setIsMuted(source.getIsMuted());
  };

  return (
    <button
      type="button"
      className="mute-button controls-state icon-crossfade"
      onClick={handleClick}
      aria-label={isMuted ? "Unmute" : "Mute"}
    >
      <SoundOff className={isMuted ? "icon-visible" : "icon-hidden"} />
      <SoundHigh className={isMuted ? "icon-hidden" : "icon-visible"} />
    </button>
  );
}
