import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { getCssVarPx, resolveCssVarColor } from "#lib/css.ts";
import { formatMediaTimeParts } from "#lib/time-format.ts";
import {
  captureMediaControlSnapshot,
  type MediaControlActions,
  type MediaControlSource,
} from "#hooks/use-media-control-source.ts";
import {
  renderMediaProgress,
  type MediaProgressFrame,
  type MediaProgressRenderConfig,
} from "./media-progress-renderer.ts";

interface MediaProgressCanvasProps {
  source: MediaControlSource;
  actions: MediaControlActions;
  ariaLabel?: string;
}

const DEFAULT_CONFIG: MediaProgressRenderConfig = {
  trackColor: "rgb(230, 230, 230)",
  progressColor: "rgb(0, 122, 255)",
  textColor: "rgb(0, 0, 0)",
  fontFamily: "system-ui, sans-serif",
  fontWeight: "400",
  fontSize: 14,
  textY: 16,
  trackHeight: 8,
  trackRadius: 999,
};

const SCRUB_ANIMATION_MS = 170;
const SCRUB_ANIMATION_EPSILON = 0.001;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatAriaTime(seconds: number): string {
  const parts = formatMediaTimeParts(seconds);
  return `${parts.main}:${parts.ms}`;
}

function resolveRenderConfig(root: HTMLElement): MediaProgressRenderConfig {
  const style = getComputedStyle(root);
  const fontSize = Number.parseFloat(style.fontSize) || DEFAULT_CONFIG.fontSize;
  const trackRadius = getCssVarPx("--radius-button", root) || DEFAULT_CONFIG.trackRadius;
  const isMobile = window.matchMedia("(max-width: 768px)").matches;

  return {
    trackColor: resolveCssVarColor("--gray-200", root) ?? DEFAULT_CONFIG.trackColor,
    progressColor: resolveCssVarColor("--media-progress-bar", root) ?? DEFAULT_CONFIG.progressColor,
    textColor: resolveCssVarColor("--color", root) ?? DEFAULT_CONFIG.textColor,
    fontFamily: style.fontFamily || DEFAULT_CONFIG.fontFamily,
    fontWeight: style.fontWeight || DEFAULT_CONFIG.fontWeight,
    fontSize,
    textY: isMobile ? 13 : Math.max(fontSize, 16),
    trackHeight: 8,
    trackRadius,
  };
}

