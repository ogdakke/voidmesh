import { describe, expect, it, vi } from "vitest";
import {
  HttpIceServerProvider,
  measurePeerConnectionPath,
  parseIceServerCredentials,
} from "#lib/collaboration/ice-server-provider.ts";

const TURN_SERVER = {
  urls: ["turn:turn.example:3478?transport=udp", "turns:turn.example:443?transport=tcp"],
  username: "user",
  credential: "secret",
};

describe("collaboration ICE server provider", () => {
  it("fetches and validates provider-neutral credentials", async () => {
    const expiresAt = Date.now() + 20_000;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ iceServers: [TURN_SERVER], expiresAt }));
    const provider = new HttpIceServerProvider("/api/test-ice", fetcher);

    await expect(provider.getCredentials()).resolves.toEqual({
      iceServers: [TURN_SERVER],
      expiresAt,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/test-ice",
      expect.objectContaining({ method: "POST", cache: "no-store", credentials: "same-origin" }),
    );
  });

  it("rejects expired credentials and unauthenticated TURN servers", () => {
    expect(() =>
      parseIceServerCredentials({ iceServers: [TURN_SERVER], expiresAt: 999 }, 1_000),
    ).toThrow(/expired/);
    expect(() =>
      parseIceServerCredentials(
        { iceServers: [{ urls: "turn:turn.example:3478" }], expiresAt: 2_000 },
        1_000,
      ),
    ).toThrow(/missing credentials/);
  });

  it("rejects credential responses without a TURN server", () => {
    expect(() =>
      parseIceServerCredentials(
        {
          iceServers: [{ urls: "stun:stun.example.com:3478" }],
          expiresAt: 2_000,
        },
        1_000,
      ),
    ).toThrow(/no TURN server/);
  });

  it("reports whether the selected candidate pair is direct or relayed", async () => {
    const directConnection = createStatsConnection([
      { id: "transport", type: "transport", selectedCandidatePairId: "pair" },
      {
        id: "pair",
        type: "candidate-pair",
        localCandidateId: "local",
        remoteCandidateId: "remote",
      },
      { id: "local", type: "local-candidate", candidateType: "host", protocol: "udp" },
      { id: "remote", type: "remote-candidate", candidateType: "srflx", protocol: "udp" },
    ]);
    const relayConnection = createStatsConnection([
      { id: "transport", type: "transport", selectedCandidatePairId: "pair" },
      {
        id: "pair",
        type: "candidate-pair",
        localCandidateId: "local",
        remoteCandidateId: "remote",
      },
      {
        id: "local",
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        relayProtocol: "tls",
      },
      { id: "remote", type: "remote-candidate", candidateType: "host", protocol: "udp" },
    ]);

    await expect(measurePeerConnectionPath(directConnection)).resolves.toEqual({
      type: "direct",
      protocol: null,
    });
    await expect(measurePeerConnectionPath(relayConnection)).resolves.toEqual({
      type: "relay",
      protocol: "tls",
    });
  });
});

function createStatsConnection(entries: Array<Record<string, unknown>>) {
  const report = new Map(entries.map((entry) => [entry.id as string, entry]));
  return {
    getStats: vi
      .fn<() => Promise<RTCStatsReport>>()
      .mockResolvedValue(report as unknown as RTCStatsReport),
  };
}
