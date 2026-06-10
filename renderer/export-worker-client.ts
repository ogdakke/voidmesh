import { createProgressChannel } from "./progress-channel.ts";
import type { ExportJobSnapshot } from "./export-snapshot.ts";
import type { FromExportWorkerMessage, ToExportWorkerMessage } from "./export.worker.ts";
import type { ExportProgress, VideoExportHandle } from "./video-exporter.ts";

export class WorkerExportUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerExportUnsupportedError";
  }
}

export function exportSnapshotInWorker(snapshot: ExportJobSnapshot): VideoExportHandle {
  let cancelled = false;
  let resolveResult: (blob: Blob) => void;
  let rejectResult: (error: Error) => void;

  const result = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const progress = createProgressChannel<ExportProgress>(
    (p) => p.stage === "done",
    () => cancelled,
  );
  const unsupported = (message: string): VideoExportHandle => {
    rejectResult!(new WorkerExportUnsupportedError(message));
    return {
      progress: progress.generator(),
      result,
      cancel: () => {
        cancelled = true;
        progress.wake();
      },
    };
  };

  if (typeof Worker === "undefined") {
    return unsupported("Web Workers are unavailable");
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./export.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export worker startup failed";
    return unsupported(message);
  }

  worker.onmessage = (event: MessageEvent<FromExportWorkerMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case "progress":
        progress.emit(msg.progress);
        break;
      case "done":
        progress.emit({ frame: 1, totalFrames: 1, percent: 1, stage: "done" });
        resolveResult!(msg.blob);
        worker.terminate();
        break;
      case "error": {
        cancelled = true;
        const error = msg.unsupported
          ? new WorkerExportUnsupportedError(msg.message)
          : new Error(msg.message);
        rejectResult!(error);
        progress.wake();
        worker.terminate();
        break;
      }
    }
  };

  worker.onerror = (event) => {
    cancelled = true;
    rejectResult!(new Error(event.message || "Export worker failed"));
    progress.wake();
    worker.terminate();
  };

  const start: ToExportWorkerMessage = { type: "start", job: snapshot };
  worker.postMessage(start);

  return {
    progress: progress.generator(),
    result,
    cancel: () => {
      cancelled = true;
      worker.terminate();
      progress.wake();
      rejectResult(new Error("Export cancelled"));
    },
  };
}
