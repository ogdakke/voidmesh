import { useState } from "react";
import { useCanvas } from "../context/use-canvas.ts";
import { toastManager, ToastType } from "#components/ui/toast/toast-manager.ts";
import type { DeserializeResult } from "#lib/serialization/types.ts";
import {
  acquireSaveHandle,
  downloadBlob,
  openFile,
  requestWritePermission,
  writeToHandle,
} from "#lib/download.ts";
import { fileHandleStore } from "#lib/files/file-handle.ts";
import { generateFunFilename } from "#lib/files/random-filename.ts";

export async function importStudioWithToasts(
  source: Blob | ArrayBuffer,
  deserializeCanvas: (source: Blob | ArrayBuffer) => Promise<DeserializeResult>,
): Promise<DeserializeResult> {
  return toastManager.promise(deserializeCanvas(source), {
    loading: { title: "Importing voidmesh workspace..." },
    success: (r) => {
      if (r.errors.length > 0) {
        const total = r.entityCount + r.errors.length;
        return {
          title: `Failed to import ${r.errors.length} of ${total} files`,
          type: ToastType.destructive,
        };
      }
      return { title: "Imported successfully", timeout: 2500 };
    },
    error: (err) => ({
      title: "Import failed",
      description: err instanceof Error ? err.message : "Unknown error",
      type: ToastType.destructive,
    }),
  });
}

async function serializeAndSave(
  serializeCanvas: () => Promise<Blob>,
  handle: FileSystemFileHandle,
  name: string,
): Promise<string> {
  const blob = await serializeCanvas();
  const ok = await writeToHandle(blob, handle);
  if (!ok) throw new Error("Failed to write to file");
  return name;
}

async function serializeAndDownload(serializeCanvas: () => Promise<Blob>): Promise<string> {
  const blob = await serializeCanvas();
  const name = await generateFunFilename();
  downloadBlob(blob, name);
  return name;
}

export function useStudioFile() {
  const { serializeCanvas, deserializeCanvas } = useCanvas();
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const exportStudioFile = async () => {
    if (isExporting || isImporting) return;
    setIsExporting(true);

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
      setIsExporting(false);
    }
  };

  const saveAsStudioFile = async () => {
    if (isExporting || isImporting) return;
    setIsExporting(true);

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
      setIsExporting(false);
    }
  };

  const importStudioFile = (onSuccess?: () => void) => {
    if (isExporting || isImporting) return;

    setIsImporting(true);
    openFile()
      .then(async (file) => {
        if (!file) {
          setIsImporting(false);
          return;
        }
        try {
          const result = await importStudioWithToasts(file, deserializeCanvas);
          if (result.success) onSuccess?.();
        } catch {
          // Error already displayed by importStudioWithToasts
        } finally {
          setIsImporting(false);
        }
      })
      .catch(() => {
        setIsImporting(false);
      });
  };

  return {
    exportStudioFile,
    saveAsStudioFile,
    importStudioFile,
    isExporting,
    isImporting,
  };
}
