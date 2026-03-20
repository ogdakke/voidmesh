import { fileHandleStore } from "#lib/files/file-handle.ts";
import { generateFunFilename } from "#lib/files/random-filename.ts";
import { isMobileWebKit } from "#lib/util.ts";
import { logger } from "./client.logger";

const VDMSH_FILE_TYPE: FilePickerAcceptType = {
  description: "Voidmesh workspace",
  accept: { "application/vdmsh": [".vdmsh"] },
};

/** Trigger a browser download of a Blob with the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Write a blob to a file handle.
 * Returns false if the write fails (e.g. permission revoked).
 */
export async function writeToHandle(blob: Blob, handle: FileSystemFileHandle): Promise<boolean> {
  try {
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (writeErr) {
      await writable.abort();
      throw writeErr;
    }
    return true;
  } catch (error) {
    logger.error(error);
    return false;
  }
}

/**
 * Request write permission on a file handle. Must be called during a user gesture
 * (before any async work like serialization). Handles opened via showOpenFilePicker
 * only have read permission — the first createWritable() call needs user activation
 * to prompt for write access.
 * Returns true if permission was granted, false otherwise.
 */
export async function requestWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  try {
    const state = await handle.queryPermission({ mode: "readwrite" });
    if (state === "granted") return true;
    const result = await handle.requestPermission({ mode: "readwrite" });
    return result === "granted";
  } catch (error) {
    logger.error(error);
    return false;
  }
}

/**
 * Acquire a file handle for saving. Must be called during a user gesture.
 * Returns the handle and filename, or null if the user cancelled.
 */
export async function acquireSaveHandle(): Promise<{
  handle: FileSystemFileHandle;
  name: string;
} | null> {
  const suggestedName = await generateFunFilename();
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [VDMSH_FILE_TYPE],
    });
    fileHandleStore.handle = handle;
    return { handle, name: handle.name };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

/**
 * Open a .vdmsh file. Must be called during a user gesture.
 * Uses native file picker on Chromium (capturing the handle for future saves),
 * falls back to `<input type="file">`.
 * Returns the File or null if cancelled.
 */
export async function openFile(): Promise<File | null> {
  if (fileHandleStore.supportsFileSystemAccess) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [VDMSH_FILE_TYPE],
        multiple: false,
      });
      if (!handle) return null;
      fileHandleStore.handle = handle;
      return handle.getFile();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }

  // Fallback: <input type="file">
  return new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (isMobileWebKit()) {
      // iOS ignores custom extensions — use archive MIME types to skip
      // the Photos/Camera prompt and go straight to the Files picker.
      input.accept = "application/zip,application/x-zip-compressed,application/vdmsh";
    } else {
      input.accept = ".studio,.zip,.vdmsh,application/vdmsh";
    }

    let resolved = false;
    const done = (file: File | null) => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener("focus", onFocus);
      if (file) {
        logger.debug(`[openFile] Selected: ${file.name} (${file.size} bytes, ${file.type})`);
      } else {
        logger.debug("[openFile] Cancelled or no file selected");
      }
      resolve(file);
    };

    input.onchange = () => {
      done(input.files?.[0] ?? null);
    };

    // Cancel detection: when the picker closes without selection, the window
    // regains focus. Use a longer timeout on mobile — iOS is slow to fire onchange.
    const cancelTimeout = isMobileWebKit() ? 1000 : 300;
    const onFocus = () => {
      setTimeout(() => {
        if (!resolved) done(null);
      }, cancelTimeout);
    };
    window.addEventListener("focus", onFocus);
    input.click();
  });
}
