import {
  useCanvasCommands,
  useCanvasInteraction,
  useCanvasSelector,
  useViewport,
} from "#context/use-canvas.ts";
import { getRotatedAABB } from "#lib/canvas-math.ts";
import { config } from "#lib/config/index.ts";
import { useRef } from "react";

const MINIMAP_CIRCLE_FIT_PADDING = 1.04;

function getCircleSafeMinimapSquareSize({
  minX,
  minY,
  maxX,
  maxY,
  centerX,
  centerY,
}: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
}): number {
  const maxCornerDistance = Math.max(
    Math.hypot(minX - centerX, minY - centerY),
    Math.hypot(maxX - centerX, minY - centerY),
    Math.hypot(maxX - centerX, maxY - centerY),
    Math.hypot(minX - centerX, maxY - centerY),
  );
  return maxCornerDistance * 2 * MINIMAP_CIRCLE_FIT_PADDING;
}

export function MinimapControl({
  containerRef,
  onZoomReset,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onZoomReset: () => void;
}) {
  const viewport = useViewport();
  const { setViewport } = useCanvasCommands();
  const interaction = useCanvasInteraction();
  const entities = useCanvasSelector((state) => state.entities);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startViewport: typeof viewport;
    startCenter: { x: number; y: number };
    worldSize: { width: number; height: number };
    dragging: boolean;
  } | null>(null);
  const width = config.canvas.minimap.width;
  const height = config.canvas.minimap.height;
  const borderRadius = config.canvas.minimap.borderRadius;
  const margin = config.canvas.minimap.margin;

  const getMinimapWorldSize = (currentViewport: typeof viewport) => {
    const container = containerRef.current;
    if (!container) return null;

    const dpr = window.devicePixelRatio;
    const viewportRect = {
      x: currentViewport.offset.x,
      y: currentViewport.offset.y,
      width: (container.clientWidth * dpr) / currentViewport.zoom,
      height: (container.clientHeight * dpr) / currentViewport.zoom,
    };

    let minX = viewportRect.x;
    let minY = viewportRect.y;
    let maxX = viewportRect.x + viewportRect.width;
    let maxY = viewportRect.y + viewportRect.height;

    for (const entity of entities.values()) {
      const bounds = getRotatedAABB(entity.position, entity.size, entity.rotation);
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }

    const worldWidth = Math.max(maxX - minX, 1);
    const worldHeight = Math.max(maxY - minY, 1);
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const aspect =
      Math.max(config.canvas.minimap.width, 1) / Math.max(config.canvas.minimap.height, 1);
    const paddingScale = Math.max(config.canvas.minimap.worldPaddingScale, 1);
    let mapWorldWidth = worldWidth * paddingScale;
    let mapWorldHeight = worldHeight * paddingScale;
    if (mapWorldWidth / mapWorldHeight > aspect) {
      mapWorldHeight = mapWorldWidth / aspect;
    } else {
      mapWorldWidth = mapWorldHeight * aspect;
    }

    const isCircle =
      Math.abs(config.canvas.minimap.width - config.canvas.minimap.height) < 0.001 &&
      config.canvas.minimap.borderRadius >=
        Math.min(config.canvas.minimap.width, config.canvas.minimap.height) * 0.5;
    if (isCircle) {
      const circleSafeSize = getCircleSafeMinimapSquareSize({
        minX,
        minY,
        maxX,
        maxY,
        centerX,
        centerY,
      });
      mapWorldWidth = Math.max(mapWorldWidth, circleSafeSize);
      mapWorldHeight = Math.max(mapWorldHeight, circleSafeSize);
    }

    return { width: mapWorldWidth, height: mapWorldHeight };
  };

  const moveViewportByMinimapDrag = (
    clientX: number,
    clientY: number,
    element: HTMLElement,
    dragState: NonNullable<typeof dragStateRef.current>,
  ) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = element.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    const sensitivity = config.canvas.minimap.dragSensitivity;
    const worldDelta = {
      x: ((clientX - dragState.startX) / rect.width) * dragState.worldSize.width * sensitivity,
      y: ((clientY - dragState.startY) / rect.height) * dragState.worldSize.height * sensitivity,
    };
    const targetCenter = {
      x: dragState.startCenter.x + worldDelta.x,
      y: dragState.startCenter.y + worldDelta.y,
    };

    setViewport({
      offset: {
        x: targetCenter.x - (container.clientWidth * dpr) / (2 * dragState.startViewport.zoom),
        y: targetCenter.y - (container.clientHeight * dpr) / (2 * dragState.startViewport.zoom),
      },
      zoom: dragState.startViewport.zoom,
    });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;

    const startViewport = viewport;
    const worldSize = getMinimapWorldSize(startViewport);
    if (!worldSize) return;

    e.preventDefault();
    containerRef.current?.focus();
    interaction.stopViewportMotion();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startViewport,
      startCenter: {
        x:
          startViewport.offset.x +
          (container.clientWidth * window.devicePixelRatio) / (2 * startViewport.zoom),
        y:
          startViewport.offset.y +
          (container.clientHeight * window.devicePixelRatio) / (2 * startViewport.zoom),
      },
      worldSize,
      dragging: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;

    const moved = Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY);
    if (moved < 4 && !dragState.dragging) return;

    dragState.dragging = true;
    moveViewportByMinimapDrag(e.clientX, e.clientY, e.currentTarget, dragState);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;

    dragStateRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (!dragState.dragging) {
      onZoomReset();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onZoomReset();
  };

  return (
    <button
      className="infinite-canvas__minimap-control"
      type="button"
      aria-label={`Minimap. Current zoom ${Math.round(viewport.zoom * 100)}%. Click to reset zoom, drag to move viewport.`}
      title="Click to reset zoom to 100%. Drag to move around."
      style={{
        width,
        height,
        borderRadius,
        right: margin,
        bottom: margin,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    />
  );
}
