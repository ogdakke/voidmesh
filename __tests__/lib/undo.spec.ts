import { describe, expect, test, vi } from "vitest";
import { Command, Undo } from "#lib/undo.ts";

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
});
