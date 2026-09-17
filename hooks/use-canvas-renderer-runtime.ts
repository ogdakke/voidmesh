import { config, getMiniMapConfig, getViewportLensDistortionConfig } from "#config";
import { useCanvasInteraction, useCanvasRendererService } from "#context/use-canvas.ts";
import { appLoader } from "#lib/app-loader.ts";
import { applyWlurOverlayDebugConfig } from "#renderer/wlur-debug.ts";
import { createDefaultWlurOverlayConfig } from "#renderer/wlur-overlay.ts";
import { useEffect, type RefObject } from "react";
import { useCanvasRenderer } from "./use-canvas-renderer.ts";

interface UseCanvasRendererRuntimeOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  perfRef: RefObject<HTMLDivElement | null>;
  darkTheme: boolean;
  canvasLensing: Parameters<typeof getViewportLensDistortionConfig>[0];
  minimap: boolean;
  isMobile: boolean;
  isFullscreen: boolean;
}

export function useCanvasRendererRuntime({
  canvasRef,
  containerRef,
  perfRef,
  darkTheme,
  canvasLensing,
  minimap,
  isMobile,
  isFullscreen,
}: UseCanvasRendererRuntimeOptions) {
  const interaction = useCanvasInteraction();
  const { registerRenderer, debugMode, wlurDebugConfig } = useCanvasRendererService();
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
    renderer?.setMinimapConfig(getMiniMapConfig({ enabled: minimap }));
    interaction.markContainerDirty();
  }, [interaction, minimap, renderer]);

  useEffect(() => {
    appLoader.setText("Initializing canvas...");
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

    const tintColor = darkTheme ? ([0, 0, 0] as const) : ([1, 1, 1] as const);
    const overlay =
      isMobile && !isFullscreen
        ? createDefaultWlurOverlayConfig({
            tintColor,
            tintAmount: darkTheme ? 1 : 0.77,
          })
        : null;
    renderer.setWlurOverlay(
      overlay && debugMode
        ? applyWlurOverlayDebugConfig(overlay, wlurDebugConfig, tintColor)
        : overlay,
    );

    registerRenderer(renderer);
    interaction.start();
    return () => interaction.stop();
  }, [
    darkTheme,
    debugMode,
    interaction,
    isFullscreen,
    isMobile,
    isReady,
    registerRenderer,
    renderer,
    wlurDebugConfig,
  ]);

  return rendererState;
}
