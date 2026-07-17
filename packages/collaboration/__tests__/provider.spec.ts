import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  COLLABORATION_PROTOCOL_VERSION,
  base64UrlToBytes,
  bytesToBase64Url,
  decodeClientYjsUpdate,
} from "../src/index.ts";
import { HostedCollaborationProvider } from "../src/provider.ts";

class FakeSocket extends EventTarget {
  binaryType = "blob";
  readyState = 0;
  readonly sent: (string | ArrayBuffer)[] = [];

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(value: string | ArrayBuffer): void {
    this.sent.push(value);
  }

  receive(value: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }
}

describe("HostedCollaborationProvider", () => {
  it("uses the lowest-RTT recent room-clock sample and notifies playback projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const socket = new FakeSocket();
    const onClockSample = vi.fn();
    const provider = new HostedCollaborationProvider({
      document: new Y.Doc(),
      onClockSample,
      socketFactory: () => socket as unknown as WebSocket,
    });
    provider.connect();
    await Promise.resolve();
    socket.open();
    const firstPing = JSON.parse(socket.sent[0] as string);
    vi.setSystemTime(1_000_100);
    socket.receive(
      JSON.stringify({
        clientTime: firstPing.clientTime,
        requestId: firstPing.requestId,
        serverTime: 1_000_070,
        type: "clock-pong",
      }),
    );
    expect(provider.serverNow()).toBe(1_000_120);

    vi.advanceTimersByTime(15_000);
    const secondPing = JSON.parse(socket.sent.at(-1) as string);
    vi.setSystemTime(secondPing.clientTime + 20);
    socket.receive(
      JSON.stringify({
        clientTime: secondPing.clientTime,
        requestId: secondPing.requestId,
        serverTime: secondPing.clientTime + 30,
        type: "clock-pong",
      }),
    );
    expect(provider.serverNow()).toBe(secondPing.clientTime + 40);
    expect(onClockSample).toHaveBeenCalledTimes(2);
    provider.destroy();
    vi.useRealTimers();
  });

  it("publishes an IndexedDB-restored offline diff after the server state vector", async () => {
    const local = new Y.Doc();
    local.getMap("entities").set("offline-entity", { x: 1 });
    const server = new Y.Doc();
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const provider = new HostedCollaborationProvider({
      beforeSync: async () => {
        local.getMap("metadata").set("assetsReady", true);
      },
      document: local,
      persistenceReady: Promise.resolve(),
      socketFactory: () => socket as unknown as WebSocket,
    });
    provider.onStatus((status) => statuses.push(status));
    provider.connect();
    await Promise.resolve();
    socket.open();
    socket.receive(
      JSON.stringify({
        connectionId: "connection-1",
        peers: [],
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        role: "owner",
        roomSequence: 0,
        serverTime: Date.now(),
        type: "hello",
        user: { color: "red", name: "Owner", userId: "user-1" },
      }),
    );
    socket.receive(
      JSON.stringify({
        roomSequence: 0,
        stateVector: bytesToBase64Url(Y.encodeStateVector(server)),
        type: "sync-complete",
      }),
    );

    await vi.waitFor(() =>
      expect(socket.sent.some((value) => value instanceof ArrayBuffer)).toBe(true),
    );

    const frame = socket.sent.find((value): value is ArrayBuffer => value instanceof ArrayBuffer);
    expect(frame).toBeTruthy();
    const decoded = decodeClientYjsUpdate(frame!);
    expect(decoded).toBeTruthy();
    Y.applyUpdate(server, decoded!.update);
    expect(server.getMap("entities").get("offline-entity")).toEqual({ x: 1 });
    expect(server.getMap("metadata").get("assetsReady")).toBe(true);
    expect(statuses).toContain("connected");
    expect(base64UrlToBytes("not base64 !")).toBeNull();
    provider.destroy();
  });

  it("applies live role changes and treats membership revocation as terminal", async () => {
    const socket = new FakeSocket();
    let socketCreations = 0;
    const roles: string[] = [];
    const provider = new HostedCollaborationProvider({
      document: new Y.Doc(),
      socketFactory: () => {
        socketCreations += 1;
        return socket as unknown as WebSocket;
      },
    });
    provider.onRole((role) => roles.push(role));
    provider.connect();
    await Promise.resolve();
    socket.open();
    socket.receive(JSON.stringify({ role: "viewer", type: "role-changed" }));
    expect(roles).toEqual(["viewer"]);

    socket.close(4003);
    expect(provider.status).toBe("revoked");
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(socketCreations).toBe(1);
    provider.destroy();
  });
});
