// oxlint-disable react/only-export-components -- compound component: sub-components are internal, only the namespace object is exported
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { config } from "#config";
import { actionLayerController } from "#engine";
import { useActionLayer } from "#hooks/use-action-layer.ts";
import "./action-layer.css";

// ============================================================================
// Types
// ============================================================================

interface RegisteredItem {
  label: string;
  onAction: () => void;
  icon: ReactNode;
}

interface ActionLayerContextValue {
  register: (item: RegisteredItem) => () => void;
}

// ============================================================================
// Context
// ============================================================================

const ActionLayerContext = createContext<ActionLayerContextValue | null>(null);

function useActionLayerContext() {
  const ctx = useContext(ActionLayerContext);
  if (!ctx) throw new Error("ActionLayer.Item must be used within ActionLayer.Root");
  return ctx;
}

// ============================================================================
// Layout Helpers
// ============================================================================

interface RingPosition {
  x: number;
  y: number;
}

/**
 * Compute ring positions for N buttons.
 * Order: top-center, then alternating left/right.
 */
function computeRingPositions(count: number, radius: number): RingPosition[] {
  if (count === 0) return [];
  const positions: RingPosition[] = [];
  const spread = Math.PI / (count + 1);

  for (let i = 0; i < count; i++) {
    let angle: number;
    if (i === 0) {
      angle = -Math.PI / 2;
    } else {
      const offset = Math.ceil(i / 2);
      const side = i % 2 === 1 ? -1 : 1;
      angle = -Math.PI / 2 + side * offset * spread;
    }
    positions.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }
  return positions;
}

function clampRingCenter(cx: number, cy: number): { x: number; y: number } {
  const { edgeInset, buttonRingRadius, buttonSize } = config.actionLayer;
  // Margin accounts for full ring extent: radius + half button + inset
  const margin = buttonRingRadius + buttonSize / 2 + edgeInset;
  return {
    x: Math.max(margin, Math.min(window.innerWidth - margin, cx)),
    y: Math.max(margin, Math.min(window.innerHeight - margin, cy)),
  };
}

// ============================================================================
// ActionLayer.Root
// ============================================================================

