import { describe, expect, it, vi } from "vitest";
import { CollaborationMetricsStore } from "#lib/collaboration/metrics.ts";

describe("CollaborationMetricsStore", () => {
  it("coalesces high-frequency presence metric publications", () => {
    vi.useFakeTimers();
    try {
      const store = new CollaborationMetricsStore();
      expect(store.getSnapshot().messagesSent).toBe(0);
      store.recordRealtimeMessage("send", 10);
      store.recordRealtimeMessage("send", 20);
      expect(store.getSnapshot().messagesSent).toBe(0);

      vi.advanceTimersByTime(250);
      expect(store.getSnapshot()).toMatchObject({ messagesSent: 2, bytesSent: 30 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks connection, messages, and bounded asset transfer measurements", () => {
    const store = new CollaborationMetricsStore();
    store.beginConnection("room", 10);
    store.markReady(35);
    store.recordDocumentUpdate("send", 120);
    store.recordMessage("receive", 80);
    store.recordPreviewEncodeDuration(2);
    store.recordPreviewPlaceholder(3, 2_048);
    store.recordPreviewHydration(40, 2_048);
    store.recordIceCredentials(12, 3_600_000, false);
    store.recordIceCredentials(8, 7_200_000, true);
    store.recordIceCredentialRefreshFailure();
    store.setConnectionPath("relay", "udp");
    store.setAssetQueue(4, 1, 0.625);
    store.recordAssetTransferRetry();

    for (let index = 0; index < 55; index++) {
      store.recordTransfer({
        assetHash: `asset-${index}`,
        direction: "send",
        originalBytes: 100,
        transmittedBytes: 75,
        compression: "gzip",
        durationMs: 10,
        throughputBytesPerSecond: 7500,
        peerId: "peer",
        completedAt: index,
      });
    }

    const state = store.getSnapshot();
    expect(state.status).toBe("waiting");
    expect(state.connectionDurationMs).toBe(25);
    expect(state.documentUpdatesSent).toBe(1);
    expect(state.messagesSent).toBe(1);
    expect(state.messagesReceived).toBe(1);
    expect(state.bytesSent).toBe(120);
    expect(state.bytesReceived).toBe(80);
    expect(state.assetTransfersSent).toBe(55);
    expect(state.previewEncodeDurationMs).toBe(2);
    expect(state.previewDecodeDurationMs).toBe(3);
    expect(state.previewPlaceholdersCreated).toBe(2_048);
    expect(state.previewHydrations).toBe(2_048);
    expect(state.previewDwellDurationMs).toBe(40);
    expect(state.iceCredentialFetchDurationMs).toBe(8);
    expect(state.iceCredentialExpiresAt).toBe(7_200_000);
    expect(state.iceCredentialRefreshes).toBe(1);
    expect(state.iceCredentialRefreshFailures).toBe(1);
    expect(state.connectionPath).toBe("relay");
    expect(state.relayProtocol).toBe("udp");
    expect(state.assetRequestsPending).toBe(4);
    expect(state.assetReceivesActive).toBe(1);
    expect(state.assetReceiveProgress).toBe(0.625);
    expect(state.assetTransferRetries).toBe(1);
    expect(state.transfers).toHaveLength(50);
    expect(state.transfers[0]?.assetHash).toBe("asset-5");
  });

  it("leaves reconnecting when a peer recovers or the room becomes empty", () => {
    const store = new CollaborationMetricsStore();
    store.beginConnection("room");
    store.setPeerCount(1);
    store.markReady();
    store.markReconnecting();
    store.markReady();
    expect(store.getSnapshot().status).toBe("connected");

    store.markReconnecting();
    store.setPeerCount(0);
    expect(store.getSnapshot().status).toBe("waiting");
  });

  it("keeps session measurements while beginning a room reconnection", () => {
    const store = new CollaborationMetricsStore();
    store.beginConnection("room", 10);
    store.recordMessage("send", 42);

    store.beginReconnection("room", 30);

    expect(store.getSnapshot()).toMatchObject({
      status: "reconnecting",
      roomId: "room",
      peerCount: 0,
      connectedAt: 30,
      bytesSent: 42,
    });
  });
});
