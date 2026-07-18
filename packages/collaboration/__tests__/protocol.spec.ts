import { describe, expect, it } from "vitest";
import {
  COLLABORATION_PROTOCOL_VERSION,
  decodeClientYjsRebase,
  decodeClientYjsUpdate,
  decodeServerYjsRebase,
  decodeServerYjsUpdate,
  encodeClientYjsRebase,
  encodeClientYjsUpdate,
  encodeServerYjsRebase,
  encodeServerYjsUpdate,
  parseClientPresenceMessage,
  parseClientClockPingMessage,
} from "../src/index.ts";

const updateId = "550e8400-e29b-41d4-a716-446655440000";

describe("hosted collaboration protocol", () => {
  it("uses protocol version 4 for recoverable document synchronization", () => {
    expect(COLLABORATION_PROTOCOL_VERSION).toBe(4);
  });

  it("accepts bounded room-clock pings", () => {
    expect(
      parseClientClockPingMessage(
        JSON.stringify({
          clientTime: Date.now(),
          requestId: updateId,
          type: "clock-ping",
        }),
      ),
    ).toMatchObject({ requestId: updateId, type: "clock-ping" });
    expect(
      parseClientClockPingMessage(
        JSON.stringify({
          clientTime: 0,
          requestId: updateId,
          type: "clock-ping",
        }),
      ),
    ).toBeNull();
  });
  it("round-trips client and server Yjs frames", () => {
    const update = new Uint8Array([1, 2, 3]);
    expect(decodeClientYjsUpdate(encodeClientYjsUpdate(updateId, update))).toEqual({
      update,
      updateId,
    });
    expect(decodeServerYjsUpdate(encodeServerYjsUpdate(42, updateId, update))).toEqual({
      roomSequence: 42,
      update,
      updateId,
    });
    expect(decodeClientYjsRebase(encodeClientYjsRebase(updateId, update))).toEqual({
      update,
      updateId,
    });
    expect(decodeServerYjsRebase(encodeServerYjsRebase(42, updateId, update))).toEqual({
      roomSequence: 42,
      update,
      updateId,
    });
  });

  it("accepts bounded cursor and selection presence", () => {
    expect(
      parseClientPresenceMessage(
        JSON.stringify({
          cursor: { x: 1, y: 2 },
          selectedEntityIds: ["entity-1"],
          sequence: 3,
          type: "presence",
        }),
      ),
    ).toMatchObject({ sequence: 3, selectedEntityIds: ["entity-1"] });
    expect(
      parseClientPresenceMessage('{"type":"presence","sequence":-1,"cursor":null}'),
    ).toBeNull();
    expect(
      parseClientPresenceMessage(
        JSON.stringify({
          selectedEntityIds: Array.from({ length: 2_049 }, (_, index) => `entity-${index}`),
          sequence: 4,
          type: "presence",
        }),
      ),
    ).toBeNull();
  });
});
