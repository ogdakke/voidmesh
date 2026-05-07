/**
 * Tests for entity cycling functionality
 * Cycles through entities using ArrowUp/ArrowDown keys
 *
 * Uses insertion order (Map iteration order), NOT zIndex.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { canvasStore, viewportAnimation } from "#engine";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { createTestEntity, resetEntityCounter } from "../helpers/test-entity.ts";
import { assertSelectionEquals, assertSelectionCount } from "../helpers/assertions.ts";
import {
  getEntityCycleOrder,
  cycleToNextEntity,
  cycleToPreviousEntity,
  clearEntityCycleCache,
  isCyclingInProgress,
} from "#hooks/use-entity-cycling.ts";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
  resetEntityCounter();
  clearEntityCycleCache();
});

afterEach(() => {
  cleanup();
});

describe("getEntityCycleOrder", () => {
  test("returns empty array when no entities exist", () => {
    const order = getEntityCycleOrder();
    expect(order).toEqual([]);
  });

  test("returns entities in insertion order", () => {
    const e1 = createTestEntity({ id: "first" });
    const e2 = createTestEntity({ id: "second" });
    const e3 = createTestEntity({ id: "third" });
    canvasStore.addEntity(e1);
    canvasStore.addEntity(e2);
    canvasStore.addEntity(e3);

    const order = getEntityCycleOrder();
    expect(order).toEqual(["first", "second", "third"]);
  });

  test("is stable across multiple calls (cached)", () => {
    const e1 = createTestEntity({ id: "a" });
    const e2 = createTestEntity({ id: "b" });
    canvasStore.addEntity(e1);
    canvasStore.addEntity(e2);

    const order1 = getEntityCycleOrder();
    const order2 = getEntityCycleOrder();
    expect(order1).toBe(order2); // Same reference (cached)
  });

  test("invalidates cache when entities change", () => {
    const e1 = createTestEntity({ id: "a" });
    canvasStore.addEntity(e1);

    const order1 = getEntityCycleOrder();
    expect(order1).toEqual(["a"]);

    const e2 = createTestEntity({ id: "b" });
    canvasStore.addEntity(e2);

    const order2 = getEntityCycleOrder();
    expect(order2).toEqual(["a", "b"]);
    expect(order1).not.toBe(order2); // Different reference after invalidation
  });
});

describe("cycleToNextEntity (ArrowDown)", () => {
  describe("no entities", () => {
    test("does nothing when no entities exist", () => {
      cycleToNextEntity();
      assertSelectionCount(0);
    });
  });

  describe("no selection", () => {
    test("selects first entity when nothing selected", () => {
      const e1 = createTestEntity({ id: "first" });
      const e2 = createTestEntity({ id: "second" });
      canvasStore.addEntity(e1);
      canvasStore.addEntity(e2);

      cycleToNextEntity();
      assertSelectionEquals(["first"]);
    });
  });

  describe("single selection", () => {
    test("selects next entity in insertion order", () => {
      const e1 = createTestEntity({ id: "first" });
      const e2 = createTestEntity({ id: "second" });
      const e3 = createTestEntity({ id: "third" });
      canvasStore.addEntity(e1);
      canvasStore.addEntity(e2);
      canvasStore.addEntity(e3);
      canvasStore.replaceSelection(["first"]);

      cycleToNextEntity();
      assertSelectionEquals(["second"]);

      cycleToNextEntity();
      assertSelectionEquals(["third"]);
    });

    test("wraps from last to first entity", () => {
      const e1 = createTestEntity({ id: "first" });
      const e2 = createTestEntity({ id: "second" });
      canvasStore.addEntity(e1);
      canvasStore.addEntity(e2);
      canvasStore.replaceSelection(["second"]);

      cycleToNextEntity();
      assertSelectionEquals(["first"]); // Wrapped to first
    });
  });

  describe("multi-selection", () => {
    test("cycles from last-added entity in selection", () => {
      const e1 = createTestEntity({ id: "first" });
      const e2 = createTestEntity({ id: "second" });
      const e3 = createTestEntity({ id: "third" });
      canvasStore.addEntity(e1);
      canvasStore.addEntity(e2);
      canvasStore.addEntity(e3);
      canvasStore.replaceSelection(["first", "second"]); // Multi-select

      cycleToNextEntity();
      // Should cycle from "second" (last in insertion order among selected)
      assertSelectionEquals(["third"]);
    });
  });
});

describe("cycleToPreviousEntity (ArrowUp)", () => {
  describe("no entities", () => {
    test("does nothing when no entities exist", () => {
      cycleToPreviousEntity();
      assertSelectionCount(0);
    });
  });

  describe("no selection", () => {
    test("selects last entity when nothing selected", () => {
      const e1 = createTestEntity({ id: "first" });
      const e2 = createTestEntity({ id: "second" });
      canvasStore.addEntity(e1);
      canvasStore.addEntity(e2);

      cycleToPreviousEntity();
      assertSelectionEquals(["second"]); // Last in insertion order
    });
  });

  describe("single selection", () => {
    test("selects previous entity in insertion order", () => {
      const e1 = createTestEntity({ id: "first" });
      const e2 = createTestEntity({ id: "second" });
      const e3 = createTestEntity({ id: "third" });
      canvasStore.addEntity(e1);
      canvasStore.addEntity(e2);
      canvasStore.addEntity(e3);
      canvasStore.replaceSelection(["third"]);

      cycleToPreviousEntity();
      assertSelectionEquals(["second"]);

      cycleToPreviousEntity();
      assertSelectionEquals(["first"]);
    });

    test("wraps from first to last entity", () => {
      const e1 = createTestEntity({ id: "first" });
      const e2 = createTestEntity({ id: "second" });
      canvasStore.addEntity(e1);
      canvasStore.addEntity(e2);
      canvasStore.replaceSelection(["first"]);

      cycleToPreviousEntity();
      assertSelectionEquals(["second"]); // Wrapped to last
    });
  });

  describe("multi-selection", () => {
    test("cycles from first-added entity in selection", () => {
      const e1 = createTestEntity({ id: "first" });
      const e2 = createTestEntity({ id: "second" });
      const e3 = createTestEntity({ id: "third" });
      canvasStore.addEntity(e1);
      canvasStore.addEntity(e2);
      canvasStore.addEntity(e3);
      canvasStore.replaceSelection(["second", "third"]); // Multi-select

      cycleToPreviousEntity();
      // Should cycle from "second" (first in insertion order among selected)
      assertSelectionEquals(["first"]);
    });
  });
});

describe("animation", () => {
  test("calls viewportAnimation.animateTo when cycling", () => {
    const e1 = createTestEntity({
      id: "entity",
      position: { x: 1000, y: 1000 },
      size: { width: 200, height: 200 },
    });
    canvasStore.addEntity(e1);

    // Mock the container element that the cycling logic looks for
    const mockContainer = document.createElement("div");
    mockContainer.className = "infinite-canvas";
    Object.defineProperty(mockContainer, "clientWidth", { value: 800 });
    Object.defineProperty(mockContainer, "clientHeight", { value: 600 });
    document.body.appendChild(mockContainer);

    // Spy on viewportAnimation.animateTo
    let animateCalled = false;
    const originalAnimateTo = viewportAnimation.animateTo.bind(viewportAnimation);
    viewportAnimation.animateTo = () => {
      animateCalled = true;
    };

    cycleToNextEntity();

    expect(animateCalled).toBe(true);

    // Cleanup
    viewportAnimation.animateTo = originalAnimateTo;
    document.body.removeChild(mockContainer);
  });
});

describe("throttling", () => {
  test("held keys (repeat=true) are throttled while animation is in progress", () => {
    const e1 = createTestEntity({ id: "first" });
    const e2 = createTestEntity({ id: "second" });
    const e3 = createTestEntity({ id: "third" });
    canvasStore.addEntity(e1);
    canvasStore.addEntity(e2);
    canvasStore.addEntity(e3);

    // Mock the container
    const mockContainer = document.createElement("div");
    mockContainer.className = "infinite-canvas";
    Object.defineProperty(mockContainer, "clientWidth", { value: 800 });
    Object.defineProperty(mockContainer, "clientHeight", { value: 600 });
    document.body.appendChild(mockContainer);

    // Mock animateTo to NOT call onComplete (simulating animation in progress)
    const originalAnimateTo = viewportAnimation.animateTo.bind(viewportAnimation);
    viewportAnimation.animateTo = () => {
      // Don't call onComplete - animation stays "in progress"
    };

    // First cycle (fresh press, repeat=false)
    cycleToNextEntity(undefined, false);
    assertSelectionEquals(["first"]);
    expect(isCyclingInProgress()).toBe(true);

    // Held key (repeat=true) should be ignored while animating
    cycleToNextEntity(undefined, true);
    assertSelectionEquals(["first"]); // Still on first

    cycleToNextEntity(undefined, true);
    assertSelectionEquals(["first"]); // Still on first

    // Cleanup
    viewportAnimation.animateTo = originalAnimateTo;
    document.body.removeChild(mockContainer);
  });

  test("fresh presses (repeat=false) can interrupt animation", () => {
    const e1 = createTestEntity({ id: "first" });
    const e2 = createTestEntity({ id: "second" });
    const e3 = createTestEntity({ id: "third" });
    canvasStore.addEntity(e1);
    canvasStore.addEntity(e2);
    canvasStore.addEntity(e3);

    // Mock the container
    const mockContainer = document.createElement("div");
    mockContainer.className = "infinite-canvas";
    Object.defineProperty(mockContainer, "clientWidth", { value: 800 });
    Object.defineProperty(mockContainer, "clientHeight", { value: 600 });
    document.body.appendChild(mockContainer);

    // Mock animateTo to NOT call onComplete (simulating animation in progress)
    const originalAnimateTo = viewportAnimation.animateTo.bind(viewportAnimation);
    viewportAnimation.animateTo = () => {
      // Don't call onComplete - animation stays "in progress"
    };

    // First cycle (fresh press)
    cycleToNextEntity(undefined, false);
    assertSelectionEquals(["first"]);

    // Fresh press can interrupt - should cycle immediately
    cycleToNextEntity(undefined, false);
    assertSelectionEquals(["second"]);

    // Another fresh press
    cycleToNextEntity(undefined, false);
    assertSelectionEquals(["third"]);

    // Cleanup
    viewportAnimation.animateTo = originalAnimateTo;
    document.body.removeChild(mockContainer);
  });

  test("held keys work after animation completes", () => {
    const e1 = createTestEntity({ id: "first" });
    const e2 = createTestEntity({ id: "second" });
    const e3 = createTestEntity({ id: "third" });
    canvasStore.addEntity(e1);
    canvasStore.addEntity(e2);
    canvasStore.addEntity(e3);

    // Mock the container
    const mockContainer = document.createElement("div");
    mockContainer.className = "infinite-canvas";
    Object.defineProperty(mockContainer, "clientWidth", { value: 800 });
    Object.defineProperty(mockContainer, "clientHeight", { value: 600 });
    document.body.appendChild(mockContainer);

    // Capture onComplete callback
    let onCompleteCallback: (() => void) | undefined;
    const originalAnimateTo = viewportAnimation.animateTo.bind(viewportAnimation);
    viewportAnimation.animateTo = (_target, options) => {
      onCompleteCallback = options?.onComplete;
    };

    // First cycle (fresh press to start holding)
    cycleToNextEntity(undefined, false);
    assertSelectionEquals(["first"]);
    expect(isCyclingInProgress()).toBe(true);

    // Simulate animation complete
    onCompleteCallback?.();
    expect(isCyclingInProgress()).toBe(false);

    // Now held key should work
    cycleToNextEntity(undefined, true);
    assertSelectionEquals(["second"]);

    // Simulate animation complete
    onCompleteCallback?.();

    // Another held key
    cycleToNextEntity(undefined, true);
    assertSelectionEquals(["third"]);

    // Cleanup
    viewportAnimation.animateTo = originalAnimateTo;
    document.body.removeChild(mockContainer);
  });
});

describe("performance", () => {
  test("handles 50 held-key cycles on 100 entities in reasonable time", () => {
    // Create many entities
    for (let i = 0; i < 100; i++) {
      canvasStore.addEntity(createTestEntity({ id: `entity-${i}` }));
    }

    // Mock the container
    const mockContainer = document.createElement("div");
    mockContainer.className = "infinite-canvas";
    Object.defineProperty(mockContainer, "clientWidth", { value: 800 });
    Object.defineProperty(mockContainer, "clientHeight", { value: 600 });
    document.body.appendChild(mockContainer);

    // Capture onComplete callback to simulate animation completion
    let onCompleteCallback: (() => void) | undefined;
    const originalAnimateTo = viewportAnimation.animateTo.bind(viewportAnimation);
    viewportAnimation.animateTo = (_target, options) => {
      onCompleteCallback = options?.onComplete;
    };

    const start = performance.now();
    // First press is fresh (repeat=false), rest are held (repeat=true)
    cycleToNextEntity(undefined, false);
    onCompleteCallback?.();
    for (let i = 1; i < 50; i++) {
      cycleToNextEntity(undefined, true);
      // Simulate animation complete to allow next held cycle
      onCompleteCallback?.();
    }
    const elapsed = performance.now() - start;

    // Should complete quickly (generous threshold for CI variability)
    expect(elapsed).toBeLessThan(100);

    // Cleanup
    viewportAnimation.animateTo = originalAnimateTo;
    document.body.removeChild(mockContainer);
  });

  test("handles 50 rapid fresh presses on 100 entities in reasonable time", () => {
    // Create many entities
    for (let i = 0; i < 100; i++) {
      canvasStore.addEntity(createTestEntity({ id: `entity-${i}` }));
    }

    // Mock the container
    const mockContainer = document.createElement("div");
    mockContainer.className = "infinite-canvas";
    Object.defineProperty(mockContainer, "clientWidth", { value: 800 });
    Object.defineProperty(mockContainer, "clientHeight", { value: 600 });
    document.body.appendChild(mockContainer);

    // Mock animateTo (fresh presses don't need onComplete since they interrupt)
    const originalAnimateTo = viewportAnimation.animateTo.bind(viewportAnimation);
    viewportAnimation.animateTo = () => {};

    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      // All fresh presses (repeat=false) - can interrupt animation
      cycleToNextEntity(undefined, false);
    }
    const elapsed = performance.now() - start;

    // Should complete quickly (generous threshold for CI variability)
    expect(elapsed).toBeLessThan(100);

    // Cleanup
    viewportAnimation.animateTo = originalAnimateTo;
    document.body.removeChild(mockContainer);
  });
});
