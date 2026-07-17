import { useSyncExternalStore } from "react";
import { undo } from "#lib/undo.ts";
import { Redo, Undo } from "iconoir-react";

const getCanUndo = () => undo.canUndo();
const getCanRedo = () => undo.canRedo();

export const UndoRedoButtons = function MobileUndoRedo() {
  const canUndo = useSyncExternalStore(undo.subscribe, getCanUndo);
  const canRedo = useSyncExternalStore(undo.subscribe, getCanRedo);

  return (
    <div className="undo-redo">
      <button name="undo" disabled={!canUndo} onClick={() => undo.undo()}>
        <Undo />
      </button>
      <button name="redo" disabled={!canRedo} onClick={() => undo.redo()}>
        <Redo />
      </button>
    </div>
  );
};
