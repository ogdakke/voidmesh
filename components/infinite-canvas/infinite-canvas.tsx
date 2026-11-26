import { useKeybinds } from "#context/keybind-context.ts";
import { useCanvasInteraction, useCanvasPreferences } from "#context/use-canvas.ts";
import { useLayout } from "#context/use-layout.ts";
import { useCanvasContainerResize } from "#hooks/use-canvas-container-resize.ts";
import { CanvasRendererStatus } from "#hooks/use-canvas-renderer.ts";
import { useCanvasRendererRuntime } from "#hooks/use-canvas-renderer-runtime.ts";
import { useCanvasSurfaceEvents } from "#hooks/use-canvas-surface-events.ts";
import { useImageInput } from "#hooks/use-image-input.ts";
import { useInfiniteCanvasKeybinds } from "#hooks/use-infinite-canvas-keybinds.ts";
import { useIsCompactLandscape, useIsMobile } from "#hooks/use-is-mobile.ts";
import useMediaQuery from "#hooks/use-media-query.ts";
import { useIsStandalone } from "#hooks/use-is-standalone.ts";
import { useOnboarding } from "#hooks/use-onboarding.ts";
import { useViewportInsets } from "#hooks/use-viewport-insets.ts";
import { NO_VIEWPORT_INSETS } from "#lib/canvas-math.ts";
import { lazy, Suspense, useEffect, useRef, type PropsWithChildren } from "react";
import { Button } from "#ui/button/button.tsx";
import { DropZone } from "../ui/dropzone/index.tsx";
import { CanvasOverlay } from "./canvas-overlay.tsx";
import "./infinite-canvas.css";

const CanvasContextMenu = lazy(() => import("./canvas-context-menu.tsx"));

export function InfiniteCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const perfRef = useRef<HTMLDivElement>(null);
  const { canvasLensing } = useCanvasPreferences();
  const keybindStore = useKeybinds();
  const isMobile = useIsMobile();
  const isCompactLandscape = useIsCompactLandscape();
  const darkTheme = useMediaQuery("(prefers-color-scheme: dark)");
  const isStandalone = useIsStandalone();
  const { isFullscreen } = useLayout();
  const interaction = useCanvasInteraction();
  const insets = useViewportInsets();

  useEffect(() => {
    interaction.setViewportInsets(isFullscreen ? NO_VIEWPORT_INSETS : insets);
  }, [interaction, insets, isFullscreen]);

  const { isReady, isSupported, status, error, retry } = useCanvasRendererRuntime({
    canvasRef,
    containerRef,
    perfRef,
    darkTheme,
    canvasLensing,
    isMobile,
    isCompactLandscape,
    isFullscreen,
    isStandalone,
  });
  const keybinds = useInfiniteCanvasKeybinds(containerRef);
  const surface = useCanvasSurfaceEvents({
    canvasRef,
    containerRef,
    isMobile,
    isReady,
    onSpaceTap: keybinds.playPause,
  });
  const { handleDrop } = useImageInput({ containerRef, multipleFiles: true });
  const onboarding = useOnboarding({ containerRef, ready: isReady });
  useCanvasContainerResize(containerRef);

  return (
    <DropZone onDrop={handleDrop} className="infinite-canvas-dropzone">
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={containerRef}
        className={`infinite-canvas${surface.isSpaceHeld ? " infinite-canvas--space" : ""}`}
        role="application"
        data-ready={isReady || undefined}
        tabIndex={0}
        onFocus={() => keybindStore.setActiveContext("canvas")}
        onBlur={() => keybindStore.setActiveContext("global")}
      >
        {isSupported ? (
          <CanvasWrapper
            onOpenChange={surface.handleContextMenuOpenChange}
            containerRef={containerRef}
          >
            <canvas
              ref={canvasRef}
              onPointerDown={surface.handlePointerDown}
              onPointerMove={surface.handlePointerMove}
              onPointerUp={surface.handlePointerUp}
              onPointerCancel={surface.handlePointerUp}
              onTouchStart={surface.handleTouchStart}
              onTouchMove={surface.handleTouchMove}
              onTouchEnd={surface.handleTouchEnd}
              onTouchCancel={surface.handleTouchCancel}
              onContextMenu={surface.handleContextMenu}
              className="infinite-canvas__canvas"
            />
          </CanvasWrapper>
        ) : (
          <CanvasRendererFailure status={status} error={error} onRetry={retry} />
        )}
        {status === CanvasRendererStatus.recovering && (
          <output className="infinite-canvas-recovering">
            Restoring canvas after a GPU crash…
          </output>
        )}
        <CanvasOverlay
          perfRef={perfRef}
          onboarding={onboarding}
          centerSelection={keybinds.centerSelection}
          resetZoom={keybinds.resetZoom}
        />
      </div>
    </DropZone>
  );
}

function CanvasRendererFailure({
  status,
  error,
  onRetry,
}: {
  status: CanvasRendererStatus;
  error: Error | null;
  onRetry: () => void;
}) {
  if (status === CanvasRendererStatus.unsupported) {
    return (
      <div className="infinite-canvas-error">
        <p>WebGPU is not supported in your browser.</p>
      </div>
    );
  }

  return (
    <div className="infinite-canvas-error" role="alert">
      <p>The GPU crashed and the canvas couldn’t recover.</p>
      {error && <p className="error-message">{error.message}</p>}
      <div className="infinite-canvas-error__actions">
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
        <Button type="button" variant="secondary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
      <p className="infinite-canvas-error__hint">Reloading discards unsaved changes.</p>
    </div>
  );
}

function CanvasWrapper({
  children,
  containerRef,
  onOpenChange,
}: PropsWithChildren<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
}>) {
  const isMobile = useIsMobile();
  return isMobile ? (
    children
  ) : (
    <Suspense>
      <CanvasContextMenu onOpenChange={onOpenChange} containerRef={containerRef}>
        {children}
      </CanvasContextMenu>
    </Suspense>
  );
}
