// oxlint-disable react/only-export-components -- compound component: sub-components are internal, only the namespace object is exported
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { config } from "#config";
import { analytics } from "#lib/analytics.ts";
import { getCssVarPx } from "#lib/css.ts";
import { completeOnboardingStepFromEvent } from "#lib/onboarding-runtime.ts";
import { OnboardingStepId } from "#lib/onboarding.ts";
import { useCanvasInteraction } from "#context/use-canvas.ts";
import { useActionLayer } from "#hooks/use-action-layer.ts";
import "./action-layer.css";

// ============================================================================
// Types
// ============================================================================

interface RegisteredItem {
  label: string;
  onAction: () => void;
  icon: ReactNode;
  order: number;
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
 * Order: center of arc, then alternating left/right.
 * @param baseAngle - Center angle of the arc (default: -π/2 = upward)
 */
function computeRingPositions(
  count: number,
  radius: number,
  baseAngle: number = -Math.PI / 2,
): RingPosition[] {
  if (count === 0) return [];
  const positions: RingPosition[] = [];
  const spread = Math.PI / count;

  for (let i = 0; i < count; i++) {
    let angle: number;
    if (i === 0) {
      angle = baseAngle;
    } else {
      const offset = Math.ceil(i / 2);
      const side = i % 2 === 1 ? -1 : 1;
      angle = baseAngle + side * offset * spread;
    }
    positions.push({
      x: Math.round(Math.cos(angle) * radius * 100) / 100,
      y: Math.round(Math.sin(angle) * radius * 100) / 100,
    });
  }
  return positions;
}

/**
 * Compute the optimal arc base angle so all buttons stay within the safe area.
 * Returns -π/2 (upward) when buttons fit. Otherwise, binary-searches for the
 * minimum rotation from the default toward the center of available space —
 * just enough to bring all buttons in bounds without over-rotating.
 */
function computeArcAngle(cx: number, cy: number, count: number, radius: number): number {
  const { edgeInset, buttonSize } = config.actionLayer;
  const pad = buttonSize / 2 + edgeInset;

  const safeTop = getCssVarPx("--safe-area-top");
  const safeBottom = getCssVarPx("--safe-area-bottom");
  const safeLeft = getCssVarPx("--safe-area-left");
  const safeRight = getCssVarPx("--safe-area-right");

  const minX = pad + safeLeft;
  const maxX = window.innerWidth - pad - safeRight;
  const minY = pad + safeTop;
  const maxY = window.innerHeight - pad - safeBottom;

  const allFit = (baseAngle: number): boolean => {
    const positions = computeRingPositions(count, radius, baseAngle);
    return positions.every(
      (p) => cx + p.x >= minX && cx + p.x <= maxX && cy + p.y >= minY && cy + p.y <= maxY,
    );
  };

  const defaultAngle = -Math.PI / 2;
  if (allFit(defaultAngle)) return defaultAngle;

  // Target: angle toward center of safe rect (guaranteed to have most space)
  const safeCenterX = (minX + maxX) / 2;
  const safeCenterY = (minY + maxY) / 2;
  const targetAngle = Math.atan2(safeCenterY - cy, safeCenterX - cx);

  // Shortest angular path from default to target
  let diff = targetAngle - defaultAngle;
  if (diff > Math.PI) diff -= 2 * Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;

  // Binary search: find the minimum rotation (t ∈ [0,1]) where all buttons fit
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (allFit(defaultAngle + mid * diff)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return defaultAngle + hi * diff;
}

// ============================================================================
// ActionLayer.Root
// ============================================================================

function Root({ children }: PropsWithChildren) {
  const { active, touchOrigin: storeTouchOrigin } = useActionLayer();
  const interaction = useCanvasInteraction();
  const [items, setItems] = useState<RegisteredItem[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const hoveredIndexRef = useRef<number | null>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [tooltipLabel, setTooltipLabel] = useState<string | null>(null);

  const register = (item: RegisteredItem) => {
    setItems((prev) => [...prev, item].sort((a, b) => a.order - b.order));
    return () => {
      setItems((prev) => prev.filter((i) => i !== item));
    };
  };

  // Compute ring layout from reactive store state (not singleton reads).
  // Always computed — touchOrigin retains its last value when deactivated,
  // so the layout stays valid for exit animations.
  const { buttonRingRadius, fingerClearanceOffset } = config.actionLayer;
  const center = {
    x: storeTouchOrigin.x,
    y: storeTouchOrigin.y - fingerClearanceOffset,
  };
  const baseAngle = computeArcAngle(center.x, center.y, items.length, buttonRingRadius);
  const positions = computeRingPositions(items.length, buttonRingRadius, baseAngle);
  const ringLayout = { center, positions, touchOrigin: storeTouchOrigin };

  // Gate hover state by active — stale values from previous activation are harmless
  const effectiveHoveredIndex = active ? hoveredIndex : null;
  const effectiveTooltipLabel = active ? tooltipLabel : null;

  // Touch event handlers
  useEffect(() => {
    if (!active) return;

    // Reset ref from previous activation so a no-move touchend doesn't fire a stale action
    hoveredIndexRef.current = null;

    const { safeZoneRadius, buttonSize, buttonHitPadding, ringFollowFactor, deadzone } =
      config.actionLayer;
    const touchOrigin = storeTouchOrigin;
    const hitRadius = buttonSize / 2 + buttonHitPadding;

    const getHoveredButton = (touchX: number, touchY: number): number | null => {
      const entityOffset = interaction.getActionLayerEntityOffset();
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
      const entityOffset = interaction.getActionLayerEntityOffset();
      const ringOffsetX = entityOffset.x * ringFollowFactor;
      const ringOffsetY = entityOffset.y * ringFollowFactor;
      const ring = ringRef.current;
      if (ring) {
        ring.style.left = `${center.x + ringOffsetX}px`;
        ring.style.top = `${center.y + ringOffsetY}px`;
      }
      const newHovered = getHoveredButton(touch.clientX, touch.clientY);
      if (newHovered !== hoveredIndexRef.current) {
        hoveredIndexRef.current = newHovered;
        setHoveredIndex(newHovered);
        const label = newHovered !== null ? (items[newHovered]?.label ?? null) : null;
        setTooltipLabel(label);
        if (label) {
          completeOnboardingStepFromEvent(OnboardingStepId.hoverAction);
        }
      }

      // Safe zone progress (deadzone-aware)
      const dx = touch.clientX - touchOrigin.x;
      const dy = touch.clientY - touchOrigin.y;
      const distFromOrigin = Math.sqrt(dx * dx + dy * dy);
      const effectiveDist = Math.max(0, distFromOrigin - deadzone);
      const effectiveRadius = safeZoneRadius - deadzone;
      const progress = Math.min(1, effectiveDist / effectiveRadius);

      interaction.updateActionLayerSafeZone(progress);
    };

    const handleTouchEnd = () => {
      // Debug mode: keep overlay open after release for DOM inspection
      if (config.actionLayer.debug === "stay") return;

      // Fire button action if finger was on one
      const hovered = hoveredIndexRef.current;
      if (hovered !== null) {
        const item = items[hovered];
        if (item) {
          analytics.track("action_layer.button_selected", { button: item.label });
          completeOnboardingStepFromEvent(OnboardingStepId.hoverAction);
          item.onAction();
        }
        // Cancel immediately so entities return to normal render order on the next frame.
        // The game loop's dismiss() (bubble phase) becomes a no-op since phase is already idle.
        interaction.cancelActionLayer();
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
      // Clear hover state so next activation doesn't flash a stale button
      setHoveredIndex(null);
      setTooltipLabel(null);
    };
    // `center` and `positions` are derived from `storeTouchOrigin` (stable ref via
    // useSyncExternalStore) and frozen config. React Compiler memoizes them.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [active, center, positions, storeTouchOrigin, items, interaction]);

  const contextValue: ActionLayerContextValue = { register };

  return (
    <ActionLayerContext.Provider value={contextValue}>
      {children}
      {createPortal(
        <ActionLayerOverlay
          ringRef={ringRef}
          buttonRefs={buttonRefs}
          items={items}
          ringLayout={ringLayout}
          hoveredIndex={effectiveHoveredIndex}
          tooltipLabel={effectiveTooltipLabel}
          hidden={!active}
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
  hidden: boolean;
}

function ActionLayerOverlay({
  items,
  ringLayout,
  hoveredIndex,
  tooltipLabel,
  ringRef,
  buttonRefs,
  hidden,
}: OverlayProps) {
  const { center, positions } = ringLayout;

  return (
    <div className="action-layer-overlay" hidden={hidden || undefined}>
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
              style={
                {
                  left: `${pos.x}px`,
                  top: `${pos.y}px`,
                  "--_pos-x": `${pos.x}px`,
                  "--_pos-y": `${pos.y}px`,
                } as React.CSSProperties
              }
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
        <DebugOverlaySvg
          center={center}
          touchOrigin={ringLayout.touchOrigin}
          positions={ringLayout.positions}
        />
      )}
    </div>
  );
}

// ============================================================================
// ActionLayer.Item
// ============================================================================

interface ItemProps {
  onAction: () => void;
  label: string;
  /** Explicit sort order for deterministic ring layout (lower = first) */
  order?: number;
  children: ReactNode;
}

function Item({ onAction, label, order = 0, children }: ItemProps) {
  const { register } = useActionLayerContext();

  useEffect(() => {
    return register({ label, onAction, icon: children, order });
  }, [register, label, onAction, children, order]);

  return null;
}

// ============================================================================
// Debug Overlay
// ============================================================================

function DebugOverlaySvg({
  center,
  touchOrigin,
  positions,
}: {
  center: { x: number; y: number };
  touchOrigin: { x: number; y: number };
  positions: RingPosition[];
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
      {positions.map((pos, i) => (
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

// ============================================================================
// Export
// ============================================================================

export const ActionLayer = {
  Root,
  Item,
};
