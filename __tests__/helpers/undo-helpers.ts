/**
 * Undo/redo testing utilities
 *
 * These helpers make it easier to test undo/redo functionality
 * by providing access to internal undo state and assertion helpers.
 */
import { act } from "@testing-library/react";
import { undo, Command } from "#lib/undo.ts";
import { canvasStore } from "#engine";
import { getNestedValue } from "./assertions.ts";

/**
 * Get the current undo stack size
 */
export function getUndoStackSize(): number {
  // Since we can't access private fields directly, we track this indirectly
  // by checking canUndo
  const snapshot = captureUndoRedoState();
  return snapshot.canUndo ? -1 : 0; // -1 means "at least 1"
}

/**
 * Get the current redo stack size
 */
export function getRedoStackSize(): number {
  const snapshot = captureUndoRedoState();
  return snapshot.canRedo ? -1 : 0; // -1 means "at least 1"
}

/**
 * Capture whether undo/redo are available
 */
export function captureUndoRedoState(): { canUndo: boolean; canRedo: boolean } {
  return {
    canUndo: undo.canUndo(),
    canRedo: undo.canRedo(),
  };
}

/**
 * Clear all undo/redo history
 * Note: This also evicts all commands, which may trigger cleanup callbacks
 */
export function clearUndoHistory(): void {
  undo.clear();
}

/**
 * Capture a snapshot of an entity's current state for later comparison
 */
export function captureEntityState(entityId: string): Record<string, unknown> | null {
  const entity = canvasStore.getState().entities.get(entityId);
  if (!entity) return null;

  // Deep clone to avoid reference issues
  return {
    id: entity.id,
    name: entity.name,
    shaderType: entity.shaderType,
    shaderParams: structuredClone(entity.shaderParams),
    position: { ...entity.position },
    size: { ...entity.size },
    zIndex: entity.zIndex,
    rotation: entity.rotation,
    locked: entity.locked,
    edited: entity.edited,
  };
}

/**
 * Assert that an entity's state matches the expected values
 */
export function assertStateEquals(
  entityId: string,
  expected: Partial<Record<string, unknown>>,
  message?: string,
): void {
  const current = captureEntityState(entityId);

  if (!current) {
    throw new Error(`${message ?? "Entity state assertion failed"}: Entity ${entityId} not found`);
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    const currentValue = current[key];

    if (typeof expectedValue === "object" && expectedValue !== null) {
      if (JSON.stringify(currentValue) !== JSON.stringify(expectedValue)) {
        throw new Error(
          `${message ?? "Entity state assertion failed"}: ${key} mismatch. ` +
            `Expected: ${JSON.stringify(expectedValue)}, Got: ${JSON.stringify(currentValue)}`,
        );
      }
    } else if (currentValue !== expectedValue) {
      throw new Error(
        `${message ?? "Entity state assertion failed"}: ${key} mismatch. ` +
          `Expected: ${expectedValue}, Got: ${currentValue}`,
      );
    }
  }
}

/**
 * Perform an undo operation
 * Wrapped in act() to handle React state updates from store changes
 */
export function performUndo(): void {
  act(() => {
    undo.undo();
  });
}

/**
 * Perform a redo operation
 * Wrapped in act() to handle React state updates from store changes
 */
export function performRedo(): void {
  act(() => {
    undo.redo();
  });
}

/**
 * Begin a transaction for grouped undo
 */
export function beginTransaction(): void {
  undo.beginTransaction();
}

/**
 * Commit a transaction
 */
export function commitTransaction(description?: string): void {
  undo.commitTransaction(description);
}

/**
 * Abort a transaction
 */
export function abortTransaction(): void {
  undo.abortTransaction();
}

/**
 * Add a command to the undo stack (for testing command creation)
 */
export function addCommand(command: Command): void {
  undo.add(command);
}

/**
 * Create a simple test command
 */
export function createTestCommand(config: {
  onExecute: () => void;
  onUndo: () => void;
  onEvict?: () => void;
  description?: string;
}): Command {
  return Command.create({
    execute: config.onExecute,
    undo: config.onUndo,
    onEvict: config.onEvict,
    description: config.description,
  });
}

/**
 * Track resource cleanup calls for testing eviction
 */
export class ResourceCleanupTracker {
  cleanedIds: string[] = [];

  track(entityId: string): () => void {
    return () => {
      this.cleanedIds.push(entityId);
    };
  }

  wasCleanedUp(entityId: string): boolean {
    return this.cleanedIds.includes(entityId);
  }

  reset(): void {
    this.cleanedIds = [];
  }
}

/**
 * Create an entity state comparison helper
 */
export function createStateComparison(entityId: string) {
  const initialState = captureEntityState(entityId);

  return {
    initial: initialState,
    assertChanged(path: string): void {
      const currentState = captureEntityState(entityId);
      if (!currentState || !initialState) {
        throw new Error("Cannot compare states - entity missing");
      }

      const initialValue = getNestedValue(initialState, path);
      const currentValue = getNestedValue(currentState, path);

      if (JSON.stringify(initialValue) === JSON.stringify(currentValue)) {
        throw new Error(
          `Expected ${path} to have changed, but it's still: ${JSON.stringify(initialValue)}`,
        );
      }
    },
    assertUnchanged(path: string): void {
      const currentState = captureEntityState(entityId);
      if (!currentState || !initialState) {
        throw new Error("Cannot compare states - entity missing");
      }

      const initialValue = getNestedValue(initialState, path);
      const currentValue = getNestedValue(currentState, path);

      if (JSON.stringify(initialValue) !== JSON.stringify(currentValue)) {
        throw new Error(
          `Expected ${path} to be unchanged. Initial: ${JSON.stringify(initialValue)}, ` +
            `Current: ${JSON.stringify(currentValue)}`,
        );
      }
    },
    assertRestored(): void {
      const currentState = captureEntityState(entityId);
      if (JSON.stringify(currentState) !== JSON.stringify(initialState)) {
        throw new Error("Entity state was not fully restored to initial state");
      }
    },
  };
}
