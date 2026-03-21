import { vi } from "vitest";
import type { AnimationScheduler } from "#lib/animation-scheduler.ts";
import type { GameLoopDeps } from "../../engine/game-loop.ts";

/**
 * Create mock GameLoop dependencies for testing.
 * All side-effect controllers are stubbed with vi.fn() spies.
 * Pass a real AnimationScheduler to control animation timing.
 */
export function createMockGameLoopDeps(scheduler: AnimationScheduler): GameLoopDeps {
  return {
    scheduler,
    viewportAnimation: {
      cancel: vi.fn(),
      animateTo: vi.fn(),
      setContainer: vi.fn(),
    },
    actionLayer: {
      activate: vi.fn(),
      dismiss: vi.fn(),
      cancel: vi.fn(),
      updateFingerPosition: vi.fn(),
      transitionToDrag: vi.fn(),
      isActive: vi.fn(() => false),
      isInteractive: vi.fn(() => false),
      getEntityOffset: vi.fn(() => ({ x: 0, y: 0 })),
      getTouchOrigin: vi.fn(() => ({ x: 0, y: 0 })),
      getBlurIntensity: vi.fn(() => 0),
      hasEntity: vi.fn(() => false),
      updateSafeZoneProgress: vi.fn(),
    },
    dragVisual: {
      startPossibleDrag: vi.fn(),
      activateDrag: vi.fn(),
      release: vi.fn(),
      cancel: vi.fn(),
      isDragPhase: vi.fn(() => false),
      isActive: vi.fn(() => false),
      getScale: vi.fn(() => 1),
    },
    label: {
      setContainer: vi.fn(),
      setLabelElement: vi.fn(),
      setTextElement: vi.fn(),
      tick: vi.fn(),
    },
    perf: {
      setElement: vi.fn(),
      tick: vi.fn(),
    },
    haptic: vi.fn(),
    analytics: { track: vi.fn() },
  } as unknown as GameLoopDeps;
}
