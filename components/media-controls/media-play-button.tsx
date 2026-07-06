import { useEffect, useState } from "react";
import { PauseSolid, PlaySolid } from "iconoir-react";
import type { MediaControlActions, MediaControlSource } from "#hooks/use-media-control-source.ts";

export function MediaPlayButton({
  source,
  actions,
}: {
  source: MediaControlSource;
  actions: Pick<MediaControlActions, "togglePlayback">;
}) {
  const [isPlaying, setIsPlaying] = useState(() => source.getIsPlaying());

  useEffect(() => {
    let previous = source.getIsPlaying();
    const syncPlaying = () => {
      const next = source.getIsPlaying();
      if (next !== previous) {
        previous = next;
        setIsPlaying(next);
      }
    };
    const unsubscribe = source.subscribe(syncPlaying);
    return () => {
      unsubscribe();
    };
  }, [source]);

  const handleClick = async () => {
    await actions.togglePlayback();
    setIsPlaying(source.getIsPlaying());
  };

  return (
    <button
      type="button"
      className="controls-state icon-crossfade"
      onClick={handleClick}
      aria-label={isPlaying ? "Pause" : "Play"}
    >
      <PauseSolid className={isPlaying ? "icon-visible" : "icon-hidden"} />
      <PlaySolid className={isPlaying ? "icon-hidden" : "icon-visible"} />
    </button>
  );
}