function Root({ children }: PropsWithChildren) {
  const { active, touchOrigin: storeTouchOrigin } = useActionLayer();
  const [items, setItems] = useState<RegisteredItem[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const hoveredIndexRef = useRef<number | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [tooltipLabel, setTooltipLabel] = useState<string | null>(null);

  const register = useCallback((item: RegisteredItem) => {
    setItems((prev) => [...prev, item]);
    return () => {
      setItems((prev) => prev.filter((i) => i !== item));
    };
  }, []);

  // Compute ring layout from reactive store state (not singleton reads)
  const ringLayout = (() => {
    if (!active) return null;

    const { buttonRingRadius, fingerClearanceOffset } = config.actionLayer;

    const rawCenter = {
      x: storeTouchOrigin.x,
      y: storeTouchOrigin.y - fingerClearanceOffset,
    };
    const center = clampRingCenter(rawCenter.x, rawCenter.y);
    const positions = computeRingPositions(items.length, buttonRingRadius);

    return { center, positions, touchOrigin: storeTouchOrigin };
  })();

  // Reset hover state when deactivating
  useEffect(() => {
    if (!active) {
      // Use queueMicrotask to avoid sync setState-in-effect lint error
      queueMicrotask(() => {
        hoveredIndexRef.current = null;
        setHoveredIndex(null);
        setTooltipLabel(null);
      });
    }
  }, [active]);

  // Touch event handlers
  useEffect(() => {
    if (!active || !ringLayout) return;

    const { safeZoneRadius, buttonSize, buttonHitPadding, ringFollowFactor, deadzone } =
      config.actionLayer;
    const touchOrigin = ringLayout.touchOrigin;
    const hitRadius = buttonSize / 2 + buttonHitPadding;
    const { center, positions } = ringLayout;

    const getHoveredButton = (touchX: number, touchY: number): number | null => {
      const entityOffset = actionLayerController.getEntityOffset();
      const ringCenterX = center.x + entityOffset.x * ringFollowFactor;
      const ringCenterY = center.y + entityOffset.y * ringFollowFactor;

      for (let i = 0; i < items.length && i < positions.length; i++) {
        const pos = positions[i]!;
        const btnX = ringCenterX + pos.x;
        const btnY = ringCenterY + pos.y;
        const dx = touchX - btnX;
        const dy = touchY - btnY;
        if (Math.sqrt(dx * dx + dy * dy) <= hitRadius) {
          return i;
        }
      }
      return null;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;

      // Update ring container position to follow finger (via ring follow factor)
      const entityOffset = actionLayerController.getEntityOffset();
      const ringOffsetX = entityOffset.x * ringFollowFactor;
      const ringOffsetY = entityOffset.y * ringFollowFactor;
      const ring = ringRef.current;
      if (ring) {
        ring.style.left = `${center.x + ringOffsetX}px`;
        ring.style.top = `${center.y + ringOffsetY}px`;
      }
      const refs = buttonRefs.current;

      const newHovered = getHoveredButton(touch.clientX, touch.clientY);
      if (newHovered !== hoveredIndexRef.current) {
        hoveredIndexRef.current = newHovered;
        setHoveredIndex(newHovered);
        setTooltipLabel(newHovered !== null ? (items[newHovered]?.label ?? null) : null);

        // Direct DOM updates for button hover state (avoid re-render)
        for (let i = 0; i < refs.length; i++) {
          const btn = refs[i];
          if (!btn) continue;
          if (i === newHovered) {
            btn.setAttribute("data-hovered", "");
          } else {
            btn.removeAttribute("data-hovered");
          }
        }
      }

      // Safe zone progress (deadzone-aware)
      const dx = touch.clientX - touchOrigin.x;
      const dy = touch.clientY - touchOrigin.y;
      const distFromOrigin = Math.sqrt(dx * dx + dy * dy);
      const effectiveDist = Math.max(0, distFromOrigin - deadzone);
      const effectiveRadius = safeZoneRadius - deadzone;
      const progress = Math.min(1, effectiveDist / effectiveRadius);

      actionLayerController.updateSafeZoneProgress(progress);

      const overlay = overlayRef.current;
      if (overlay) {
        overlay.style.setProperty("--safe-zone-progress", String(progress));
      }
    };

    const handleTouchEnd = () => {
      // Debug mode: keep overlay open after release for DOM inspection
      if (config.actionLayer.debug === "stay") return;

      // Fire button action if finger was on one
      const hovered = hoveredIndexRef.current;
      if (hovered !== null) {
        items[hovered]?.onAction();
        // Cancel immediately so entities return to normal render order on the next frame.
        // The game loop's dismiss() (bubble phase) becomes a no-op since phase is already idle.
        actionLayerController.cancel();
      }
      // When no action was fired, dismiss + setActionLayerActive(false) is handled by
      // the game loop's handleTouchEnd (bubble phase), which animates blur fade-out
      // and entity spring-back.
    };

    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { capture: true });

    return () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd, { capture: true });
    };
  }, [active, ringLayout, items]);

  const contextValue: ActionLayerContextValue = { register };

  return (
    <ActionLayerContext.Provider value={contextValue}>
      {children}
      {active &&
        ringLayout &&
        createPortal(
          <ActionLayerOverlay
            ref={overlayRef}
            ringRef={ringRef}
            buttonRefs={buttonRefs}
            items={items}
            ringLayout={ringLayout}
            hoveredIndex={hoveredIndex}
            tooltipLabel={tooltipLabel}
          />,
          document.body,
        )}
    </ActionLayerContext.Provider>
  );
}

// ============================================================================
// ActionLayer Overlay (rendered via portal)
// ============================================================================

interface OverlayProps {
  items: RegisteredItem[];
  ringLayout: {
    center: { x: number; y: number };
    positions: RingPosition[];
    touchOrigin: { x: number; y: number };
  };
  hoveredIndex: number | null;
  tooltipLabel: string | null;
  ringRef: React.RefObject<HTMLDivElement | null>;
  buttonRefs: React.RefObject<(HTMLButtonElement | null)[]>;
}

