import {
  createContext,
  use,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import "./mobile-bottom-bar.css";
import clsx from "clsx";
import { Enlarge, Reduce } from "iconoir-react";
import { useLayout } from "#context/use-layout.ts";
import { useCanvasPreferences } from "#context/use-canvas.ts";
import { haptic } from "#lib/haptic.ts";
import {
  BOTTOM_BAR_DRAG_THRESHOLD_PX,
  getBottomBarCellAt,
  getBottomBarPillOffset,
} from "./mobile-bottom-bar.lib.ts";

interface BottomBarDragState {
  pointerId: number;
  vertical: boolean;
  /** Pointer position on the drag axis at press. */
  origin: number;
  /** Viewport position of the first cell on the drag axis. */
  firstCellStart: number;
  cellStarts: number[];
  cellSize: number;
  items: HTMLButtonElement[];
  dragging: boolean;
  target: number;
}

/**
 * Drag the selection pill across the bar: pressing lifts it, moving past a small threshold
 * makes it follow the finger (the cell under it lights up, with a haptic tick per cell), and
 * only releasing selects. Plain taps keep their normal click behaviour, because the pointer is
 * only captured once a drag starts.
 */
function useBottomBarDrag(haptics: boolean) {
  const dragRef = useRef<BottomBarDragState | null>(null);

  const finish = (bar: HTMLElement) => {
    const state = dragRef.current;
    dragRef.current = null;
    delete bar.dataset.pressed;
    delete bar.dataset.dragging;
    bar.style.removeProperty("--drag-offset");
    for (const item of state?.items ?? []) delete item.dataset.dragTarget;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const bar = event.currentTarget;
    // In fullscreen the pill rests on the toggle and the tabs are hidden.
    if (bar.querySelector(":scope > .mobile-fullscreen-btn[data-active]")) return;
    const items = Array.from(bar.querySelectorAll<HTMLButtonElement>(":scope > .bottom-bar-item"));
    if (!items.some((item) => item.getAttribute("aria-disabled") !== "true")) return;

    const vertical = bar.closest('[data-orientation="landscape"]') !== null;
    const rects = items.map((item) => item.getBoundingClientRect());
    const firstCellStart = vertical ? rects[0]!.top : rects[0]!.left;
    dragRef.current = {
      pointerId: event.pointerId,
      vertical,
      origin: vertical ? event.clientY : event.clientX,
      firstCellStart,
      cellStarts: rects.map((rect) => (vertical ? rect.top : rect.left) - firstCellStart),
      cellSize: vertical ? rects[0]!.height : rects[0]!.width,
      items,
      dragging: false,
      target: -1,
    };
    bar.dataset.pressed = "";
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (!state || event.pointerId !== state.pointerId) return;
    const bar = event.currentTarget;
    const position = state.vertical ? event.clientY : event.clientX;

    if (!state.dragging) {
      if (Math.abs(position - state.origin) < BOTTOM_BAR_DRAG_THRESHOLD_PX) return;
      state.dragging = true;
      bar.setPointerCapture(event.pointerId);
      bar.dataset.dragging = "";
    }

    const offset = getBottomBarPillOffset(
      position - state.firstCellStart,
      state.cellStarts,
      state.cellSize,
    );
    bar.style.setProperty("--drag-offset", `${offset}px`);

    const target = getBottomBarCellAt(offset, state.cellStarts);
    if (target === state.target) return;
    if (state.target !== -1) haptic({ wantsHaptic: haptics });
    state.items[state.target]?.removeAttribute("data-drag-target");
    state.items[target]?.setAttribute("data-drag-target", "");
    state.target = target;
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = dragRef.current;
    if (!state || event.pointerId !== state.pointerId) return;
    const bar = event.currentTarget;
    if (!state.dragging) {
      finish(bar);
      return;
    }

    const item = state.items[state.target];
    if (
      item &&
      item.getAttribute("aria-disabled") !== "true" &&
      !item.hasAttribute("data-active")
    ) {
      item.click();
    }
    // Release the pill a frame later, once the new selection has rendered, so it springs from
    // the finger straight to the chosen cell instead of starting back towards the old one.
    requestAnimationFrame(() => finish(bar));
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) finish(event.currentTarget);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

interface BottomBarContextValue<T extends string> {
  items: T[];
  activeItem: string | null;
  setActiveItem: (item: string | null) => void;
  onChange: (item: string | null) => void;
}

const BottomBarContext = createContext<BottomBarContextValue<string> | null>(null);
function useBottomBarContext<T extends string>() {
  const context = use(BottomBarContext);
  if (!context) {
    throw new Error("useBottomBarContext must be used within a BottomBarProvider");
  }

  return context as unknown as BottomBarContextValue<T>;
}

function BottomBarProvider<T extends string>({
  items,
  onChange,
  value,
  children,
}: PropsWithChildren<{
  items: readonly T[];
  onChange?: (item: string | null) => void;
  value?: string | null;
}>) {
  const [activeItem, setActiveItem] = useState<string | null>(value ?? null);

  const contextValue = {
    items,
    activeItem,
    setActiveItem,
    onChange,
  };

  return (
    <BottomBarContext.Provider value={contextValue as any}>{children}</BottomBarContext.Provider>
  );
}

function BottomBarRoot<T extends string>({
  items,
  children,
  onChange,
  value,
  trailing,
}: {
  items: readonly T[];
  children: ReactNode | ((items: readonly T[]) => ReactNode);
  onChange?: (item: string | null) => void;
  value?: string | null;
  /** Rendered as the last cell; the indicator can slide onto it via `data-active`. */
  trailing?: ReactNode;
}) {
  const { haptics } = useCanvasPreferences();
  const drag = useBottomBarDrag(haptics);
  return (
    <BottomBarProvider items={items} onChange={onChange} value={value}>
      <div className="mobile-bottom-bar" {...drag}>
        <span className="bottom-bar-indicator" aria-hidden />
        {typeof children === "function" ? children(items) : children}
        {trailing}
      </div>
    </BottomBarProvider>
  );
}

export function MobileBottomBar<T extends string>({
  items,
  children,
  onChange,
  value,
}: {
  items: readonly T[];
  children: ReactNode | ((items: readonly T[]) => ReactNode);
  onChange?: (item: string | null) => void;
  value: string | null;
  hideItems?: boolean;
}) {
  const { isFullscreen, toggleFullscreen } = useLayout();
  const { haptics } = useCanvasPreferences();
  return (
    <div className="mobile-bottom-bar-container">
      <BottomBarRoot
        items={items}
        onChange={onChange}
        value={value}
        trailing={
          <button
            className="mobile-fullscreen-btn icon-crossfade"
            data-active={isFullscreen ? true : undefined}
            onClick={() => {
              haptic({ wantsHaptic: haptics });
              toggleFullscreen();
            }}
            aria-label={`Toggle fullscreen ${isFullscreen ? "off" : "on"}`}
          >
            <Reduce className={isFullscreen ? "icon-visible" : "icon-hidden"} />
            <Enlarge className={isFullscreen ? "icon-hidden" : "icon-visible"} />
          </button>
        }
      >
        {typeof children === "function" ? children(items) : children}
      </BottomBarRoot>
    </div>
  );
}

export interface BottomBarItemProps extends ComponentProps<"button"> {
  label: string;
}

export function BottomBarItem({
  children,
  disabled,
  label,
  onClick,
  ...props
}: PropsWithChildren<BottomBarItemProps>) {
  const { activeItem, setActiveItem, onChange } = useBottomBarContext();
  return (
    <button
      {...props}
      className={clsx("bottom-bar-item", props.className)}
      value={label}
      data-active={activeItem === label ? true : undefined}
      aria-disabled={disabled}
      aria-label={label}
      onClick={(e) => {
        if (disabled) return;
        setActiveItem(label);
        onChange?.(label);
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
}
