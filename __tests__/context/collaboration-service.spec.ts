import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasStore } from "#engine";
import { CollaborationService } from "#context/collaboration-service.ts";
import { CollaborationDocument } from "#lib/collaboration/document.ts";
import { collaborationMetrics } from "#lib/collaboration/metrics.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  createCollaborativeEntity,
  type CollaborationInvite,
} from "#lib/collaboration/protocol.ts";
import { getEntityThumbhash } from "#lib/thumbhash.ts";
import type { IceServerProvider } from "#lib/collaboration/ice-server-provider.ts";
import { createTestEntity } from "../helpers/test-entity.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";

const joinRoom = vi.hoisted(() => vi.fn<(...args: unknown[]) => FakeRoom>());

vi.mock("trystero", () => ({ selfId: "local-peer", joinRoom }));

interface FakeAction {
  send: ReturnType<typeof vi.fn<FakeSend>>;
  onMessage: ((value: never, context: { peerId: string; metadata?: unknown }) => void) | null;
  onReceiveProgress:
    | ((progress: number, context: { peerId: string; metadata?: unknown }) => void)
    | null;
}

interface FakeRoom {
  actions: Map<string, FakeAction>;
  leave: ReturnType<typeof vi.fn<() => void>>;
  getPeers: () => Record<string, RTCPeerConnection>;
  ping: ReturnType<typeof vi.fn<(peerId: string) => Promise<number>>>;
  makeAction: (name: string) => FakeAction;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
}

type CanvasAdapter = Parameters<CollaborationService["configure"]>[0];

interface FakeSendOptions {
  target?: unknown;
  onProgress?: (progress: number, context: { peerId: unknown }) => void;
}

type FakeSend = (value: unknown, options?: FakeSendOptions) => Promise<void>;

const invite = (roomId: string): CollaborationInvite => ({
  version: COLLABORATION_PROTOCOL_VERSION,
  roomId,
  password: `password-${roomId}`,
});

const iceServerProvider: IceServerProvider = {
  getCredentials: vi.fn<IceServerProvider["getCredentials"]>(async () => ({
    iceServers: [{ urls: "turn:turn.example.test", username: "user", credential: "credential" }],
    expiresAt: Date.now() + 3_600_000,
  })),
};

function createFakeRoom(): FakeRoom {
  const actions = new Map<string, FakeAction>();
  return {
    actions,
    leave: vi.fn<() => void>(),
    getPeers: () => ({}),
    ping: vi.fn<(peerId: string) => Promise<number>>(async () => 1),
    makeAction(name) {
      const action: FakeAction = {
        send: vi.fn<FakeSend>(async (_value, options) => {
          options?.onProgress?.(1, { peerId: options.target ?? "peer" });
        }),
        onMessage: null,
        onReceiveProgress: null,
      };
      actions.set(name, action);
      return action;
    },
    onPeerJoin: null,
    onPeerLeave: null,
  };
}

function createAdapter(overrides: Partial<CanvasAdapter> = {}): CanvasAdapter {
  return {
    adoptRemotePlaceholders: vi.fn<CanvasAdapter["adoptRemotePlaceholders"]>(async () => ({
      decodeDurationMs: 0,
    })),
    hydrateRemoteEntities: vi.fn<CanvasAdapter["hydrateRemoteEntities"]>(async () => ({
      decodeDurationMs: 0,
    })),
    applyRemotePlayback: vi.fn<CanvasAdapter["applyRemotePlayback"]>(async () => undefined),
    applyRemoteShaderPlayback: vi.fn<CanvasAdapter["applyRemoteShaderPlayback"]>(),
    updateRemotePresence: vi.fn<CanvasAdapter["updateRemotePresence"]>(),
    removeRemotePresence: vi.fn<CanvasAdapter["removeRemotePresence"]>(),
    clearRemotePresence: vi.fn<CanvasAdapter["clearRemotePresence"]>(),
    updateRemoteEntity: vi.fn<CanvasAdapter["updateRemoteEntity"]>(async () => undefined),
    removeRemoteEntities: vi.fn<CanvasAdapter["removeRemoteEntities"]>(),
    updateRemotePalettes: vi.fn<CanvasAdapter["updateRemotePalettes"]>(),
    ...overrides,
  };
}

function createRemoteDocument(entityCount: number): CollaborationDocument {
  const document = new CollaborationDocument({ sourceId: "remote-peer" });
  for (let index = 0; index < entityCount; index++) {
    const entity = createTestEntity({ id: `remote-${index}` });
    document.addEntity(
      createCollaborativeEntity(entity, {
        transferId: `transfer-${index}`,
        mimeType: "image/png",
        byteLength: 1,
        filename: entity.name,
        preview: getEntityThumbhash(entity),
      }),
    );
  }
  return document;
}

async function deliverDocument(room: FakeRoom, update: Uint8Array): Promise<void> {
  const handler = room.actions.get("document")?.onMessage;
  if (!handler) throw new Error("Document action was not configured");
  handler(update as never, { peerId: "remote-peer" });
  await vi.waitFor(() => {
    expect(collaborationMetrics.getSnapshot().documentUpdatesReceived).toBeGreaterThan(0);
  });
}

let cleanupCanvas: () => void;
let rooms: FakeRoom[];

beforeEach(() => {
  cleanupCanvas = setupCanvasTest();
  collaborationMetrics.reset();
  rooms = [];
  joinRoom.mockReset();
  joinRoom.mockImplementation(() => {
    const room = createFakeRoom();
    rooms.push(room);
    return room;
  });
});

