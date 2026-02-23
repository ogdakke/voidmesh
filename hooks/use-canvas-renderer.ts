import { logger } from "#lib/client.logger.ts";
import { useEffect, useRef, useState } from "react";
import { InfiniteCanvasRenderer } from "../renderer/canvas-renderer.ts";

export interface UseCanvasRendererResult {
  renderer: InfiniteCanvasRenderer | null;
  isReady: boolean;
  isSupported: boolean;
  error: Error | null;
}

/**
 * Hook for managing the WebGPU infinite canvas renderer lifecycle.
 * Handles initialization, cleanup, and provides the renderer instance.
 */
export function useCanvasRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
): UseCanvasRendererResult {
  const [isReady, setIsReady] = useState(false);
  const [isSupported, setIsSupported] = useState(() => !!navigator.gpu);
  const [error, setError] = useState<Error | null>(() =>
    navigator.gpu ? null : new Error("WebGPU is not supported in this browser"),
  );
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null);
  const [renderer, setRenderer] = useState<InfiniteCanvasRenderer | null>(null);
  const rendererRef = useRef<InfiniteCanvasRenderer | null>(null);
  const initializingRef = useRef(false);

  // Track canvas element changes via polling (handles React remounts)
  useEffect(() => {
    const checkCanvas = () => {
      const current = canvasRef.current;
      if (current !== canvasElement) {
        logger.debug(
          "[useCanvasRenderer] Canvas element changed:",
          current ? "new element" : "null",
        );
        setCanvasElement(current);
      }
    };

    // Check immediately
    checkCanvas();

    // Poll for changes (handles cases where ref updates without re-render)
    const interval = setInterval(checkCanvas, 100);
    return () => clearInterval(interval);
  }, [canvasRef, canvasElement]);

  useEffect(() => {
    if (!canvasElement) return;

    // Check if already initializing or initialized
    if (initializingRef.current || rendererRef.current?.isReady) {
      return;
    }

    // Skip if WebGPU not supported (handled by initial state)
    if (!navigator.gpu) return;

    initializingRef.current = true;

    const renderer = new InfiniteCanvasRenderer(canvasElement);
    rendererRef.current = renderer;

    renderer
      .initialize()
      .then(() => {
        setRenderer(renderer);
        setIsReady(true);
        setError(null);
      })
      .catch((err: Error) => {
        setError(err);
        setIsSupported(false);
        logger.error("Failed to initialize canvas renderer:", err);
      })
      .finally(() => {
        initializingRef.current = false;
      });

    return () => {
      renderer.destroy();
      rendererRef.current = null;
      setRenderer(null);
      setIsReady(false);
    };
  }, [canvasElement]);

  return {
    renderer,
    isReady,
    isSupported,
    error,
  };
}
