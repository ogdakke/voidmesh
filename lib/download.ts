import { fileHandleStore } from "#lib/files/file-handle.ts";
import { generateFunFilename } from "#lib/files/random-filename.ts";
import { isMobileWebKit } from "#lib/util.ts";
import { logger } from "./client.logger";

const DOWNLOAD_DEV_SERVICE_WORKER = "/voidmesh-download-dev-sw.js";
const DOWNLOAD_SCOPE = "/__voidmesh-download/";

let downloadServiceWorker: ServiceWorker | null = null;

/** Ensure the active root service worker can stream workspace downloads. */
export async function registerWorkspaceDownloadServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) {
    throw new Error("Workspace downloads require service worker support");
  }

  const registration = import.meta.env.DEV
    ? await navigator.serviceWorker.register(DOWNLOAD_DEV_SERVICE_WORKER, { scope: "/" })
    : await navigator.serviceWorker.ready;
  const active = await waitForActiveServiceWorker(registration);
  await waitForServiceWorkerControl(active);
  await verifyDownloadServiceWorker(active);
  downloadServiceWorker = active;
  logger.debug("[workspace-save] download service worker ready", {
    scriptURL: active.scriptURL,
    scope: registration.scope,
  });
}

/** Begin a streamed workspace download and return the transport port for the serializer. */
export function startWorkspaceDownload(filename: string): MessagePort {
  if (!downloadServiceWorker) {
    throw new Error("Workspace download service worker is not ready");
  }
  if (!isSameServiceWorker(navigator.serviceWorker.controller, downloadServiceWorker)) {
    throw new Error("Workspace download service worker does not control this page");
  }

  const token = crypto.randomUUID();
  const channel = new MessageChannel();
  logger.debug("[workspace-save] starting streamed fallback download", { filename, token });
  downloadServiceWorker.postMessage({ type: "open", token, filename }, [channel.port2]);

  const anchor = document.createElement("a");
  anchor.href = `${DOWNLOAD_SCOPE}${encodeURIComponent(token)}`;
  anchor.download = filename;
  anchor.click();
  return channel.port1;
}

async function waitForServiceWorkerControl(active: ServiceWorker): Promise<void> {
  if (isSameServiceWorker(navigator.serviceWorker.controller, active)) return;

  await new Promise<void>((resolve, reject) => {
    const onControllerChange = () => {
      if (!isSameServiceWorker(navigator.serviceWorker.controller, active)) return;
      window.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      reject(new Error("Workspace download service worker did not take control of this page"));
    }, 5000);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  });
}

function isSameServiceWorker(
  first: ServiceWorker | null,
  second: ServiceWorker | null,
): boolean {
  return first !== null && second !== null && first.scriptURL === second.scriptURL;
}

async function verifyDownloadServiceWorker(active: ServiceWorker): Promise<void> {
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(new Error("Active service worker does not support workspace downloads"));
    }, 5000);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      channel.port1.close();
      if (error) reject(error);
      else resolve();
    };

    channel.port1.onmessage = (event: MessageEvent) => {
      if (event.data?.type === "pong") finish();
      else finish(new Error("Active service worker returned an invalid workspace download response"));
    };
    channel.port1.start();
    try {
      active.postMessage({ type: "ping" }, [channel.port2]);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Open a streamed writer for an existing File System Access handle.
 * The serializer worker sends bounded ZIP chunks through the returned port.
 */
export async function startWorkspaceFileWrite(handle: FileSystemFileHandle): Promise<MessagePort> {
  const writable = await handle.createWritable();
  const channel = new MessageChannel();
  let failed = false;
  let operation = Promise.resolve();

  const reportFailure = async (error: unknown) => {
    if (failed) return;
    failed = true;
    try {
      await writable.abort();
    } catch (abortError) {
      logger.error("[workspace-save] failed to abort file write", abortError);
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[workspace-save] direct file write failed", { filename: handle.name, message });
    channel.port1.postMessage({ type: "error", message });
  };

  const enqueue = (task: () => Promise<void>) => {
    operation = operation.then(task).catch((error) => {
      void reportFailure(error);
      throw error;
    });
  };

  channel.port1.onmessage = (event: MessageEvent) => {
    const message = event.data;
    if (message?.type === "chunk") {
      enqueue(async () => {
        await writable.write(new Uint8Array(message.chunk));
        channel.port1.postMessage({ type: "ack" });
      });
    } else if (message?.type === "complete") {
      enqueue(async () => {
        await writable.close();
        logger.debug("[workspace-save] direct file write completed", { filename: handle.name });
        channel.port1.postMessage({ type: "closed" });
        channel.port1.close();
      });
    } else if (message?.type === "error") {
      void reportFailure(new Error(String(message.message ?? "Serialization worker failed")));
    }
  };
  channel.port1.start();
  channel.port1.postMessage({ type: "ready" });
  logger.debug("[workspace-save] opened direct file writer", { filename: handle.name });
  // Keep port1 in the page for writable writes; transfer its peer to the
  // archive worker, which sends chunks through port2.
  return channel.port2;
}

async function waitForActiveServiceWorker(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorker> {
  if (registration.active) return registration.active;

  const installing = registration.installing ?? registration.waiting;
  if (!installing) throw new Error("Workspace download service worker did not activate");

  await new Promise<void>((resolve, reject) => {
    const onStateChange = () => {
      if (installing.state === "activated") {
        installing.removeEventListener("statechange", onStateChange);
        resolve();
      } else if (installing.state === "redundant") {
        installing.removeEventListener("statechange", onStateChange);
        reject(new Error("Workspace download service worker became redundant"));
      }
    };
    installing.addEventListener("statechange", onStateChange);
    onStateChange();
  });

  if (!registration.active) throw new Error("Workspace download service worker did not activate");
  return registration.active;
}

const VDMSH_FILE_TYPE: FilePickerAcceptType = {
  description: "Voidmesh workspace",
  accept: { "application/vdmsh": [".vdmsh"] },
};

/** Request write permission for a handle opened with showOpenFilePicker. */
export async function requestWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  try {
    const state = await handle.queryPermission({ mode: "readwrite" });
    if (state === "granted") return true;
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch (error) {
    logger.error("[workspace-save] write permission request failed", error);
    return false;
  }
}

/** Acquire a new direct-save handle during a user gesture. */
export async function acquireSaveHandle(): Promise<{
  handle: FileSystemFileHandle;
  name: string;
} | null> {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: generateFunFilename(),
      types: [VDMSH_FILE_TYPE],
    });
    fileHandleStore.handle = handle;
    return { handle, name: handle.name };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

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
    if (!isMobileWebKit()) {
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
