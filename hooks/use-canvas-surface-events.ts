import { isUserTypingInInput } from "#context/keybind-context.ts";
import { useCanvasInteraction } from "#context/use-canvas.ts";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";

interface UseCanvasSurfaceEventsOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  isMobile: boolean;
  isReady: boolean;
  onSpaceTap: (event: KeyboardEvent) => void | Promise<void>;
}

export function useCanvasSurfaceEvents({
  canvasRef,
  containerRef,
  isMobile,
  isReady,
  onSpaceTap,
}: UseCanvasSurfaceEventsOptions) {
  const interaction = useCanvasInteraction();
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const isMetaHeldRef = useRef(false);
  const touchPointsRef = useRef<{ x: number; y: number }[]>([]);
  const initializedRef = useRef(false);
  const handleSpaceTap = useEffectEvent(onSpaceTap);

  const getTouchPoints = (touches: React.TouchList) => {
    const points = touchPointsRef.current;
    points.length = touches.length;
    for (let index = 0; index < touches.length; index++) {
      const touch = touches[index]!;
      const point = points[index];
      if (point) {
        point.x = touch.clientX;
        point.y = touch.clientY;
      } else {
        points[index] = { x: touch.clientX, y: touch.clientY };
      }
    }
    return points;
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === "touch") return;
    containerRef.current?.focus();
    const dragSelecting = interaction.pointerDown(
      { x: event.clientX, y: event.clientY },
      event.shiftKey,
    );
    if (event.button === 0 && dragSelecting) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (event.pointerType === "touch") return;
    interaction.pointerMove({ x: event.clientX, y: event.clientY });
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    if (event.pointerType === "touch") return;
    interaction.pointerUp({ x: event.clientX, y: event.clientY });
  };

  const handleTouchStart = (event: React.TouchEvent) => {
    containerRef.current?.focus();
    interaction.touchStart(getTouchPoints(event.touches), event.timeStamp);
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    interaction.touchMove(getTouchPoints(event.touches), event.timeStamp);
  };

  const handleTouchEnd = (event: React.TouchEvent) => {
    interaction.touchEnd(getTouchPoints(event.touches), false, event.timeStamp);
  };

  const handleTouchCancel = (event: React.TouchEvent) => {
    interaction.touchEnd(getTouchPoints(event.touches), true, event.timeStamp);
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (!isMobile) interaction.openContextMenu({ x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      interaction.wheel(
        event.deltaX,
        event.deltaY,
        { x: event.clientX, y: event.clientY },
        event.ctrlKey || isMetaHeldRef.current,
      );
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [canvasRef, interaction, isReady]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Meta") isMetaHeldRef.current = true;
      if (event.key !== " " || event.repeat || isUserTypingInInput()) return;
      interaction.beginSpacePan();
      setIsSpaceHeld(true);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Meta") isMetaHeldRef.current = false;
      if (event.key !== " ") return;
      const wasReady = interaction.endSpacePan();
      setIsSpaceHeld(false);
      if (!isUserTypingInInput() && wasReady) void handleSpaceTap(event);
    };

    const onBlur = () => {
      isMetaHeldRef.current = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [interaction]);

  useEffect(() => {
    if (initializedRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    initializedRef.current = true;
    interaction.initializeViewport({
      width: container.clientWidth,
      height: container.clientHeight,
      dpr: window.devicePixelRatio,
    });
  }, [containerRef, interaction]);

  return {
    isSpaceHeld,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
    handleContextMenu,
    handleContextMenuOpenChange: (open: boolean) => {
      if (!open) interaction.closeContextMenu();
    },
  };
}
