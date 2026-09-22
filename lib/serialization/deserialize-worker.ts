import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";

interface StartRequest {
  type: "start";
  source: Blob | ArrayBuffer;
}

interface AckRequest {
  type: "ack";
}

interface EntryDoneRequest {
  type: "entry-done";
  path: string;
}

interface CancelRequest {
  type: "cancel";
}

type WorkerRequest = StartRequest | AckRequest | EntryDoneRequest | CancelRequest;

function reportWorkerLog(
  level: "debug" | "error",
  message: string,
  details?: Record<string, unknown>,
): void {
  self.postMessage({ type: "worker-log", level, message, details });
}

self.onerror = (message, source, lineno, colno, error) => {
  reportWorkerLog("error", "Unhandled deserialize worker exception", {
    message: String(message),
    source: String(source),
    lineno,
    colno,
    stack: error?.stack,
  });
  return false;
};

class RequestQueue {
  #queue: WorkerRequest[] = [];
  #waiters: Array<(message: WorkerRequest) => void> = [];

  constructor() {
    self.onmessage = (event: MessageEvent<WorkerRequest>) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(event.data);
      else this.#queue.push(event.data);
    };
  }

  next(): Promise<WorkerRequest> {
    const message = this.#queue.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

class WorkerControl {
  #requests: RequestQueue;
  #entryDone: EntryDoneQueue;
  #resolveAck: (() => void) | null = null;
  #rejectAck: ((error: Error) => void) | null = null;
  #failed: Error | null = null;

  constructor(requests: RequestQueue, entryDone: EntryDoneQueue) {
    this.#requests = requests;
    this.#entryDone = entryDone;
    void this.#dispatch();
  }

  waitForAck(): Promise<void> {
    if (this.#failed) return Promise.reject(this.#failed);
    return new Promise((resolve, reject) => {
      this.#resolveAck = resolve;
      this.#rejectAck = reject;
    });
  }

  fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = error;
    this.#rejectAck?.(error);
    this.#resolveAck = null;
    this.#rejectAck = null;
    this.#entryDone.cancel();
  }

  async #dispatch(): Promise<void> {
    while (!this.#failed) {
      const message = await this.#requests.next();
      if (message.type === "ack") {
        this.#resolveAck?.();
        this.#resolveAck = null;
        this.#rejectAck = null;
      } else if (message.type === "entry-done") {
        reportWorkerLog("debug", "page completed ZIP entry", { path: message.path });
        this.#entryDone.handle(message.path);
      } else if (message.type === "cancel") {
        reportWorkerLog("error", "page cancelled ZIP stream");
        this.fail(new Error("Workspace import cancelled"));
      }
    }
  }
}

class OutputQueue {
  #control: WorkerControl;
  #queue: Array<{ message: Record<string, unknown>; transfer?: ArrayBuffer[] }> = [];
  #inFlight: Promise<void> | null = null;
  #failed: Error | null = null;

  constructor(control: WorkerControl) {
    this.#control = control;
  }

  enqueue(message: Record<string, unknown>, transfer?: ArrayBuffer[]): void {
    if (this.#failed) throw this.#failed;
    this.#queue.push({ message, transfer });
    this.#startPump();
  }

  async idle(): Promise<void> {
    if (this.#failed) throw this.#failed;
    while (this.#queue.length > 0 || this.#inFlight) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.#failed) throw this.#failed;
    }
  }

  fail(error: Error): void {
    this.#failed = error;
    this.#queue.length = 0;
  }

  #startPump(): void {
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#inFlight || this.#queue.length === 0 || this.#failed) return;
    const item = this.#queue.shift()!;
    const inFlight = this.#send(item);
    this.#inFlight = inFlight;
    try {
      await inFlight;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.#inFlight = null;
    }
    if (!this.#failed) this.#startPump();
  }

  async #send(item: { message: Record<string, unknown>; transfer?: ArrayBuffer[] }): Promise<void> {
    self.postMessage(item.message, item.transfer ?? []);
    await this.#control.waitForAck();
  }
}

class EntryDoneQueue {
  #waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  #completed = new Set<string>();
  #cancelled = false;

  handle(path: string): void {
    const waiter = this.#waiters.get(path);
    if (waiter) {
      waiter.resolve();
      this.#waiters.delete(path);
    } else {
      this.#completed.add(path);
    }
  }

