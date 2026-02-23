import type { ThunkSync } from "#types/index.ts";
import { logger } from "./client.logger";

export interface CommandConfig {
  /** Forward operation - performs the action (used for redo) */
  execute: ThunkSync;
  /** Backward operation - reverses the action */
  undo: ThunkSync;
  /** Cleanup callback when command is evicted from stack */
  onEvict?: ThunkSync;
  /** Debug label for logging */
  description?: string;
}

export class Command {
  #execute: ThunkSync;
  #undo: ThunkSync;
  #onEvict?: ThunkSync;
  #description?: string;

  constructor(config: CommandConfig) {
    this.#execute = config.execute;
    this.#undo = config.undo;
    this.#onEvict = config.onEvict;
    this.#description = config.description;
  }

  /** Perform the forward operation (for redo) */
  execute() {
    this.#execute();
  }

  /** Reverse the operation (for undo) */
  undo() {
    this.#undo();
  }

  /** Cleanup when evicted from stack (e.g., video resource cleanup) */
  evict() {
    this.#onEvict?.();
  }

  get description() {
    return this.#description;
  }

  static create(config: CommandConfig) {
    return new Command(config);
  }
}

interface StackConfig {
  size: number;
}

export interface UndoConfig {
  undo: StackConfig;
  redo: StackConfig;
}

type Listener = () => void;
type Unsubscribe = () => void;

export class Undo {
  #undoStack: Command[] = [];
  #redoStack: Command[] = [];
  #config: UndoConfig;
  #transactionStack: Command[] | null = null;
  #listeners = new Set<Listener>();

  /** Subscribe to state changes. Compatible with useSyncExternalStore. */
  subscribe = (listener: Listener): Unsubscribe => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #notify() {
    this.#listeners.forEach((l) => l());
  }

  constructor(config?: Partial<UndoConfig>) {
    this.#config = {
      undo: { size: 100, ...config?.undo },
      redo: { size: 100, ...config?.redo },
    };
  }

  /** Undo the last operation */
  undo() {
    const command = this.#undoStack.pop();
    if (!command) {
      logger.debug("Nothing to undo");
      return;
    }

    logger.debug("Undoing:", command.description);
    command.undo();

    // Push to redo stack, respecting limits
    this.#checkRedoLimits();
    this.#redoStack.push(command);
    this.#notify();
  }

  /** Redo the last undone operation */
  redo() {
    const command = this.#redoStack.pop();
    if (!command) {
      logger.debug("Nothing to redo");
      return;
    }

    logger.debug("Redoing:", command.description);
    command.execute();

    // Push back to undo stack, respecting limits
    this.#checkUndoLimits();
    this.#undoStack.push(command);
    this.#notify();
  }

  /** Add a new command to the undo stack */
  add(command: Command) {
    // If in a transaction, add to transaction stack instead
    if (this.#transactionStack !== null) {
      this.#transactionStack.push(command);
      return;
    }

    // Clear redo stack on new action (evict all redo commands)
    this.#clearRedoStack();

    // Check undo limits before adding
    this.#checkUndoLimits();
    this.#undoStack.push(command);

    logger.debug(
      "Added to undo stack:",
      command.description,
      "Stack size:",
      this.#undoStack.length,
    );
    this.#notify();
  }

  /** Check if a transaction is currently in progress */
  isInTransaction(): boolean {
    return this.#transactionStack !== null;
  }

  /** Begin a transaction - all commands added will be grouped */
  beginTransaction() {
    if (this.#transactionStack !== null) {
      logger.warn("Transaction already in progress");
      return;
    }
    this.#transactionStack = [];
  }

  /** Commit the current transaction as a single undoable action */
  commitTransaction(description?: string) {
    if (this.#transactionStack === null) {
      logger.warn("No transaction in progress");
      return;
    }

    const commands = this.#transactionStack;
    this.#transactionStack = null;

    if (commands.length === 0) {
      return;
    }

    // Create a composite command
    this.add(
      Command.create({
        undo: () => {
          // Undo in reverse order
          for (let i = commands.length - 1; i >= 0; i--) {
            commands[i]!.undo();
          }
        },
        execute: () => {
          // Execute in order
          for (const cmd of commands) {
            cmd.execute();
          }
        },
        onEvict: () => {
          // Evict all sub-commands
          for (const cmd of commands) {
            cmd.evict();
          }
        },
        description: description ?? `Transaction (${commands.length} operations)`,
      }),
    );
  }

  /** Abort the current transaction without committing */
  abortTransaction() {
    if (this.#transactionStack === null) {
      logger.warn("No transaction in progress");
      return;
    }

    // Evict all commands in the transaction
    for (const cmd of this.#transactionStack) {
      cmd.evict();
    }

    this.#transactionStack = null;
  }

  /** Check if undo is available */
  canUndo(): boolean {
    return this.#undoStack.length > 0;
  }

  /** Check if redo is available */
  canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  /** Clear all undo/redo history */
  clear() {
    // Evict all commands before clearing
    for (const cmd of this.#undoStack) {
      cmd.evict();
    }
    for (const cmd of this.#redoStack) {
      cmd.evict();
    }

    this.#undoStack = [];
    this.#redoStack = [];
    this.#notify();
  }

  #checkUndoLimits() {
    while (this.#undoStack.length >= this.#config.undo.size) {
      const evicted = this.#undoStack.shift();
      evicted?.evict();
    }
  }

  #checkRedoLimits() {
    while (this.#redoStack.length >= this.#config.redo.size) {
      const evicted = this.#redoStack.shift();
      evicted?.evict();
    }
  }

  #clearRedoStack() {
    // Evict all commands in redo stack when a new action is performed
    for (const cmd of this.#redoStack) {
      cmd.evict();
    }
    this.#redoStack = [];
  }
}

export const undo = new Undo();
