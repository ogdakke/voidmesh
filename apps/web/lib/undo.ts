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

/** Alternate history authority used by hosted collaborative workspaces. */
export interface UndoDelegate {
  abortTransaction(): void;
  beginTransaction(): void;
  canRedo(): boolean;
  canUndo(): boolean;
  clear(): void;
  commitTransaction(): void;
  redo(): void;
  subscribe(listener: Listener): Unsubscribe;
  undo(): void;
}

export class Undo {
  #undoStack: Command[] = [];
  #redoStack: Command[] = [];
  #config: UndoConfig;
  #transactionStack: Command[] | null = null;
  #listeners = new Set<Listener>();
  #delegate: UndoDelegate | null = null;
  #delegateTransaction = false;
  #unsubscribeDelegate: Unsubscribe | null = null;

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
    if (this.#delegate) {
      this.#delegate.undo();
      return;
    }
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
    if (this.#delegate) {
      this.#delegate.redo();
      return;
    }
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
    if (this.#delegate) {
      // Hosted history is reconstructed from the Yjs document. The local command
      // snapshot is redundant, but it may own retained media that must be released.
      command.evict();
      return;
    }
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
    return this.#delegate ? this.#delegateTransaction : this.#transactionStack !== null;
  }

  /** Begin a transaction - all commands added will be grouped */
  beginTransaction() {
    if (this.#delegate) {
      if (this.#delegateTransaction) {
        logger.warn("Transaction already in progress");
        return;
      }
      this.#delegateTransaction = true;
      this.#delegate.beginTransaction();
      return;
    }
    if (this.#transactionStack !== null) {
      logger.warn("Transaction already in progress");
      return;
    }
    this.#transactionStack = [];
  }

  /** Commit the current transaction as a single undoable action */
  commitTransaction(description?: string) {
    if (this.#delegate) {
      if (!this.#delegateTransaction) {
        logger.warn("No transaction in progress");
        return;
      }
      this.#delegateTransaction = false;
      this.#delegate.commitTransaction();
      return;
    }
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
    if (this.#delegate) {
      if (!this.#delegateTransaction) {
        logger.warn("No transaction in progress");
        return;
      }
      this.#delegateTransaction = false;
      this.#delegate.abortTransaction();
      return;
    }
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
    return this.#delegate?.canUndo() ?? this.#undoStack.length > 0;
  }

  /** Check if redo is available */
  canRedo(): boolean {
    return this.#delegate?.canRedo() ?? this.#redoStack.length > 0;
  }

  /** Clear all active and committed undo/redo history. */
  clear() {
    if (this.#delegate) {
      this.#delegateTransaction = false;
      this.#delegate.clear();
      return;
    }
    this.#clearLocal();
  }

  /**
   * Route history controls to another authority until the returned cleanup runs.
   * This is intentionally exclusive: one canvas can only expose one history.
   */
  setDelegate(delegate: UndoDelegate): Unsubscribe {
    if (this.#delegate) throw new Error("Undo history already has a delegate");
    this.#clearLocal();
    this.#delegate = delegate;
    this.#unsubscribeDelegate = delegate.subscribe(() => this.#notify());
    this.#notify();
    return () => {
      if (this.#delegate !== delegate) return;
      this.#unsubscribeDelegate?.();
      this.#unsubscribeDelegate = null;
      this.#delegate = null;
      this.#delegateTransaction = false;
      this.#notify();
    };
  }

  #clearLocal() {
    // Evict all commands before clearing
    for (const cmd of this.#transactionStack ?? []) {
      cmd.evict();
    }
    for (const cmd of this.#undoStack) {
      cmd.evict();
    }
    for (const cmd of this.#redoStack) {
      cmd.evict();
    }

    this.#transactionStack = null;
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
