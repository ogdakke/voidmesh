import { useState, useSyncExternalStore } from "react";
import { useCanvasCommands } from "#context/use-canvas.ts";
import { toastManager, ToastType } from "#application/notifications.ts";
import type {
  DeserializeOptions,
  DeserializeProgress,
  DeserializeResult,
} from "#lib/serialization/types.ts";
import {
  acquireSaveHandle,
  downloadBlob,
  openFile,
  requestWritePermission,
  writeToHandle,
} from "#lib/download.ts";
import { fileHandleStore } from "#lib/files/file-handle.ts";
import { generateFunFilename } from "#lib/files/random-filename.ts";
import { getIsSaving } from "#application/canvas/serialize-workspace.ts";
import { logger } from "#lib/client.logger.ts";
import { createEnum } from "#types/index.ts";

export const StudioFileStatus = createEnum({
  idle: "idle",
  saving: "saving",
  opening: "opening",
});
export type StudioFileStatus = typeof StudioFileStatus.infer;

export async function importStudioWithToasts(
  source: Blob | ArrayBuffer,
  deserializeCanvas: (
    source: Blob | ArrayBuffer,
    options?: DeserializeOptions,
  ) => Promise<DeserializeResult>,
): Promise<DeserializeResult> {
  const controller = new AbortController();
  const cancelAction = {
    children: "Cancel",
    onClick: () => controller.abort(),
  };
  const hiddenAction = { children: null };
  let lastProgress: DeserializeProgress | null = null;
  let lastRenderedProgressStage: DeserializeProgress["stage"] | null = null;
  let lastToastUpdateAt = -Infinity;
  const startedAt = performance.now();
  logger.debug("[workspace-import] ui import requested", {
    fileSizeBytes: source instanceof Blob ? source.size : source.byteLength,
    sourceType: source instanceof Blob ? "blob" : "array-buffer",
  });

  const toastId = toastManager.add({
    title: "Importing voidmesh workspace",
    description: "Preparing",
    timeout: 0,
    actionProps: cancelAction,
  });

  const updateToast = (updates: {
    title?: string;
    description?: string;
    timeout?: number;
    type?: (typeof ToastType)[keyof typeof ToastType];
    showAction?: boolean;
  }) => {
    toastManager.update(toastId, {
      ...updates,
      actionProps: updates.showAction ? cancelAction : hiddenAction,
    });
  };

  try {
    const result = await deserializeCanvas(source, {
      signal: controller.signal,
      onProgress: (progress) => {
        lastProgress = progress;
        logger.debug("[workspace-import] ui progress", progress);
        const now = performance.now();
        const stageChanged = progress.stage !== lastRenderedProgressStage;
        if (!stageChanged && now - lastToastUpdateAt < 100) return;
        lastRenderedProgressStage = progress.stage;
        lastToastUpdateAt = now;
        updateToast({
          description: formatImportProgress(progress),
          showAction: progress.stage !== "done",
        });
      },
    });

    if (result.errors.length > 0) {
      const total = result.entityCount + result.errors.length;
      updateToast({
        title:
          result.entityCount > 0
            ? `Failed to import ${result.errors.length} of ${total} files`
            : "Import failed",
        description: result.errors[0]?.error ?? "Some items could not be restored",
        timeout: 5000,
        type: ToastType.destructive,
        showAction: false,
      });
      logger.debug("[workspace-import] ui import completed with entity errors", {
        durationMs: Math.round(performance.now() - startedAt),
        entityCount: result.entityCount,
        errorCount: result.errors.length,
        firstError: result.errors[0]?.error,
      });
      return result;
    }

    updateToast({
      title: "Imported successfully",
      description: result.warnings[0] ?? undefined,
      timeout: 2500,
      showAction: false,
    });
    logger.debug("[workspace-import] ui import succeeded", {
      durationMs: Math.round(performance.now() - startedAt),
      entityCount: result.entityCount,
      warningCount: result.warnings.length,
    });
    return result;
  } catch (err) {
    if (isAbortError(err)) {
      updateToast({
        title: "Import cancelled",
        description: lastProgress ? formatImportProgress(lastProgress) : undefined,
        timeout: 2500,
        showAction: false,
      });
      logger.debug("[workspace-import] ui import cancelled", {
        durationMs: Math.round(performance.now() - startedAt),
        lastProgress,
      });
      throw err;
    }

    updateToast({
      title: "Import failed",
      description: formatImportError(err, lastProgress),
      timeout: 5000,
      type: ToastType.destructive,
      showAction: false,
    });
    logger.debug("[workspace-import] ui import failed", {
      durationMs: Math.round(performance.now() - startedAt),
      lastProgress,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function serializeAndSave(
  serializeCanvas: () => Promise<Blob | null>,
  handle: FileSystemFileHandle,
  name: string,
): Promise<string> {
  const blob = await serializeCanvas();
  if (!blob) throw new Error("Save already in progress");
  const ok = await writeToHandle(blob, handle);
  if (!ok) throw new Error("Failed to write to file");
  return name;
}

async function serializeAndDownload(serializeCanvas: () => Promise<Blob | null>): Promise<string> {
  const blob = await serializeCanvas();
  if (!blob) throw new Error("Save already in progress");
  const name = await generateFunFilename();
  downloadBlob(blob, name);
  return name;
}

export function useStudioFile() {
  const {
    serializeCanvas,
    deserializeCanvas,
    clearWorkspace: clearCanvasWorkspace,
  } = useCanvasCommands();
  const [status, setStatus] = useState<StudioFileStatus>(StudioFileStatus.idle);
  const activeFileHandle = useSyncExternalStore(
    fileHandleStore.subscribe,
    fileHandleStore.getSnapshot,
  );

  const isBusy = status !== StudioFileStatus.idle;

  const clearWorkspace = () => {
    clearCanvasWorkspace();
    fileHandleStore.handle = null;
    toastManager.add({
      title: "Workspace cleared",
      description: "All resources were removed",
    });
  };

  const exportStudioFile = async () => {
    if (isBusy || getIsSaving()) return;
    setStatus(StudioFileStatus.saving);

    try {
      // If we have an existing handle, request write permission during the user
      // gesture (showOpenFilePicker only grants read — createWritable needs
      // user activation to prompt for write access the first time)
      if (fileHandleStore.hasHandle) {
        const handle = fileHandleStore.handle!;
        const name = fileHandleStore.name!;
        const permitted = await requestWritePermission(handle);
        if (permitted) {
          await toastManager.promise(serializeAndSave(serializeCanvas, handle, name), {
            loading: {
              title: "Saving workspace...",
              description: name,
            },
            success: (n) => ({
              title: "Saved",
              description: n,
              timeout: 2500,
            }),
            error: (err) => ({
              title: "Save failed",
              description: err instanceof Error ? err.message : "Unknown error",
              type: ToastType.destructive,
            }),
          });
          return;
        }
        // Permission denied — clear handle, fall through to picker
        fileHandleStore.handle = null;
      }

      // No handle — need a picker (must happen during user gesture, before async work)
      if (fileHandleStore.supportsFileSystemAccess) {
        const result = await acquireSaveHandle();
        if (!result) return; // User cancelled

        await toastManager.promise(serializeAndSave(serializeCanvas, result.handle, result.name), {
          loading: {
            title: "Saving workspace...",
            description: result.name,
          },
          success: (n) => ({
            title: "Saved",
            description: n,
            timeout: 2500,
          }),
          error: (err) => ({
            title: "Save failed",
            description: err instanceof Error ? err.message : "Unknown error",
            type: ToastType.destructive,
          }),
        });
        return;
      }

      // Fallback: serialize then download
      await toastManager.promise(serializeAndDownload(serializeCanvas), {
        loading: { title: "Saving workspace..." },
        success: (n) => ({
          title: "Saved",
          description: n,
          timeout: 2500,
        }),
        error: (err) => ({
          title: "Save failed",
          description: err instanceof Error ? err.message : "Unknown error",
          type: ToastType.destructive,
        }),
      });
    } catch {
      // Error already displayed by toastManager.promise
    } finally {
      setStatus(StudioFileStatus.idle);
    }
  };

  const saveAsStudioFile = async () => {
    if (isBusy || getIsSaving()) return;
    setStatus(StudioFileStatus.saving);

    try {
      // Picker must happen during user gesture, before any async work
      if (fileHandleStore.supportsFileSystemAccess) {
        const result = await acquireSaveHandle();
        if (!result) return;

        await toastManager.promise(serializeAndSave(serializeCanvas, result.handle, result.name), {
          loading: {
            title: "Saving workspace...",
            description: result.name,
          },
          success: (n) => ({
            title: "Saved",
            description: n,
            timeout: 2500,
          }),
          error: (err) => ({
            title: "Save failed",
            description: err instanceof Error ? err.message : "Unknown error",
            type: ToastType.destructive,
          }),
        });
        return;
      }

      // Fallback: serialize then download
      await toastManager.promise(serializeAndDownload(serializeCanvas), {
        loading: { title: "Saving workspace..." },
        success: (n) => ({
          title: "Saved",
          description: n,
          timeout: 2500,
        }),
        error: (err) => ({
          title: "Save failed",
          description: err instanceof Error ? err.message : "Unknown error",
          type: ToastType.destructive,
        }),
      });
    } catch {
      // Error already displayed by toastManager.promise
    } finally {
      setStatus(StudioFileStatus.idle);
    }
  };

  const importStudioFile = (onSuccess?: () => void) => {
    if (isBusy) return;

    setStatus(StudioFileStatus.opening);
    openFile()
      .then(async (file) => {
        if (!file) {
          logger.debug("[importStudioFile] No file returned from picker");
          setStatus(StudioFileStatus.idle);
          return;
        }
        logger.debug(
          `[importStudioFile] Opening: ${file.name} (${file.size} bytes, type: "${file.type}")`,
        );
        try {
          const result = await importStudioWithToasts(file, deserializeCanvas);
          if (result.success && onSuccess) onSuccess();
        } catch (err) {
          if (!isAbortError(err)) {
            logger.error("[importStudioFile] Import failed:", err);
          }
        } finally {
          logger.debug("[workspace-import] picker import finished");
          setStatus(StudioFileStatus.idle);
        }
      })
      .catch((err) => {
        logger.error("[importStudioFile] openFile() failed:", err);
        setStatus(StudioFileStatus.idle);
      });
  };

  return {
    exportStudioFile,
    saveAsStudioFile,
    importStudioFile,
    clearWorkspace,
    activeWorkspaceFileName: activeFileHandle?.name ?? null,
    hasActiveWorkspaceFile: activeFileHandle !== null,
    status,
    isExporting: status === StudioFileStatus.saving,
    isImporting: status === StudioFileStatus.opening,
  };
}

function formatImportProgress(progress: DeserializeProgress): string {
  switch (progress.stage) {
    case "reading":
      return "Reading workspace file";
    case "unzipping":
      return "Unpacking workspace archive";
    case "parsing":
      return "Reading workspace manifest";
    case "decoding":
      if (progress.entityCount && progress.entityIndex) {
        return `Importing item ${progress.entityIndex} of ${progress.entityCount}`;
      }
      return "Importing workspace media";
    case "restoring":
      return "Importing workspace into canvas";
    case "done":
      return "Imported successfully";
  }
}

function formatImportError(err: unknown, progress: DeserializeProgress | null): string {
  const message = err instanceof Error ? err.message : "Unknown error";
  if (!progress) return message;
  return `${formatImportProgress(progress)} ${message}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
