import { logger } from "#lib/client.logger.ts";
import { createEnum } from "#types/index.ts";
import { useEffect, useRef, useState } from "react";
import { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import { GpuDeviceRecovery, WebGpuUnavailableError } from "#renderer/gpu-device-recovery.ts";

export const CanvasRendererStatus = createEnum({
  initializing: "initializing",
  ready: "ready",
  /** The GPU device was lost; a replacement renderer is being created. */
  recovering: "recovering",
  /** The browser has no usable WebGPU. */
  unsupported: "unsupported",
  /** The GPU failed and automatic recovery gave up; the user can retry or reload. */
  crashed: "crashed",
});
export type CanvasRendererStatus = typeof CanvasRendererStatus.infer;

export interface UseCanvasRendererResult {
  renderer: InfiniteCanvasRenderer | null;
  status: CanvasRendererStatus;
  isReady: boolean;
  /** False when the canvas cannot render (unsupported or crashed); keeps the canvas mounted otherwise. */
  isSupported: boolean;
  error: Error | null;
  /** Start a fresh renderer with a new retry budget. */
  retry: () => void;
}

const UNSUPPORTED_ERROR = new Error("WebGPU is not supported in this browser");

/**
 * Hook for managing the WebGPU infinite canvas renderer lifecycle.
 *
 * A lost GPU device (iOS GPU process kill, driver reset, OOM) is recovered by replacing the whole
 * renderer: the new instance requests a fresh adapter/device and re-uploads textures lazily from
 * the CPU-side media assets that canvas state still owns. Retries are bounded by
 * `GpuDeviceRecovery`; after that the canvas reports `crashed`.
 */
export function useCanvasRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
): UseCanvasRendererResult {
  const [renderer, setRenderer] = useState<InfiniteCanvasRenderer | null>(null);
  const [status, setStatus] = useState<CanvasRendererStatus>(() =>
    navigator.gpu ? CanvasRendererStatus.initializing : CanvasRendererStatus.unsupported,
  );
  const [error, setError] = useState<Error | null>(() =>
    navigator.gpu ? null : UNSUPPORTED_ERROR,
  );
  // Each bump replaces the renderer instance.
  const [generation, setGeneration] = useState(0);
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null);
  const recoveryRef = useRef<GpuDeviceRecovery | null>(null);
  const hasBeenReadyRef = useRef(false);

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
    if (!canvasElement || !navigator.gpu) return;

    recoveryRef.current ??= new GpuDeviceRecovery();
    const recovery = recoveryRef.current;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let onVisible: (() => void) | null = null;

    const renderer = new InfiniteCanvasRenderer(canvasElement);

    const replaceRenderer = () => {
      // Backgrounded iOS pages cannot get a device; wait until the page is visible again.
      if (document.visibilityState === "visible") {
        setGeneration((value) => value + 1);
        return;
      }
      onVisible = () => {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", onVisible!);
        onVisible = null;
        setGeneration((value) => value + 1);
      };
      document.addEventListener("visibilitychange", onVisible);
    };

    const scheduleRecovery = (cause: Error) => {
      setRenderer(null);
      setError(cause);
      const delay = recovery.nextAttemptDelay(performance.now());
      if (delay === null) {
        logger.error("[useCanvasRenderer] GPU recovery gave up:", cause);
        setStatus(CanvasRendererStatus.crashed);
        return;
      }
      logger.warn(`[useCanvasRenderer] Recreating GPU device in ${delay}ms:`, cause);
      setStatus(CanvasRendererStatus.recovering);
      retryTimer = setTimeout(replaceRenderer, delay);
    };

    renderer.onDeviceLost = (lostError) => {
      if (cancelled) return;
      scheduleRecovery(lostError);
    };

    renderer
      .initialize()
      .then(() => {
        if (cancelled) return;
        hasBeenReadyRef.current = true;
        recovery.markReady(performance.now());
        setRenderer(renderer);
        setStatus(CanvasRendererStatus.ready);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // Only a first start without an adapter means WebGPU is genuinely unavailable. After a
        // crash, a missing adapter is the GPU process still restarting.
        if (!hasBeenReadyRef.current && err instanceof WebGpuUnavailableError) {
          logger.error("Failed to initialize canvas renderer:", err);
          setStatus(CanvasRendererStatus.unsupported);
          setError(err);
          return;
        }
        scheduleRecovery(err);
      });

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      renderer.destroy();
      setRenderer(null);
    };
  }, [canvasElement, generation]);

  const retry = () => {
    recoveryRef.current?.reset();
    setStatus(CanvasRendererStatus.initializing);
    setError(null);
    setGeneration((value) => value + 1);
  };

  return {
    renderer,
    status,
    isReady: status === CanvasRendererStatus.ready && renderer !== null,
    isSupported:
      status !== CanvasRendererStatus.unsupported && status !== CanvasRendererStatus.crashed,
    error,
    retry,
  };
}
