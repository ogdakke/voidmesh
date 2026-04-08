/**
 * Property-based tests for the Undo command pattern.
 *
 * Tests state machine invariants: add/undo/redo consistency,
 * stack limits, transaction grouping, and redo stack clearing.
 */
import { describe, test, expect, beforeEach } from "vitest";
import fc from "fast-check";
import { Undo, Command } from "#lib/undo.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function createTrackingCommand(state: { value: number }, delta: number) {
  return Command.create({
    execute: () => { state.value += delta; },
    undo: () => { state.value -= delta; },
    description: `change by ${delta}`,
  });
}

// ── Properties ──────────────────────────────────────────────────────

describe("Undo (property-based)", () => {
  let undoManager: Undo;

  beforeEach(() => {
    undoManager = new Undo({ undo: { size: 20 }, redo: { size: 20 } });
  });

  test("add then undo restores state", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 10 }),
        (deltas) => {
          const state = { value: 0 };
          const mgr = new Undo({ undo: { size: 20 }, redo: { size: 20 } });

          // Apply all deltas
          for (const delta of deltas) {
            const cmd = createTrackingCommand(state, delta);
            cmd.execute();
            mgr.add(cmd);
          }

          const afterApply = state.value;
          const expectedSum = deltas.reduce((a, b) => a + b, 0);
          expect(afterApply).toBe(expectedSum);

          // Undo all
          for (let i = 0; i < deltas.length; i++) {
            mgr.undo();
          }

          expect(state.value).toBe(0);
          expect(mgr.canUndo()).toBe(false);
        },
      ),
    );
  });

  test("undo then redo restores modified state", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 10 }),
        (deltas) => {
          const state = { value: 0 };
          const mgr = new Undo({ undo: { size: 20 }, redo: { size: 20 } });

          for (const delta of deltas) {
            const cmd = createTrackingCommand(state, delta);
            cmd.execute();
            mgr.add(cmd);
          }

          const finalValue = state.value;

          // Undo all, then redo all
          for (let i = 0; i < deltas.length; i++) {
            mgr.undo();
          }
          for (let i = 0; i < deltas.length; i++) {
            mgr.redo();
          }

          expect(state.value).toBe(finalValue);
        },
      ),
    );
  });

  test("new add clears redo stack", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (d1, d2, d3) => {
          const state = { value: 0 };
          const mgr = new Undo({ undo: { size: 20 }, redo: { size: 20 } });

          const cmd1 = createTrackingCommand(state, d1);
          cmd1.execute();
          mgr.add(cmd1);

          const cmd2 = createTrackingCommand(state, d2);
          cmd2.execute();
          mgr.add(cmd2);

          // Undo last → redo should be available
          mgr.undo();
          expect(mgr.canRedo()).toBe(true);

          // New action → redo cleared
          const cmd3 = createTrackingCommand(state, d3);
          cmd3.execute();
          mgr.add(cmd3);
          expect(mgr.canRedo()).toBe(false);
        },
      ),
    );
  });

  test("stack size limits are respected", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 1, maxLength: 30 }),
        (maxSize, deltas) => {
          const state = { value: 0 };
          const mgr = new Undo({ undo: { size: maxSize }, redo: { size: maxSize } });

          for (const delta of deltas) {
            const cmd = createTrackingCommand(state, delta);
            cmd.execute();
            mgr.add(cmd);
          }

          // Count how many undos we can do
          let undoCount = 0;
          while (mgr.canUndo()) {
            mgr.undo();
            undoCount++;
          }

          // Should not exceed configured max size
          expect(undoCount).toBeLessThanOrEqual(maxSize);
        },
      ),
    );
  });

  test("canUndo/canRedo accurately reflect stack state", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 0, maxLength: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (deltas, undoCount) => {
          const state = { value: 0 };
          const mgr = new Undo({ undo: { size: 20 }, redo: { size: 20 } });

          for (const delta of deltas) {
            const cmd = createTrackingCommand(state, delta);
            cmd.execute();
            mgr.add(cmd);
          }

          const actualUndoCount = Math.min(undoCount, deltas.length);
          for (let i = 0; i < actualUndoCount; i++) {
            mgr.undo();
          }

          const remainingUndos = deltas.length - actualUndoCount;
          expect(mgr.canUndo()).toBe(remainingUndos > 0);
          expect(mgr.canRedo()).toBe(actualUndoCount > 0);
        },
      ),
    );
  });

  test("partial undo/redo maintains correct state", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 2, maxLength: 8 }),
        fc.integer({ min: 1, max: 7 }),
        (deltas, undoN) => {
          const state = { value: 0 };
          const mgr = new Undo({ undo: { size: 20 }, redo: { size: 20 } });

          for (const delta of deltas) {
            const cmd = createTrackingCommand(state, delta);
            cmd.execute();
            mgr.add(cmd);
          }

          // Undo some (not all)
          const actualUndos = Math.min(undoN, deltas.length);
          for (let i = 0; i < actualUndos; i++) {
            mgr.undo();
          }

          // State should equal sum of remaining deltas
          const expectedSum = deltas.slice(0, deltas.length - actualUndos).reduce((a, b) => a + b, 0);
          expect(state.value).toBe(expectedSum);
        },
      ),
    );
  });

  test("transaction groups multiple commands into one undo", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 2, maxLength: 6 }),
        (deltas) => {
          const state = { value: 0 };
          const mgr = new Undo({ undo: { size: 20 }, redo: { size: 20 } });

          mgr.beginTransaction();
          for (const delta of deltas) {
            const cmd = createTrackingCommand(state, delta);
            cmd.execute();
            mgr.add(cmd);
          }
          mgr.commitTransaction("batch");

          const totalDelta = deltas.reduce((a, b) => a + b, 0);
          expect(state.value).toBe(totalDelta);

          // Single undo should revert all commands in the transaction
          mgr.undo();
          expect(state.value).toBe(0);
          expect(mgr.canUndo()).toBe(false);
        },
      ),
    );
  });

  test("clear empties both stacks", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 1, maxLength: 5 }),
        (deltas) => {
          const state = { value: 0 };
          const mgr = new Undo({ undo: { size: 20 }, redo: { size: 20 } });

          for (const delta of deltas) {
            const cmd = createTrackingCommand(state, delta);
            cmd.execute();
            mgr.add(cmd);
          }

          mgr.clear();
          expect(mgr.canUndo()).toBe(false);
          expect(mgr.canRedo()).toBe(false);
        },
      ),
    );
  });
});
