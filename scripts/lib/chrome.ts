/** Headless Chrome helpers shared by the browser-driven scripts. */

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message: string; data?: string };
  method?: string;
  params?: unknown;
}

export async function resolveChromePath(): Promise<string> {
  const candidates = [
    process.env.BENCH_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Arc.app/Contents/MacOS/Arc",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter((candidate): candidate is string => !!candidate);

  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error("Could not find Chrome. Set BENCH_CHROME=/path/to/chrome.");
}

/** Minimal Chrome DevTools Protocol client over a page or browser websocket. */
export class CdpClient {
  #nextId = 1;
  #pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  #ws: WebSocket;

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      this.#handleMessage(event.data);
    });
    ws.addEventListener("error", () => {
      this.#rejectAll(new Error("Chrome DevTools websocket error"));
    });
    ws.addEventListener("close", () => {
      this.#rejectAll(new Error("Chrome DevTools websocket closed"));
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      ws.addEventListener("open", () => resolvePromise(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)), {
        once: true,
      });
    });
    return new CdpClient(ws);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const payload = params ? { id, method, params } : { id, method };
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject });
    });
  }

  close(): void {
    this.#ws.close();
  }

  #handleMessage(data: unknown): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as BufferSource);
    const message = JSON.parse(text) as CdpResponse;
    if (!message.id) return;

    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.data ?? message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
