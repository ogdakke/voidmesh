import About from "#components/about/index.tsx";
import DesktopSettings from "#components/settings/settings.desktop.tsx";
import {
  useCanvasCommands,
  useCanvasInteraction,
  useCanvasPreferences,
  useMultiSelectMode,
  useSelectedEntityIds,
} from "#context/use-canvas.ts";
import { useLayout } from "#context/use-layout.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { Check, Enlarge, Reduce } from "iconoir-react";
import type { RefObject } from "react";
import SettingsDrawer from "../settings/settings.mobile.tsx";
import { Button } from "../ui/button/index.tsx";
import { MinimapControl } from "./minimap-control.tsx";
import { UndoRedoButtons } from "./undo-redo.tsx";

interface CanvasOverlayProps {
  containerRef: RefObject<HTMLDivElement | null>;
  perfRef: RefObject<HTMLDivElement | null>;
  onboarding: { active: boolean; skip: () => void };
  resetZoom: () => void;
}

export function CanvasOverlay({
  containerRef,
  perfRef,
  onboarding,
  resetZoom,
}: CanvasOverlayProps) {
  const isMobile = useIsMobile();
  const { isFullscreen } = useLayout();
  const { minimap } = useCanvasPreferences();

  return (
    <div className="infinite-canvas__overlay">
      <div ref={perfRef} className="infinite-canvas__perf-overlay" style={{ display: "none" }} />
      {!isMobile && (
        <>
          {minimap && <MinimapControl containerRef={containerRef} onZoomReset={resetZoom} />}
          <DesktopTopControls />
        </>
      )}
      {!(isMobile && isFullscreen) && (
        <div className="infinite-canvas-toolrow">
          <CanvasToolRowStart onboarding={onboarding} />
          {isMobile && <MobileCanvasActions />}
        </div>
      )}
    </div>
  );
}

function DesktopTopControls() {
  const { isFullscreen, toggleFullscreen } = useLayout();
  return (
    <>
      <div className="infinite-canvas__top-left">
        <DesktopSettings />
      </div>
      <div className="infinite-canvas__top-right">
        <Button
          onClick={toggleFullscreen}
          type="button"
          aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          variant="secondary"
          size="sm"
        >
          {isFullscreen ? <Reduce /> : <Enlarge />}
        </Button>
      </div>
    </>
  );
}

function CanvasToolRowStart({ onboarding }: { onboarding: CanvasOverlayProps["onboarding"] }) {
  return (
    <div className="left-controls">
      <div className="left-controls__top">
        <About className="infinite-canvas__keyboard-shortcuts" />
        <UndoRedoButtons />
      </div>
      {onboarding.active && (
        <div className="onboarding-container">
          <Button
            className="infinite-canvas__skip-onboarding"
            onClick={onboarding.skip}
            type="button"
            size="sm"
          >
            Skip onboarding
          </Button>
        </div>
      )}
    </div>
  );
}

function MobileCanvasActions() {
  const interaction = useCanvasInteraction();
  const { resetSelectionToDefaults } = useCanvasCommands();
  const selectedEntityIds = useSelectedEntityIds();
  const multiSelectMode = useMultiSelectMode();

  return (
    <div className="infinite-canvas__controls">
      {multiSelectMode ? (
        <Button
          className="infinite-canvas__confirm"
          onClick={() => interaction.setMultiSelectMode(false)}
          type="button"
          aria-label="Confirm selection"
          variant="primary"
          size="sm"
        >
          <Check />
        </Button>
      ) : selectedEntityIds.size > 0 ? (
        <Button
          className="infinite-canvas__reset"
          onClick={resetSelectionToDefaults}
          type="button"
          aria-label="Reset to defaults"
          variant="secondary"
          size="sm"
        >
          Reset
        </Button>
      ) : (
        <Button
          className="infinite-canvas__select"
          onClick={() => interaction.setMultiSelectMode(true)}
          type="button"
          aria-label="Enter selection mode"
          variant="secondary"
          size="sm"
        >
          Select
        </Button>
      )}
      <SettingsDrawer />
    </div>
  );
}
