import { describe, expect, it, vi } from "vitest";
import {
  COLLABORATION_PROTOCOL_VERSION,
  type ClientDurableMessage,
  type ServerConflictMessage,
  type ServerPlaybackMessage,
  type ServerScenePatchMessage,
  type ServerSceneSnapshotMessage,
} from "../src/index.ts";
import { HostedCollaborationProvider, type PendingCommandStore } from "../src/provider.ts";

class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith: number | null = null;

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(value: string): void {
    this.sent.push(value);
  }

  receive(value: object): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.closedWith = code;
    this.readyState = 3;
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }
}

class FakeStore implements PendingCommandStore {
  commands: ClientDurableMessage[] = [];

  async load(): Promise<ClientDurableMessage[]> {
    return structuredClone(this.commands);
  }

  async save(commands: readonly ClientDurableMessage[]): Promise<void> {
    this.commands = [...structuredClone(commands)];
  }
}

function synchronize(socket: FakeSocket): void {
  socket.receive({
    connectionId: "connection-1",
    peers: [],
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    role: "owner",
    roomSequence: 0,
    serverTime: Date.now(),
    type: "hello",
    user: { color: "red", name: "Owner", userId: "user-1" },
  });
  socket.receive({ entities: [], playback: [], roomSequence: 0, type: "scene-snapshot" });
}

function command(operationId: string) {
  return {
    entities: [],
    kind: "scene.replace" as const,
    operationId,
  };
}

function playbackCommand(commandId: string, positionSeconds: number, state = "paused" as const) {
  return {
    commandId,
    duration: 10,
    entityId: "entity-1",
    loop: true,
    mediaRevision: 0,
    playbackRate: 1,
    positionSeconds,
    state,
    type: "media" as const,
  };
}

