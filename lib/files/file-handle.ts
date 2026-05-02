/**
 * Session-scoped FileSystemFileHandle singleton.
 * Enables "save to same file" on Chromium browsers.
 */
class FileHandleStore {
  readonly supportsFileSystemAccess =
    "showSaveFilePicker" in globalThis &&
    (() => {
      try {
        return globalThis.self === globalThis.top;
      } catch {
        return false;
      }
    })();

  #handle: FileSystemFileHandle | null = null;
  #listeners = new Set<() => void>();

  get handle(): FileSystemFileHandle | null {
    return this.#handle;
  }

  set handle(h: FileSystemFileHandle | null) {
    if (this.#handle === h) return;
    this.#handle = h;
    this.#emit();
  }

  get name(): string | null {
    return this.#handle?.name ?? null;
  }

  get hasHandle(): boolean {
    return this.#handle !== null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): FileSystemFileHandle | null => {
    return this.#handle;
  };

  #emit() {
    for (const listener of this.#listeners) listener();
  }
}

export const fileHandleStore = new FileHandleStore();
