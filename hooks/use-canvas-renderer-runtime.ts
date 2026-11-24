import { config, getViewportLensDistortionConfig } from "#config";
import { useCanvasInteraction, useCanvasRendererService } from "#context/use-canvas.ts";
import { appLoader } from "#renderer/app-loader/app-loader.ts";
import { applyWlurOverlayDebugConfig } from "#renderer/wlur-debug.ts";
import { createMobileWlurOverlayConfig } from "#renderer/wlur-overlay.ts";
import { useEffect, type RefObject } from "react";
import { useCanvasRenderer } from "./use-canvas-renderer.ts";

interface UseCanvasRendererRuntimeOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  perfRef: RefObject<HTMLDivElement | null>;
  darkTheme: boolean;
  canvasLensing: Parameters<typeof getViewportLensDistortionConfig>[0];
  isMobile: boolean;
  /** Mobile controls sit on the right edge instead of the bottom. */
  isCompactLandscape: boolean;
  isFullscreen: boolean;
  /** Installed home-screen app: selects the PWA overlay preset. */
  isStandalone: boolean;
}

export function useCanvasRendererRuntime({
  canvasRef,
  containerRef,
  perfRef,
  darkTheme,
  canvasLensing,
  isMobile,
  isCompactLandscape,
  isFullscreen,
  isStandalone,
}: UseCanvasRendererRuntimeOptions) {
  const interaction = useCanvasInteraction();
  const { registerRenderer, debugMode, wlurDebugOverrides } = useCanvasRendererService();
  const rendererState = useCanvasRenderer(canvasRef);
  const { renderer, isReady, isSupported } = rendererState;

  useEffect(() => {
    renderer?.setViewportLensColorScheme(darkTheme);
    interaction.markContainerDirty();
  }, [darkTheme, interaction, renderer]);

  useEffect(() => {
    renderer?.setViewportLensDistortion(getViewportLensDistortionConfig(canvasLensing));
    interaction.markContainerDirty();
  }, [canvasLensing, interaction, renderer]);

  useEffect(() => {
    appLoader.setText("Initializing canvas…");
  }, []);

  useEffect(() => {
    if (!isReady && isSupported) return;
    appLoader.dismiss();
    console.info("canvas ready", {
      durationMs: Date.now() - appLoader.startTime,
      p3: renderer?.colorConfig.supportsP3,
    });
  }, [isReady, isSupported, renderer?.colorConfig.supportsP3]);

  useEffect(() => {
    const container = containerRef.current;
    const perfElement = perfRef.current;
    if (container && perfElement) interaction.attach(container, perfElement);
  }, [containerRef, interaction, perfRef]);

  useEffect(() => {
    if (!renderer || !isReady) return;

    renderer.setGridConfig(darkTheme ? config.rendering.grid.dark : config.rendering.grid.default);
    renderer.setActionLayerTint(
      darkTheme ? config.actionLayer.dimColor.dark : config.actionLayer.dimColor.light,
    );
    renderer.setSelectionRectConfig(
      darkTheme ? config.selectionRectangle.dark : config.selectionRectangle.light,
      darkTheme ? config.multiSelectBoundingBox.dark : config.multiSelectBoundingBox.light,
    );

    const overlay =
      isMobile && !isFullscreen
        ? createMobileWlurOverlayConfig({
            darkTheme,
            edge: isCompactLandscape ? "right" : "bottom",
            mode: isStandalone ? "pwa" : "browser",
          })
        : null;
    renderer.setWlurOverlay(
      overlay && debugMode ? applyWlurOverlayDebugConfig(overlay, wlurDebugOverrides) : overlay,
    );

    registerRenderer(renderer);
    interaction.start();
    return () => interaction.stop();
  }, [
    darkTheme,
    debugMode,
    interaction,
    isCompactLandscape,
    isFullscreen,
    isMobile,
    isStandalone,
    isReady,
    registerRenderer,
    renderer,
    wlurDebugOverrides,
  ]);

  return rendererState;
}
