import About from "#components/about/index.tsx";
import DesktopSettings from "#components/settings/settings.desktop.tsx";
import {
  useCanvasInteraction,
  useMultiSelectMode,
  useSelectedEntityIds,
  useViewportZoom,
} from "#context/use-canvas.ts";
import { useLayout } from "#context/use-layout.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { Check, Enlarge, Reduce, Square3dFromCenter } from "iconoir-react";
import type { RefObject } from "react";
import SettingsDrawer from "../settings/settings.mobile.tsx";
import { Button } from "../ui/button/index.tsx";
import { UndoRedoButtons } from "./undo-redo.tsx";
import { useHostedWorkspaceRuntime } from "#context/use-hosted-workspace-runtime.ts";

interface CanvasOverlayProps {
  perfRef: RefObject<HTMLDivElement | null>;
  onboarding: { active: boolean; skip: () => void };
  centerSelection: () => void;
  resetZoom: () => void;
}

export function CanvasOverlay({
  perfRef,
  onboarding,
  centerSelection,
  resetZoom,
}: CanvasOverlayProps) {
  const isMobile = useIsMobile();
  const { isFullscreen } = useLayout();

  return (
    <div className="infinite-canvas__overlay">
      <div ref={perfRef} className="infinite-canvas__perf-overlay" style={{ display: "none" }} />
      {!isMobile && <DesktopTopControls />}
      {!(isMobile && isFullscreen) && (
        <div className="infinite-canvas-toolrow">
          <CanvasToolRowStart onboarding={onboarding} />
          {isMobile ? (
            <MobileCanvasActions />
          ) : (
            <DesktopCanvasActions centerSelection={centerSelection} resetZoom={resetZoom} />
          )}
        </div>
      )}
    </div>
  );
}

function DesktopTopControls() {
  const { isFullscreen, toggleFullscreen } = useLayout();
  const hosted = useHostedWorkspaceRuntime();
  return (
    <>
      <div className="infinite-canvas__top-left">
        <DesktopSettings />
        <Button
          className="hosted-workspace-indicator"
          onClick={() => location.assign("/cloud")}
          type="button"
          aria-label="Open cloud workspaces"
          variant="secondary"
          size="sm"
        >
          {hosted && (
            <span
              className="hosted-workspace-indicator__status"
              data-status={hosted.connectionStatus}
            />
          )}
          {hosted?.workspace.title ?? "Cloud"}
          {hosted?.workspace.role === "viewer" && (
            <span className="hosted-workspace-indicator__role">View only</span>
          )}
          {hosted && hosted.peerCount > 0 && (
            <span className="hosted-workspace-indicator__peers">+{hosted.peerCount}</span>
          )}
        </Button>
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

function DesktopCanvasActions({
  centerSelection,
  resetZoom,
}: Pick<CanvasOverlayProps, "centerSelection" | "resetZoom">) {
  const selectedEntityIds = useSelectedEntityIds();
  const zoom = useViewportZoom();
  return (
    <div className="infinite-canvas__controls">
      <Button
        className="infinite-canvas__center"
        onClick={centerSelection}
        type="button"
        aria-label="Center selection in view"
        variant="secondary"
        size="sm"
        disabled={selectedEntityIds.size === 0}
      >
        <Square3dFromCenter />
      </Button>
      <Button
        className="infinite-canvas__zoom-indicator"
        onClick={resetZoom}
        type="button"
        aria-label="Reset zoom to 100%"
        size="sm"
        variant="secondary"
      >
        {Math.round(zoom * 100)}%
      </Button>
    </div>
  );
}

function MobileCanvasActions() {
  const interaction = useCanvasInteraction();
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
