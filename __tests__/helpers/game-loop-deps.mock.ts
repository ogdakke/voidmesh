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
      cancel: vi.fn<() => void>(),
      animateTo: vi.fn<() => void>(),
      setContainer: vi.fn<() => void>(),
    },
    actionLayer: {
      activate: vi.fn<() => void>(),
      dismiss: vi.fn<() => void>(),
      cancel: vi.fn<() => void>(),
      updateFingerPosition: vi.fn<() => void>(),
      transitionToDrag: vi.fn<() => void>(),
      isActive: vi.fn<() => boolean>(() => false),
      isInteractive: vi.fn<() => boolean>(() => false),
      getEntityOffset: vi.fn<() => { x: number; y: number }>(() => ({ x: 0, y: 0 })),
      getTouchOrigin: vi.fn<() => { x: number; y: number }>(() => ({ x: 0, y: 0 })),
      getBlurIntensity: vi.fn<() => number>(() => 0),
      hasEntity: vi.fn<() => boolean>(() => false),
      updateSafeZoneProgress: vi.fn<() => void>(),
    },
    dragVisual: {
      startPossibleDrag: vi.fn<() => void>(),
      activateDrag: vi.fn<() => void>(),
      release: vi.fn<() => void>(),
      cancel: vi.fn<() => void>(),
      isDragPhase: vi.fn<() => boolean>(() => false),
      isActive: vi.fn<() => boolean>(() => false),
      getScale: vi.fn<() => number>(() => 1),
    },
    label: {
      setContainer: vi.fn<() => void>(),
      setLabelElement: vi.fn<() => void>(),
      setTextElement: vi.fn<() => void>(),
      tick: vi.fn<() => void>(),
    },
    perf: {
      setElement: vi.fn<() => void>(),
      tick: vi.fn<() => void>(),
    },
    haptic: vi.fn<() => void>(),
    analytics: { track: vi.fn<() => void>() },
  } as unknown as GameLoopDeps;
}
