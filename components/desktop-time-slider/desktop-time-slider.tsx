import { PauseSolid, PlaySolid } from "iconoir-react";
import { useTimeControl } from "#hooks/use-time-control.ts";
import { Button } from "#ui/button/index.tsx";
import { TimeSlider } from "#ui/time-slider/time-slider.tsx";
import "./desktop-time-slider.css";

export function DesktopTimeSlider() {
  const timeControl = useTimeControl();

  if (!timeControl.isSupported) return null;

  return (
    <div className="desktop-time-slider">
      <span className="desktop-time-slider__label field-label" id="desktop-time-slider-label">
        {timeControl.isMixed ? "Time (Mixed)" : "Time"}
      </span>
      <div className="desktop-time-slider__grid">
        <Button
          variant="primary"
          size="sm"
          icon
          className="desktop-time-slider__button icon-crossfade"
          onClick={timeControl.handleToggle}
          type="button"
          aria-label={timeControl.isAutoPlaying ? "Pause" : "Play"}
        >
          <PauseSolid className={timeControl.isAutoPlaying ? "icon-visible" : "icon-hidden"} />
          <PlaySolid className={timeControl.isAutoPlaying ? "icon-hidden" : "icon-visible"} />
        </Button>
        <div className="desktop-time-slider__slider">
          <TimeSlider
            aria-labelledby="desktop-time-slider-label"
            entity={timeControl.entity}
            isAutoPlaying={timeControl.isAutoPlaying}
            entityTime={timeControl.entityTime}
            onInteractionStart={timeControl.handleTimeInteractionStart}
            onValueChange={timeControl.handleTimeChange}
            onValueCommit={timeControl.handleTimeCommit}
          />
        </div>
      </div>
    </div>
  );
}
