import { describe, expect, it } from "vitest";
import { createPeerIdentity, isCollaborationPresenceUpdate } from "#lib/collaboration/presence.ts";

describe("collaboration presence", () => {
  it("assigns stable shader-themed identities", () => {
    const first = createPeerIdentity("peer-one");
    expect(createPeerIdentity("peer-one")).toEqual(first);
    expect(first.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(first.color).toHaveLength(4);
  });

  it("validates partial presence updates", () => {
    expect(
      isCollaborationPresenceUpdate({
        sequence: 4,
        cursor: { x: 10, y: -20 },
        selectedEntityIds: ["one", "two"],
      }),
    ).toBe(true);
    expect(isCollaborationPresenceUpdate({ sequence: 5, cursor: null })).toBe(true);
    expect(isCollaborationPresenceUpdate({ sequence: 6, cursor: { x: Infinity, y: 0 } })).toBe(
      false,
    );
  });
});
