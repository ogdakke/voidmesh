import { describe, expect, test, vi } from "vitest";
import { Command, Undo, type UndoDelegate } from "#lib/undo.ts";

describe("Undo", () => {
  test("clear evicts and aborts an active transaction", () => {
    const history = new Undo();
    const execute = vi.fn<() => void>();
    const undo = vi.fn<() => void>();
    const onEvict = vi.fn<() => void>();

    history.beginTransaction();
    history.add(Command.create({ execute, undo, onEvict }));

    history.clear();
    history.commitTransaction();

    expect(onEvict).toHaveBeenCalledOnce();
    expect(history.isInTransaction()).toBe(false);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
  });

  test("delegates hosted history and evicts redundant local command snapshots", () => {
    const history = new Undo();
    const listeners = new Set<() => void>();
    const delegate: UndoDelegate = {
      abortTransaction: vi.fn(),
      beginTransaction: vi.fn(),
      canRedo: () => false,
      canUndo: () => true,
      clear: vi.fn(),
      commitTransaction: vi.fn(),
      redo: vi.fn(),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      undo: vi.fn(),
    };
    const onEvict = vi.fn<() => void>();
    const release = history.setDelegate(delegate);

    history.add(Command.create({ execute: vi.fn(), onEvict, undo: vi.fn() }));
    history.beginTransaction();
    history.commitTransaction();
    history.undo();

    expect(onEvict).toHaveBeenCalledOnce();
    expect(delegate.beginTransaction).toHaveBeenCalledOnce();
    expect(delegate.commitTransaction).toHaveBeenCalledOnce();
    expect(delegate.undo).toHaveBeenCalledOnce();
    expect(history.canUndo()).toBe(true);

    release();
    expect(history.canUndo()).toBe(false);
    expect(listeners).toHaveLength(0);
  });
});