export function MediaProgressCanvas({
  source,
  actions,
  ariaLabel = "Media progress",
}: MediaProgressCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const configRef = useRef<MediaProgressRenderConfig>(DEFAULT_CONFIG);
  const sizeRef = useRef({ width: 0, height: 0 });
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);
  const scrubProgressRef = useRef(0);
  const scrubTargetRef = useRef(0);
  const isDraggingRef = useRef(false);
  const isHoveredRef = useRef(false);
  const isFocusedRef = useRef(false);
  const lastSeekTimeRef = useRef<number | null>(null);
  const lastAriaTimeRef = useRef(-1);
  const lastFrameRef = useRef<MediaProgressFrame>({
    currentTime: 0,
    duration: 0,
    currentParts: formatMediaTimeParts(0),
    durationParts: formatMediaTimeParts(0),
    hovered: false,
    focused: false,
    dragging: false,
    scrubProgress: 0,
  });

  function updateScrubAnimation() {
    const now = performance.now();
    const previous = lastFrameTimeRef.current || now;
    lastFrameTimeRef.current = now;

    const target = scrubTargetRef.current;
    const current = scrubProgressRef.current;
    const delta = Math.max(0, now - previous);
    const amount = 1 - Math.exp((-delta * 4) / SCRUB_ANIMATION_MS);
    const next = current + (target - current) * amount;

    if (Math.abs(target - next) <= SCRUB_ANIMATION_EPSILON) {
      scrubProgressRef.current = target;
    } else {
      scrubProgressRef.current = next;
    }
  }

  function isScrubAnimating() {
    return Math.abs(scrubTargetRef.current - scrubProgressRef.current) > SCRUB_ANIMATION_EPSILON;
  }

  function updateAria(force = false) {
    const root = rootRef.current;
    if (!root) return;

    const duration = source.getDuration();
    const currentTime = clamp(source.getCurrentTime(), 0, duration || Number.POSITIVE_INFINITY);
    captureMediaControlSnapshot(source);

    if (!force && Math.abs(currentTime - lastAriaTimeRef.current) < 0.25) return;
    lastAriaTimeRef.current = currentTime;

    root.setAttribute("aria-valuemin", "0");
    root.setAttribute("aria-valuemax", duration.toFixed(2));
    root.setAttribute("aria-valuenow", currentTime.toFixed(2));
    root.setAttribute(
      "aria-valuetext",
      `${formatAriaTime(currentTime)} of ${formatAriaTime(duration)}`,
    );
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = sizeRef.current;
    if (width <= 0 || height <= 0) return;

    const duration = source.getDuration();
    const currentTime = clamp(source.getCurrentTime(), 0, duration || Number.POSITIVE_INFINITY);
    updateScrubAnimation();
    const frame: MediaProgressFrame = {
      currentTime,
      duration,
      currentParts: formatMediaTimeParts(currentTime),
      durationParts: formatMediaTimeParts(duration),
      hovered: isHoveredRef.current,
      focused: isFocusedRef.current,
      dragging: isDraggingRef.current,
      scrubProgress: scrubProgressRef.current,
    };
    lastFrameRef.current = frame;
    captureMediaControlSnapshot(source);
    renderMediaProgress(ctx, width, height, frame, configRef.current);
    updateAria();
  }

  function stopLoop() {
    if (rafRef.current == null) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  function startLoop() {
    if (rafRef.current != null) return;
    const tick = () => {
      draw();
      if (source.getIsPlaying() || isDraggingRef.current || isScrubAnimating()) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function seekFromClientX(clientX: number) {
    const root = rootRef.current;
    if (!root) return;
    const duration = source.getDuration();
    if (duration <= 0) return;
    const rect = root.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    const nextTime = ratio * duration;
    if (lastSeekTimeRef.current != null && Math.abs(nextTime - lastSeekTimeRef.current) < 0.01) {
      return;
    }
    lastSeekTimeRef.current = nextTime;
    actions.seek(nextTime);
    draw();
    updateAria(true);
  }

  const drawEffect = useEffectEvent(() => draw());
  const updateAriaEffect = useEffectEvent((force = false) => updateAria(force));
  const startLoopEffect = useEffectEvent(() => startLoop());
  const stopLoopEffect = useEffectEvent(() => stopLoop());

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const resolveAndDraw = () => {
      configRef.current = resolveRenderConfig(root);
      drawEffect();
    };

    resolveAndDraw();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", resolveAndDraw);
    return () => mq.removeEventListener("change", resolveAndDraw);
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      configRef.current = resolveRenderConfig(root);
      sizeRef.current = { width: rect.width, height: rect.height };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawEffect();
    };

    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(root);
    resizeCanvas();

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    drawEffect();
    updateAriaEffect(true);
    startLoopEffect();
    const unsubscribe = source.subscribe(() => {
      if (source.getIsPlaying()) {
        startLoopEffect();
        return;
      }
      drawEffect();
      updateAriaEffect(true);
    });
    return () => {
      unsubscribe();
      stopLoopEffect();
    };
  }, [source]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    isDraggingRef.current = true;
    scrubTargetRef.current = 1;
    lastFrameTimeRef.current = performance.now();
    lastSeekTimeRef.current = null;
    actions.seekStart();
    seekFromClientX(event.clientX);
    startLoop();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    seekFromClientX(event.clientX);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
    isDraggingRef.current = false;
    scrubTargetRef.current = 0;
    lastFrameTimeRef.current = performance.now();
    lastSeekTimeRef.current = null;
    actions.seekEnd();
    draw();
    updateAria(true);
  };

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    const duration = source.getDuration();
    const smallStep = 1,
      largeStep = 10;

    switch (event.key) {
      case " ":
        event.preventDefault();
        await actions.togglePlayback();
        draw();
        startLoop();
        break;
      case ".":
        event.preventDefault();
        actions.seek(source.getAdjacentFrameTime(1));
        draw();
        updateAria(true);
        break;
      case ",":
        event.preventDefault();
        actions.seek(source.getAdjacentFrameTime(-1));
        draw();
        updateAria(true);
        break;
      case "ArrowRight":
      case "ArrowUp":
        event.preventDefault();
        actions.seekRelative(event.shiftKey ? largeStep : smallStep);
        draw();
        updateAria(true);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        event.preventDefault();
        actions.seekRelative(event.shiftKey ? -largeStep : -smallStep);
        draw();
        updateAria(true);
        break;
      case "PageUp":
        event.preventDefault();
        actions.seekRelative(largeStep);
        draw();
        updateAria(true);
        break;
      case "PageDown":
        event.preventDefault();
        actions.seekRelative(-largeStep);
        draw();
        updateAria(true);
        break;
      case "Home":
        event.preventDefault();
        actions.seek(0);
        draw();
        updateAria(true);
        break;
      case "End":
        event.preventDefault();
        if (duration > 0) actions.seek(duration);
        draw();
        updateAria(true);
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className="media-progress-root media-progress-root--canvas"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={0}
      aria-valuenow={0}
      aria-valuetext="0:00 of 0:00"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerEnter={() => {
        isHoveredRef.current = true;
        draw();
      }}
      onPointerLeave={() => {
        isHoveredRef.current = false;
        draw();
      }}
      onFocus={() => {
        isFocusedRef.current = true;
        draw();
      }}
      onBlur={() => {
        isFocusedRef.current = false;
        draw();
      }}
      onKeyDown={handleKeyDown}
    >
      <canvas ref={canvasRef} className="media-progress-canvas" />
    </div>
  );
}
