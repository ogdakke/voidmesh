import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";

const serviceWorkerSource = await readFile(
  resolve(import.meta.dirname, "../../public/voidmesh-download-sw.js"),
  "utf8",
);

describe("workspace download service worker", () => {
  test("waits for the stream session and returns ZIP bytes instead of the app shell", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const serviceWorker = {
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners.set(type, listener);
      },
    };

    runInNewContext(serviceWorkerSource, {
      self: serviceWorker,
      Error,
      Map,
      Promise,
      ReadableStream,
      Response,
      URL,
      Uint8Array,
      clearTimeout,
      console,
      setTimeout,
    });

    const messages: unknown[] = [];
    const messageWaiters: Array<(message: unknown) => void> = [];
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      const waiter = messageWaiters.shift();
      if (waiter) waiter(event.data);
      else messages.push(event.data);
    };
    channel.port1.start();

    const nextMessage = (): Promise<any> => {
      const message = messages.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve) => messageWaiters.push(resolve));
    };

    let responsePromise!: Promise<Response>;
    listeners.get("fetch")!({
      request: new Request("https://voidmesh.test/__voidmesh-download/test-token"),
      respondWith(response: Response | Promise<Response>) {
        responsePromise = Promise.resolve(response);
      },
    });

    listeners.get("message")!({
      data: { type: "open", token: "test-token", filename: "canvas.vdmsh" },
      ports: [channel.port2],
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.vdmsh");
    expect(response.headers.get("content-disposition")).toContain("canvas.vdmsh");

    const reader = response.body!.getReader();
    expect(await nextMessage()).toEqual({ type: "ready" });

    const bytes = new Uint8Array([1, 2, 3]);
    channel.port1.postMessage({ type: "chunk", chunk: bytes.buffer }, [bytes.buffer]);
    expect(await nextMessage()).toEqual({ type: "ack" });
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array([1, 2, 3]),
    });

    channel.port1.postMessage({ type: "complete" });
    expect(await nextMessage()).toEqual({ type: "closed" });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    channel.port1.close();
  });
});
