/**
 * Browser API mocks for Vitest happy-dom environment
 *
 * Vitest provides window/document/navigator via happy-dom automatically.
 * This file adds mocks for APIs that happy-dom doesn't implement.
 */

import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";

type WorkerMessage = Record<string, unknown>;

class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  #terminated = false;
  #url: string;
  #requests: WorkerMessage[] = [];
  #requestWaiters: Array<(message: WorkerMessage) => void> = [];
  #outputTail: Promise<void> = Promise.resolve();

  constructor(url: string | URL) {
    this.#url = String(url);
  }

  postMessage(message: { type?: string; source?: Blob | ArrayBuffer }): void {
    if (this.#terminated) return;
    if (message.type === "start" && this.#url.includes("deserialize-worker")) {
      void this.#runDeserializer(message.source!);
      return;
    }
    const waiter = this.#requestWaiters.shift();
    if (waiter) waiter(message as WorkerMessage);
    else this.#requests.push(message as WorkerMessage);
  }

  terminate(): void {
    this.#terminated = true;
  }

  async #runDeserializer(source: Blob | ArrayBuffer): Promise<void> {
    try {
      const buffer = source instanceof Blob ? await source.arrayBuffer() : source;
      const pendingFiles: UnzipFile[] = [];
      let drainFilesPromise: Promise<void> | null = null;
      let failed: Error | null = null;
      const unzip = new Unzip((file) => {
        if (failed) return;
        pendingFiles.push(file);
        if (!drainFilesPromise) {
          drainFilesPromise = this.#drainFiles(pendingFiles)
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
      unzip.register(UnzipInflate);

      const bytes = new Uint8Array(buffer);
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const end = Math.min(offset + 64 * 1024, bytes.length);
        unzip.push(bytes.subarray(offset, end), end === bytes.length);
      }
      if (drainFilesPromise) await drainFilesPromise;
      if (failed) throw failed;
      await this.#outputTail;
      if (!this.#terminated) this.onmessage?.({ data: { type: "done" } } as MessageEvent);
    } catch (error) {
      if (!this.#terminated) {
        this.onerror?.({ message: error instanceof Error ? error.message : String(error) } as ErrorEvent);
      }
    }
  }

  async #drainFiles(pendingFiles: UnzipFile[]): Promise<void> {
    while (pendingFiles.length > 0) {
      const file = pendingFiles.shift()!;
      await this.#streamFile(file);
    }
  }

  async #streamFile(file: UnzipFile): Promise<void> {
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
          void this.#sendOutput({ type: "entry-start", path: file.name }).catch(rejectEntryEnd);
        }
        if (chunk.length > 0) {
          const copy = chunk.slice();
          void this.#sendOutput({ type: "entry-chunk", path: file.name, chunk: copy.buffer }).catch(
            rejectEntryEnd,
          );
        }
        if (final) {
          void this.#sendOutput({ type: "entry-end", path: file.name }).then(
            resolveEntryEnd,
            rejectEntryEnd,
          );
        }
      } catch (caught) {
        rejectEntryEnd(caught instanceof Error ? caught : new Error(String(caught)));
      }
    };

    file.start();
    await entryEnd;
    const completion = await this.#nextRequest();
    if (completion.type !== "entry-done" || completion.path !== file.name) {
      throw new Error(`Unexpected worker response for ${file.name}`);
    }
  }

  #sendOutput(message: WorkerMessage): Promise<void> {
    const send = this.#outputTail.then(async () => {
      this.onmessage?.({ data: message } as MessageEvent);
      const response = await this.#nextRequest();
      if (response.type !== "ack") {
        throw new Error(`Unexpected worker response: ${String(response.type)}`);
      }
    });
    this.#outputTail = send;
    return send;
  }

  #nextRequest(): Promise<WorkerMessage> {
    const message = this.#requests.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.#requestWaiters.push(resolve));
  }
}

Object.defineProperty(globalThis, "Worker", {
  configurable: true,
  writable: true,
  value: TestWorker,
});

// Mock navigator.gpu as undefined by default (WebGPU not available in happy-dom)
Object.defineProperty(navigator, "gpu", {
  value: undefined,
  writable: true,
  configurable: true,
});

// Mock window.matchMedia for responsive components
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }),
});

// Mock ResizeObserver for react-resizable-panels
class MockResizeObserver {
  callback: ResizeObserverCallback;
  observedElements: Set<Element> = new Set();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.observedElements.add(target);
  }

  unobserve(target: Element) {
    this.observedElements.delete(target);
  }

  disconnect() {
    this.observedElements.clear();
  }
}

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: MockResizeObserver,
});

// Mock IntersectionObserver
class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  observedElements: Set<Element> = new Set();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.observedElements.add(target);
  }

  unobserve(target: Element) {
    this.observedElements.delete(target);
  }

  disconnect() {
    this.observedElements.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  get root() {
    return null;
  }

  get rootMargin() {
    return "0px";
  }

  get thresholds() {
    return [0];
  }
}

Object.defineProperty(window, "IntersectionObserver", {
  writable: true,
  value: MockIntersectionObserver,
});
