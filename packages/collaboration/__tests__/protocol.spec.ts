import { describe, expect, it } from "vitest";
import {
  COLLABORATION_PROTOCOL_VERSION,
  initialEntityRevisions,
  isPlaybackAnchor,
  isTimeDependentShader,
  parseClientClockPingMessage,
  parseClientDurableMessage,
  parseClientPresenceMessage,
  type HostedSceneEntityInput,
} from "../src/index.ts";

const operationId = "550e8400-e29b-41d4-a716-446655440000";

function entity(): HostedSceneEntityInput {
  return {
    asset: {
      byteLength: 42,
      contentType: "image/png",
      id: "asset-1",
      mediaType: "image",
      originalFilename: "source.png",
    },
    edited: false,
    generation: 0,
    id: "entity-1",
    locked: false,
    name: "Source",
    originalSize: { height: 100, width: 200 },
    position: { x: 1, y: 2 },
    rotation: 0,
    shaderParams: {
      background: [0, 0, 0, 1],
      color: [1, 1, 1, 1],
      intensity: 1,
      preserveColors: false,
      reversePalette: false,
      scale: 1,
      shape: "circle",
      showOriginal: false,
      size: 1,
    },
    shaderType: "dithering",
    size: { height: 100, width: 200 },
    zIndex: 1,
  };
}

describe("hosted collaboration protocol", () => {
  it("uses protocol version 5 for typed scene commands", () => {
    expect(COLLABORATION_PROTOCOL_VERSION).toBe(5);
  });

  it("accepts bounded room-clock pings", () => {
    expect(
      parseClientClockPingMessage(
        JSON.stringify({ clientTime: Date.now(), requestId: operationId, type: "clock-ping" }),
      ),
    ).toMatchObject({ requestId: operationId, type: "clock-ping" });
    expect(
      parseClientClockPingMessage(
        JSON.stringify({ clientTime: 0, requestId: operationId, type: "clock-ping" }),
      ),
    ).toBeNull();
  });

  it("accepts typed entity creation and rejects generic document data", () => {
    expect(
      parseClientDurableMessage(
        JSON.stringify({
          command: { entity: entity(), kind: "entity.create", operationId },
          type: "scene-command",
        }),
      ),
    ).toMatchObject({ command: { kind: "entity.create", operationId } });
    expect(
      parseClientDurableMessage(
        JSON.stringify({ type: "scene-command", update: [1, 2, 3], operationId }),
      ),
    ).toBeNull();
  });

  it("requires expected grouped revisions for patches", () => {
    expect(
      parseClientDurableMessage(
        JSON.stringify({
          command: {
            entityId: "entity-1",
            expected: { geometry: 0 },
            generation: 0,
            kind: "entity.patch",
            operationId,
            patch: {
              geometry: {
                originalSize: { height: 100, width: 200 },
                position: { x: 3, y: 4 },
                rotation: 0,
                size: { height: 100, width: 200 },
              },
            },
          },
          type: "scene-command",
        }),
      ),
    ).toMatchObject({ command: { expected: { geometry: 0 }, kind: "entity.patch" } });
  });

  it("recognizes only flowing glass as time-dependent", () => {
    expect(isTimeDependentShader(entity())).toBe(false);
    expect(
      isTimeDependentShader({
        shaderParams: { ...entity().shaderParams, glass: { kind: "flowing" } },
        shaderType: "glass",
      }),
    ).toBe(true);
    expect(initialEntityRevisions()).toEqual({
      appearance: 0,
      asset: 0,
      geometry: 0,
      identity: 0,
      layering: 0,
    });
  });

  it("accepts playback anchors stamped with a real room-clock timestamp", () => {
    expect(
      isPlaybackAnchor({
        commandId: "playback-command-1",
        duration: 30,
        effectiveAtRoomMs: Date.now(),
        entityId: "entity-1",
        loop: true,
        mediaRevision: 0,
        playbackRate: 1,
        positionSeconds: 4,
        sequence: 2,
        state: "playing",
        type: "media",
      }),
    ).toBe(true);
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
