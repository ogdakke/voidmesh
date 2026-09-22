/**
 * Streaming workspace serializer.
 *
 * The worker receives one Blob at a time, adds it to a streaming ZIP, and
 * forwards bounded output chunks to the download service worker. No complete
 * archive is retained in either the worker or the page.
 */

import { Zip, ZipPassThrough } from "fflate";
import type { SerializeMediaEntry } from "./types.ts";

function reportWorkerLog(stage: string, details: Record<string, unknown> = {}): void {
  self.postMessage({ type: "log", stage, ...details });
}

self.addEventListener("error", (event) => {
  const error = event as ErrorEvent;
  self.postMessage({
    type: "fatal-error",
    message: error.message || "Unknown worker error",
    filename: error.filename,
    lineno: error.lineno,
    colno: error.colno,
  });
});

self.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  self.postMessage({
    type: "fatal-error",
    message: reason instanceof Error ? reason.message : String(reason ?? "Unknown rejection"),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

interface StartRequest {
  type: "start";
  manifest: string;
  downloadPort: MessagePort;
}

interface MediaRequest {
  type: "media";
  entry: SerializeMediaEntry;
}

interface FinishRequest {
  type: "finish";
}

type WorkerRequest = StartRequest | MediaRequest | FinishRequest;

class MessageQueue {
  #messages: WorkerRequest[] = [];
  #waiters: Array<(message: WorkerRequest) => void> = [];

  constructor() {
    self.onmessage = (event: MessageEvent<WorkerRequest>) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(event.data);
      else this.#messages.push(event.data);
    };
  }

  next(): Promise<WorkerRequest> {
    const message = this.#messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

class DownloadSink {
  #port: MessagePort;
  #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #pending: Promise<void> = Promise.resolve();
  #ack: Promise<void> | null = null;
  #resolveAck!: () => void;
  #rejectAck!: (error: Error) => void;
  #closed: Promise<void>;
  #resolveClosed!: () => void;
  #rejectClosed!: (error: Error) => void;

  constructor(port: MessagePort) {
    this.#port = port;
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    port.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === "ready") this.#resolveReady();
      else if (message?.type === "ack") {
        this.#resolveAck?.();
        this.#ack = null;
      } else if (message?.type === "closed") this.#resolveClosed();
      else if (message?.type === "cancel") this.fail(new Error("Workspace download cancelled"));
      else if (message?.type === "error") this.fail(new Error(String(message.message)));
    };
    port.start();
  }

  async waitUntilReady(): Promise<void> {
    await this.#ready;
  }

  enqueue(chunk: Uint8Array): void {
    this.#pending = this.#pending.then(() => this.#send(chunk));
  }

  async waitUntilIdle(): Promise<void> {
    await this.#pending;
  }

  async finish(): Promise<void> {
    await this.#pending;
    this.#port.postMessage({ type: "complete" });
    await this.#closed;
    this.#port.close();
  }

  fail(error: Error): void {
    this.#rejectReady(error);
    this.#rejectAck?.(error);
    this.#rejectClosed(error);
    this.#pending = Promise.reject(error);
  }

  #send(chunk: Uint8Array): Promise<void> {
    this.#ack = new Promise((resolve, reject) => {
      this.#resolveAck = resolve;
      this.#rejectAck = reject;
    });
    const transferable = chunk.buffer as ArrayBuffer;
    this.#port.postMessage({ type: "chunk", chunk: transferable }, [transferable]);
    return this.#ack;
  }
}

const requests = new MessageQueue();
reportWorkerLog("started");

void (async () => {
  const first = await requests.next();
  if (first.type !== "start") {
    self.postMessage({ type: "error", message: "Serialization worker did not receive start" });
    return;
  }

  try {
    reportWorkerLog("received-start", { manifestBytes: first.manifest.length });
    const sink = new DownloadSink(first.downloadPort);
    await sink.waitUntilReady();
    reportWorkerLog("output-ready");
    const { zip, addBlob } = createZipWriter(sink);
    const manifest = new ZipPassThrough("manifest.json");
    zip.add(manifest);
    manifest.push(new TextEncoder().encode(first.manifest), true);
    await sink.waitUntilIdle();
    self.postMessage({ type: "ready-for-media" });

    while (true) {
      const request = await requests.next();
      if (request.type === "media") {
        reportWorkerLog("media-start", {
          path: request.entry.path,
          type: request.entry.type,
          sizeBytes: request.entry.blob.size,
        });
        await addBlob(request.entry);
        reportWorkerLog("media-complete", { path: request.entry.path });
        self.postMessage({ type: "media-done", path: request.entry.path });
      } else if (request.type === "finish") {
        reportWorkerLog("archive-finish");
        zip.end();
        await sink.waitUntilIdle();
        await sink.finish();
        self.postMessage({ type: "done" });
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportWorkerLog("failed", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    first.downloadPort.postMessage({ type: "error", message });
    self.postMessage({ type: "error", message });
  }
})();

function createZipWriter(sink: DownloadSink): {
  zip: Zip;
  addBlob: (entry: SerializeMediaEntry) => Promise<void>;
} {
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    if (chunk) sink.enqueue(chunk);
  });

  return {
    zip,
    addBlob: async (entry) => {
      const archiveFile = new ZipPassThrough(entry.path);
      zip.add(archiveFile);
      const reader = entry.blob.stream().getReader();

      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          archiveFile.push(result.value, false);
          await sink.waitUntilIdle();
        }
        archiveFile.push(new Uint8Array(0), true);
        await sink.waitUntilIdle();
      } finally {
        reader.releaseLock();
      }
    },
  };
}