describe("HostedCollaborationProvider", () => {
  it("restores pending commands and sends them one at a time after the snapshot", async () => {
    const store = new FakeStore();
    store.commands = [{ command: command("offline-1"), type: "scene-command" }];
    const socket = new FakeSocket();
    const provider = new HostedCollaborationProvider({
      pendingStore: store,
      socketFactory: () => socket as unknown as WebSocket,
    });
    provider.connect();
    await vi.waitFor(() => expect(provider.status).toBe("connecting"));
    socket.open();
    synchronize(socket);

    await vi.waitFor(() =>
      expect(
        socket.sent.some((value) => JSON.parse(value).command?.operationId === "offline-1"),
      ).toBe(true),
    );
    provider.submitSceneCommand(command("offline-2"));
    expect(
      socket.sent.some((value) => JSON.parse(value).command?.operationId === "offline-2"),
    ).toBe(false);

    socket.receive({ operationId: "offline-1", roomSequence: 1, type: "ack" });
    await vi.waitFor(() =>
      expect(
        socket.sent.some((value) => JSON.parse(value).command?.operationId === "offline-2"),
      ).toBe(true),
    );
    expect(store.commands).toHaveLength(1);
    provider.destroy();
  });

  it("publishes snapshots, narrow patches, and playback separately", async () => {
    const socket = new FakeSocket();
    const snapshots = vi.fn<(message: ServerSceneSnapshotMessage) => void>();
    const patches = vi.fn<(message: ServerScenePatchMessage) => void>();
    const playback = vi.fn<(message: ServerPlaybackMessage) => void>();
    const provider = new HostedCollaborationProvider({
      socketFactory: () => socket as unknown as WebSocket,
    });
    provider.onSnapshot(snapshots);
    provider.onPatch(patches);
    provider.onPlayback(playback);
    provider.connect();
    await vi.waitFor(() => expect(provider.status).toBe("connecting"));
    socket.open();
    synchronize(socket);
    socket.receive({
      changes: [],
      operationId: "operation-1",
      roomSequence: 1,
      type: "scene-patch",
    });
    socket.receive({
      anchor: {
        commandId: "playback-1",
        duration: 10,
        effectiveAtRoomMs: Date.now(),
        entityId: "entity-1",
        loop: true,
        mediaRevision: 0,
        playbackRate: 1,
        positionSeconds: 2,
        sequence: 2,
        state: "playing",
        type: "media",
      },
      roomSequence: 2,
      type: "playback",
    });

    expect(snapshots).toHaveBeenCalledOnce();
    expect(patches).toHaveBeenCalledOnce();
    expect(playback).toHaveBeenCalledOnce();
    provider.destroy();
  });

  it("treats a local scene patch as a durable acceptance before the ack arrives", async () => {
    const store = new FakeStore();
    const socket = new FakeSocket();
    const patches = vi.fn<(message: ServerScenePatchMessage, origin: "local" | "remote") => void>();
    const provider = new HostedCollaborationProvider({
      pendingStore: store,
      socketFactory: () => socket as unknown as WebSocket,
    });
    provider.onPatch(patches);
    provider.connect();
    await vi.waitFor(() => expect(provider.status).toBe("connecting"));
    socket.open();
    synchronize(socket);
    provider.submitSceneCommand(command("accepted-before-ack"));

    const patch: ServerScenePatchMessage = {
      changes: [],
      operationId: "accepted-before-ack",
      roomSequence: 1,
      type: "scene-patch",
    };
    socket.receive(patch);

    await vi.waitFor(() => expect(store.commands).toEqual([]));
    expect(patches).toHaveBeenCalledWith(patch, "local");
    provider.destroy();
  });

  it("coalesces queued playback intent and does not replay an optimistic command locally", async () => {
    const socket = new FakeSocket();
    const playback = vi.fn<(message: ServerPlaybackMessage) => void>();
    const provider = new HostedCollaborationProvider({
      socketFactory: () => socket as unknown as WebSocket,
    });
    provider.onPlayback(playback);
    provider.connect();
    await vi.waitFor(() => expect(provider.status).toBe("connecting"));
    socket.open();
    synchronize(socket);
    await vi.waitFor(() => expect(provider.status).toBe("connected"));

    provider.submitPlaybackCommand(playbackCommand("scrub-1", 1));
    provider.submitPlaybackCommand(playbackCommand("scrub-2", 2));
    provider.submitPlaybackCommand(playbackCommand("scrub-3", 3));
    expect(
      socket.sent.filter((value) => JSON.parse(value).type === "playback-command"),
    ).toHaveLength(1);

    socket.receive({
      anchor: {
        ...playbackCommand("scrub-1", 1),
        effectiveAtRoomMs: Date.now(),
        sequence: 1,
      },
      roomSequence: 1,
      type: "playback",
    });
    expect(playback).not.toHaveBeenCalled();
    socket.receive({ operationId: "scrub-1", roomSequence: 1, type: "ack" });

    await vi.waitFor(() =>
      expect(
        socket.sent
          .map((value) => JSON.parse(value))
          .filter((value) => value.type === "playback-command")
          .map((value) => value.command.commandId),
      ).toEqual(["scrub-1", "scrub-3"]),
    );
    expect(socket.sent.some((value) => JSON.parse(value).command?.commandId === "scrub-2")).toBe(
      false,
    );
    provider.destroy();
  });

  it("compacts a restored scrub backlog before reconnecting", async () => {
    const store = new FakeStore();
    store.commands = [
      { command: playbackCommand("restored-1", 1), type: "playback-command" },
      { command: playbackCommand("restored-2", 2), type: "playback-command" },
      { command: playbackCommand("restored-3", 3), type: "playback-command" },
    ];
    const socket = new FakeSocket();
    const provider = new HostedCollaborationProvider({
      pendingStore: store,
      socketFactory: () => socket as unknown as WebSocket,
    });
    provider.connect();
    await vi.waitFor(() => expect(provider.status).toBe("connecting"));
    socket.open();
    synchronize(socket);

    await vi.waitFor(() =>
      expect(
        socket.sent
          .map((value) => JSON.parse(value))
          .find((value) => value.type === "playback-command")?.command.commandId,
      ).toBe("restored-3"),
    );
    expect(store.commands).toHaveLength(1);
    provider.destroy();
  });

  it("removes conflicted commands without retrying forever", async () => {
    const store = new FakeStore();
    const socket = new FakeSocket();
    const onConflict = vi.fn<(message: ServerConflictMessage) => void>();
    const provider = new HostedCollaborationProvider({
      onConflict,
      pendingStore: store,
      socketFactory: () => socket as unknown as WebSocket,
    });
    provider.connect();
    await vi.waitFor(() => expect(provider.status).toBe("connecting"));
    socket.open();
    synchronize(socket);
    provider.submitSceneCommand(command("conflict-1"));
    socket.receive({
      operationId: "conflict-1",
      reason: "revision",
      roomSequence: 4,
      type: "conflict",
    });

    await vi.waitFor(() => expect(store.commands).toEqual([]));
    expect(onConflict).toHaveBeenCalledOnce();
    provider.destroy();
  });

  it("applies live role changes and treats membership revocation as terminal", async () => {
    const socket = new FakeSocket();
    let socketCreations = 0;
    const roles: string[] = [];
    const provider = new HostedCollaborationProvider({
      socketFactory: () => {
        socketCreations += 1;
        return socket as unknown as WebSocket;
      },
    });
    provider.onRole((role) => roles.push(role));
    provider.connect();
    await vi.waitFor(() => expect(provider.status).toBe("connecting"));
    socket.open();
    socket.receive({ role: "viewer", type: "role-changed" });
    expect(roles).toEqual(["viewer"]);

    socket.close(4003);
    expect(provider.status).toBe("revoked");
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(socketCreations).toBe(1);
    provider.destroy();
  });
});
