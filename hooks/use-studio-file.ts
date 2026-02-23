import { useState } from "react";
import { useCanvas } from "../context/use-canvas.ts";
import { toastManager, ToastType } from "#components/ui/toast/toast-manager.ts";
import type { DeserializeResult } from "#lib/serialization/types.ts";

export async function importStudioWithToasts(
  source: Blob | ArrayBuffer,
  deserializeCanvas: (source: Blob | ArrayBuffer) => Promise<DeserializeResult>,
): Promise<DeserializeResult> {
  return toastManager.promise(deserializeCanvas(source), {
    loading: { title: "Importing vdmsh file…" },
    success: (r) => {
      if (r.errors.length > 0) {
        const total = r.entityCount + r.errors.length;
        return {
          title: `Failed to import ${r.errors.length} of ${total} entities`,
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

export function useStudioFile() {
  const { serializeCanvas, deserializeCanvas } = useCanvas();
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const exportStudioFile = async () => {
    if (isExporting || isImporting) return;
    setIsExporting(true);
    try {
      const blob = await toastManager.promise(serializeCanvas(), {
        loading: { title: "Exporting vdmsh file…" },
        success: () => ({ title: "Exported successfully" }),
        error: (err) => ({
          title: "Export failed",
          description: err instanceof Error ? err.message : "Unknown error",
          type: ToastType.destructive,
        }),
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "canvas.vdmsh";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Error already displayed by toastManager.promise
    } finally {
      setIsExporting(false);
    }
  };

  const importStudioFile = (onSuccess?: () => void) => {
    if (isExporting || isImporting) return;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".studio,.zip,.vdmsh";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      setIsImporting(true);
      try {
        const result = await importStudioWithToasts(file, deserializeCanvas);
        if (result.success) onSuccess?.();
      } catch {
        // Error already displayed by importStudioWithToasts
      } finally {
        setIsImporting(false);
      }
    };
    input.click();
  };

  return { exportStudioFile, importStudioFile, isExporting, isImporting };
}
