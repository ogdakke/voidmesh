import { PauseSolid, PlaySolid } from "iconoir-react";
import { useCanvas } from "#context/use-canvas.ts";
import { useParamValue } from "#hooks/use-canvas-actions.ts";
import { canvasStore } from "#engine";
import { Button } from "#ui/button/index.tsx";
import { TimeSlider } from "#ui/time-slider/time-slider.tsx";
import "./desktop-time-slider.css";

const SKIP_UNDO = { skipUndo: true } as const;

export function DesktopTimeSlider() {
  const { updateSelectedEntityParams, renderer, selectedEntityIds } = useCanvas();
  const timeParam = useParamValue("time", null);

  // Get the selected entity directly for per-entity time operations
  const entity = (() => {
    if (selectedEntityIds.size !== 1) return null;
    const id = selectedEntityIds.values().next().value;
    return id ? (canvasStore.getState().entities.get(id) ?? null) : null;
  })();

  const isAutoPlaying = entity?.shaderParams.timeAutoPlay !== false;

  const handleToggle = () => {
    if (!entity || !renderer) return;
    const newPlaying = !isAutoPlaying;
    if (!newPlaying) {
      // Sync entity param to current time on pause
      const currentTime = renderer.getEntityTime(entity);
      updateSelectedEntityParams({ time: currentTime }, SKIP_UNDO);
    }
    renderer.setEntityTimeAutoPlay(entity, newPlaying);
    updateSelectedEntityParams({ timeAutoPlay: newPlaying }, SKIP_UNDO);
  };

  const handleTimeChange = (time: number) => {
    if (!entity || !renderer) return;
    renderer.setEntityTime(entity, time);
    updateSelectedEntityParams({ time }, SKIP_UNDO);
  };

  const handleTimeInteractionStart = () => {
    if (!entity || !renderer) return;
    renderer.setEntityTimeAutoPlay(entity, false);
    // Sync slider to current auto-play time
    const currentTime = renderer.getEntityTime(entity);
    updateSelectedEntityParams({ time: currentTime, timeAutoPlay: false }, SKIP_UNDO);
  };

  if (!timeParam.isSupported) return null;

  return (
    <div className="desktop-time-slider">
      <span className="desktop-time-slider__label field-label" id="desktop-time-slider-label">
        {timeParam.isMixed ? "Time (Mixed)" : "Time"}
      </span>
      <div className="desktop-time-slider__grid">
        <Button
          variant="primary"
          size="sm"
          icon
          className="desktop-time-slider__button icon-crossfade"
          onClick={handleToggle}
          type="button"
          aria-label={isAutoPlaying ? "Pause" : "Play"}
        >
          <PauseSolid className={isAutoPlaying ? "icon-visible" : "icon-hidden"} />
          <PlaySolid className={isAutoPlaying ? "icon-hidden" : "icon-visible"} />
        </Button>
        <div className="desktop-time-slider__slider">
          <TimeSlider
            aria-labelledby="desktop-time-slider-label"
            entity={entity}
            isAutoPlaying={isAutoPlaying}
            entityTime={timeParam.value ?? 0}
            onInteractionStart={handleTimeInteractionStart}
            onValueChange={handleTimeChange}
          />
        </div>
      </div>
    </div>
  );
}
