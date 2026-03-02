import { useRef, useState, useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { MAX_CHROMA } from "#lib/color-utils.ts";
import { useColorPicker, useRegisterElement } from "./use-color-picker";
import { colorAreaGpu } from "./color-area-gpu";

const CANVAS_W = 160;
const CANVAS_H = 100;

export function ColorArea() {
  const {
    state: { oklch },
    actions: { setOklch, startInteraction, endInteraction },
  } = useColorPicker();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const cachedRect = useRef<DOMRect | null>(null);

  // Register elements for imperative scrubbing updates
  useRegisterElement("area", containerRef);
  useRegisterElement("area-canvas", canvasRef);

  // Prevent drawer's drag-to-dismiss from capturing touch events during area interaction
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (isDragging) e.stopPropagation();
    };
    const stopStart = (e: TouchEvent) => e.stopPropagation();
    el.addEventListener("touchstart", stopStart, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    return () => {
      el.removeEventListener("touchstart", stopStart);
      el.removeEventListener("touchmove", stop);
    };
  }, [isDragging]);

  // Render canvas via GPU when hue changes (non-scrubbing renders)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const render = () => {
      if (colorAreaGpu.init()) {
        colorAreaGpu.render(canvas, oklch.h);
      }
    };

    // Render immediately (works when canvas is already visible, e.g. desktop popover)
    render();

    // Re-render when canvas enters viewport (handles drawer slide-in animation on mobile,
    // where the initial render's WebGPU texture may not composite correctly)
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) render();
      },
      { threshold: 0.01 },
    );
    observer.observe(canvas);

    return () => observer.disconnect();
  }, [oklch.h]);

  const updateFromPointer = (clientX: number, clientY: number) => {
    const rect = cachedRect.current;
    if (!rect) return;
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    setOklch({ l: 1 - y, c: x * MAX_CHROMA, h: oklch.h, a: oklch.a });
  };

  const handlePointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    containerRef.current?.focus();
    setIsDragging(true);
    cachedRect.current = containerRef.current?.getBoundingClientRect() ?? null;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    startInteraction();
    updateFromPointer(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: ReactPointerEvent) => {
    if (!isDragging) return;
    updateFromPointer(e.clientX, e.clientY);
  };

  const handlePointerUp = (e: ReactPointerEvent) => {
    if (!isDragging) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    endInteraction();
    cachedRect.current = null;
    setIsDragging(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        setOklch({ ...oklch, l: Math.min(1, oklch.l + step) });
        break;
      case "ArrowDown":
        e.preventDefault();
        setOklch({ ...oklch, l: Math.max(0, oklch.l - step) });
        break;
      case "ArrowRight":
        e.preventDefault();
        setOklch({ ...oklch, c: Math.min(MAX_CHROMA, oklch.c + step * MAX_CHROMA) });
        break;
      case "ArrowLeft":
        e.preventDefault();
        setOklch({ ...oklch, c: Math.max(0, oklch.c - step * MAX_CHROMA) });
        break;
    }
  };

  const thumbX = Math.min(1, oklch.c / MAX_CHROMA);
  const thumbY = 1 - oklch.l;

  return (
    <div
      ref={containerRef}
      className="color-area"
      role="application"
      aria-roledescription="2D color picker"
      aria-label="Color area: drag to set lightness and chroma"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={handleKeyDown}
      data-active={isDragging || undefined}
      style={{ "--x": String(thumbX), "--y": String(thumbY) } as React.CSSProperties}
    >
      <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} className="color-area__canvas" />
      <div className="color-area__thumb" />
    </div>
  );
}