  cancel(): void {
    this.#cancelled = true;
    for (const waiter of this.#waiters.values()) {
      waiter.reject(new Error("Workspace import cancelled"));
    }
    this.#waiters.clear();
  }

  wait(path: string): Promise<void> {
    if (this.#cancelled) return Promise.reject(new Error("Workspace import cancelled"));
    if (this.#completed.delete(path)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#waiters.set(path, { resolve, reject });
    });
  }
}

const requests = new RequestQueue();

void run();

async function run(): Promise<void> {
  let stage = "waiting-for-start";
  const request = await requests.next();
  if (request.type !== "start") {
    const message = "Deserialize worker did not receive start";
    reportWorkerLog("error", message);
    self.postMessage({ type: "error", message, stage });
    return;
  }

  reportWorkerLog("debug", "deserialize worker started");
  const entryDone = new EntryDoneQueue();
  const control = new WorkerControl(requests, entryDone);
  const output = new OutputQueue(control);
  const pendingFiles: UnzipFile[] = [];
  let drainFilesPromise: Promise<void> | null = null;
  let failed: Error | null = null;

  const unzip = new Unzip((file) => {
    if (failed) return;
    pendingFiles.push(file);
    if (!drainFilesPromise) {
      drainFilesPromise = drainFiles()
        .catch((error) => {
          failed = error instanceof Error ? error : new Error(String(error));
          throw failed;
        })
        .finally(() => {
          drainFilesPromise = null;
        });
    }
  });
  unzip.register(UnzipPassThrough);
  // This worker is already off the page's main thread. The async inflater
  // creates another worker, which can stall on iOS and older compressed files.
  unzip.register(UnzipInflate);

  try {
    stage = "opening source stream";
    const source = request.source instanceof Blob ? request.source : new Blob([request.source]);
    const reader = source.stream().getReader();
    reportWorkerLog("debug", "source stream opened", {
      sourceType: request.source instanceof Blob ? "blob" : "array-buffer",
    });
    try {
      while (true) {
        const result = await reader.read();
        stage = "feeding ZIP decoder";
        unzip.push(result.value ?? new Uint8Array(0), result.done);
        if (result.done) break;
      }
    } finally {
      reader.releaseLock();
    }

    if (drainFilesPromise) await drainFilesPromise;
    if (failed) throw failed;
    stage = "waiting for ZIP output acknowledgements";
    await output.idle();
    reportWorkerLog("debug", "archive stream completed");
    self.postMessage({ type: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    reportWorkerLog("error", message, { stage, stack });
    self.postMessage({ type: "error", message, stage, stack });
  }

  async function drainFiles(): Promise<void> {
    while (pendingFiles.length > 0) {
      const file = pendingFiles.shift()!;
      stage = `streaming ZIP entry ${file.name}`;
      reportWorkerLog("debug", "ZIP entry discovered", { path: file.name });
      await streamFile(file, output, entryDone);
    }
  }
}

async function streamFile(file: UnzipFile, output: OutputQueue, entryDone: EntryDoneQueue) {
  reportWorkerLog("debug", "starting ZIP entry", { path: file.name });
  let started = false;
  let resolveEntryEnd!: () => void;
  let rejectEntryEnd!: (error: Error) => void;
  const entryEnd = new Promise<void>((resolve, reject) => {
    resolveEntryEnd = resolve;
    rejectEntryEnd = reject;
  });
  file.ondata = (error, chunk, final) => {
    try {
      if (error) {
        rejectEntryEnd(error);
        return;
      }
      if (!started) {
        started = true;
        output.enqueue({ type: "entry-start", path: file.name });
      }
      if (chunk.length > 0) {
        const copy = chunk.slice();
        output.enqueue({ type: "entry-chunk", path: file.name, chunk: copy.buffer }, [copy.buffer]);
      }
      if (final) {
        output.enqueue({ type: "entry-end", path: file.name });
        resolveEntryEnd();
      }
    } catch (caught) {
      rejectEntryEnd(caught instanceof Error ? caught : new Error(String(caught)));
    }
  };
  file.start();
  // Compressed ZIP entries may not have all payload bytes available when
  // start() returns. The source reader must continue until ondata(final=true)
  // before we wait for page acknowledgement, otherwise decompression deadlocks.
  await entryEnd;
  await output.idle();
  reportWorkerLog("debug", "waiting for page to process completed ZIP entry", { path: file.name });
  await entryDone.wait(file.name);
  reportWorkerLog("debug", "finished ZIP entry", { path: file.name });
}