function ActionLayerOverlayInner(
  { items, ringLayout, hoveredIndex, tooltipLabel, ringRef, buttonRefs }: OverlayProps,
  ref: React.ForwardedRef<HTMLDivElement>,
) {
  const { center, positions } = ringLayout;

  return (
    <div ref={ref} className="action-layer-overlay" data-active="">
      <div
        ref={ringRef}
        className="action-layer-ring"
        style={{ left: `${center.x}px`, top: `${center.y}px` }}
      >
        {items.map((item, i) => {
          const pos = positions[i];
          if (!pos) return null;
          return (
            <button
              key={item.label}
              ref={(el) => {
                buttonRefs.current[i] = el;
              }}
              className="action-layer-button"
              data-hovered={hoveredIndex === i ? "" : undefined}
              style={{
                left: `${pos.x}px`,
                top: `${pos.y}px`,
              }}
              aria-label={item.label}
            >
              {item.icon}
            </button>
          );
        })}
      </div>

      {tooltipLabel && (
        <div className="action-layer-tooltip" data-visible="">
          {tooltipLabel}
        </div>
      )}

      {config.actionLayer.debug && (
        <DebugOverlaySvg center={center} touchOrigin={ringLayout.touchOrigin} />
      )}
    </div>
  );
}

// Use forwardRef for the overlay ref
import { forwardRef } from "react";
const ActionLayerOverlay = forwardRef(ActionLayerOverlayInner);

// ============================================================================
// ActionLayer.Item
// ============================================================================

interface ItemProps {
  onAction: () => void;
  label: string;
  children: ReactNode;
}

function Item({ onAction, label, children }: ItemProps) {
  const { register } = useActionLayerContext();

  useEffect(() => {
    return register({ label, onAction, icon: children });
  }, [register, label, onAction, children]);

  return null;
}

// ============================================================================
// ActionLayer.Tooltip
// ============================================================================

function Tooltip() {
  return null; // Rendered by Root
}

// ============================================================================
// Debug Overlay
// ============================================================================

function DebugOverlaySvg({
  center,
  touchOrigin,
}: {
  center: { x: number; y: number };
  touchOrigin: { x: number; y: number };
}) {
  const { safeZoneRadius, buttonRingRadius, buttonSize, buttonHitPadding, deadzone } =
    config.actionLayer;

  return (
    <svg className="action-layer-debug" viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}>
      <circle
        cx={touchOrigin.x}
        cy={touchOrigin.y}
        r={safeZoneRadius}
        fill="none"
        stroke="rgba(255,0,0,0.3)"
        strokeWidth={2}
        strokeDasharray="8 4"
      />
      <circle
        cx={touchOrigin.x}
        cy={touchOrigin.y}
        r={deadzone}
        fill="rgba(255,165,0,0.08)"
        stroke="rgba(255,165,0,0.4)"
        strokeWidth={2}
      />
      <circle
        cx={center.x}
        cy={center.y}
        r={buttonRingRadius}
        fill="none"
        stroke="rgba(0,255,0,0.3)"
        strokeWidth={1}
      />
      <circle cx={touchOrigin.x} cy={touchOrigin.y} r={4} fill="rgba(255,0,0,0.5)" />
      <circle cx={center.x} cy={center.y} r={4} fill="rgba(0,255,0,0.5)" />
      {computeRingPositions(5, buttonRingRadius).map((pos, i) => (
        <circle
          key={i}
          cx={center.x + pos.x}
          cy={center.y + pos.y}
          r={buttonSize / 2 + buttonHitPadding}
          fill="none"
          stroke="rgba(0,0,255,0.2)"
          strokeWidth={1}
        />
      ))}
      <text x={10} y={20} fill="red" fontSize={12} fontFamily="monospace">
        {`origin: (${touchOrigin.x.toFixed(0)}, ${touchOrigin.y.toFixed(0)})`}
      </text>
      <text x={10} y={36} fill="lime" fontSize={12} fontFamily="monospace">
        {`center: (${center.x.toFixed(0)}, ${center.y.toFixed(0)})`}
      </text>
      <text x={10} y={52} fill="orange" fontSize={12} fontFamily="monospace">
        {`deadzone: ${deadzone}px`}
      </text>
      <text x={10} y={68} fill="cyan" fontSize={12} fontFamily="monospace">
        {`viewport: ${window.innerWidth}×${window.innerHeight}`}
      </text>
    </svg>
  );
}

function DebugOverlay() {
  return null; // Rendered conditionally inside Root
}

// ============================================================================
// Export
// ============================================================================

export const ActionLayer = {
  Root,
  Item,
  Tooltip,
  DebugOverlay,
};
