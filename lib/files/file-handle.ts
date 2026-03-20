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

  get handle(): FileSystemFileHandle | null {
    return this.#handle;
  }

  set handle(h: FileSystemFileHandle | null) {
    this.#handle = h;
  }

  get name(): string | null {
    return this.#handle?.name ?? null;
  }

  get hasHandle(): boolean {
    return this.#handle !== null;
  }
}

export const fileHandleStore = new FileHandleStore();