afterEach(() => {
  collaborationMetrics.reset();
  cleanupCanvas();
  vi.restoreAllMocks();
});

describe("CollaborationService", () => {
  it("leaves a failed join retryable without reporting an active room", async () => {
    const service = new CollaborationService(iceServerProvider);
    service.configure(createAdapter());
    joinRoom.mockImplementationOnce(() => {
      throw new Error("signaling unavailable");
    });
    const failedInvite = invite("failed-room");

    await expect(service.start(failedInvite)).rejects.toThrow("signaling unavailable");

    expect(service.isActive).toBe(false);
    expect(service.invite).toEqual(failedInvite);
    expect(collaborationMetrics.getSnapshot()).toMatchObject({
      status: "error",
      lastErrorCode: "signaling-unavailable",
    });
    service.stop();
  });

  it("projects only the entity IDs changed by a remote transaction", async () => {
    const adapter = createAdapter();
    const service = new CollaborationService(iceServerProvider);
    service.configure(adapter);
    await service.start(invite("changed-ids"));
    const room = rooms[0]!;
    const remote = createRemoteDocument(1_000);

    await deliverDocument(room, remote.encodeState());
    await vi.waitFor(() => {
      expect(adapter.adoptRemotePlaceholders).toHaveBeenCalledOnce();
    });
    vi.mocked(adapter.adoptRemotePlaceholders).mockClear();

    const updates: Uint8Array[] = [];
    const unsubscribe = remote.onUpdate((update, isRemote) => {
      if (!isRemote) updates.push(update);
    });
    const changed = createTestEntity({ id: "remote-500", position: { x: 42, y: 84 } });
    remote.setGeometry(changed);
    await deliverDocument(room, updates.at(-1)!);

    await vi.waitFor(() => {
      expect(adapter.adoptRemotePlaceholders).toHaveBeenCalledWith(
        [expect.objectContaining({ id: "remote-500", position: { x: 42, y: 84 } })],
        expect.any(AbortSignal),
      );
    });
    unsubscribe();
    service.stop();
  });

  it("coalesces live shader scrubbing and flushes the final time", async () => {
    const service = new CollaborationService(iceServerProvider);
    service.configure(createAdapter());
    const entity = createTestEntity({ id: "live-shader-scrub" });
    canvasStore.addEntity(entity);
    await service.start(invite("shader-scrub"));
    const documentAction = rooms[0]!.actions.get("document")!;
    await vi.waitFor(() => expect(documentAction.send).toHaveBeenCalled());
    await vi.waitFor(() => expect(rooms[0]!.actions.get("inventory")?.send).toHaveBeenCalled());
    vi.mocked(documentAction.send).mockClear();

    for (let index = 1; index <= 20; index++) {
      const current = canvasStore.getState().entities.get(entity.id)!;
      canvasStore.updateEntities([
        {
          id: entity.id,
          updates: {
            shaderParams: { ...current.shaderParams, time: index / 10, timeAutoPlay: false },
          },
          syncShaderPlayback: true,
        },
      ]);
    }

    await vi.waitFor(() => expect(documentAction.send).toHaveBeenCalledTimes(1));

    const current = canvasStore.getState().entities.get(entity.id)!;
    canvasStore.updateEntities([
      {
        id: entity.id,
        updates: { shaderParams: { ...current.shaderParams, time: 2.5 } },
        syncShaderPlayback: true,
      },
    ]);
    canvasStore.commitShaderPlayback([entity.id]);

    expect(documentAction.send).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it("does not advertise assets retained from a previous room", async () => {
    const service = new CollaborationService(iceServerProvider);
    service.configure(createAdapter());
    canvasStore.addEntity(createTestEntity({ id: "room-one-asset" }));
    await service.start(invite("room-one"));
    const firstInventory = rooms[0]!.actions.get("inventory")!;
    await vi.waitFor(() => {
      expect(firstInventory.send).toHaveBeenCalledWith([expect.any(String)], {
        target: undefined,
      });
    });

    service.stop();
    canvasStore.reset();
    await service.start(invite("room-two"));
    const secondRoom = rooms[1]!;
    secondRoom.onPeerJoin?.("new-peer");

    await vi.waitFor(() => {
      expect(secondRoom.actions.get("inventory")?.send).toHaveBeenCalledWith([], {
        target: "new-peer",
      });
    });
    service.stop();
  });

  it("aborts an in-flight projection when the room stops", async () => {
    let resolveProjection = () => {};
    let projectionSignal: AbortSignal | null = null;
    const adapter = createAdapter({
      adoptRemotePlaceholders: vi.fn<CanvasAdapter["adoptRemotePlaceholders"]>(
        (_entities, signal) => {
          projectionSignal = signal;
          return new Promise<{ decodeDurationMs: number }>((resolve) => {
            resolveProjection = () => resolve({ decodeDurationMs: 0 });
          });
        },
      ),
    });
    const service = new CollaborationService(iceServerProvider);
    service.configure(adapter);
    await service.start(invite("cancel-projection"));

    await deliverDocument(rooms[0]!, createRemoteDocument(1).encodeState());
    await vi.waitFor(() => expect(adapter.adoptRemotePlaceholders).toHaveBeenCalledOnce());
    service.stop();
    resolveProjection();

    await vi.waitFor(() => expect(projectionSignal?.aborted).toBe(true));
    expect(adapter.hydrateRemoteEntities).not.toHaveBeenCalled();
    expect(collaborationMetrics.getSnapshot().status).toBe("idle");
  });
});
