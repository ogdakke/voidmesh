import { describe, expect, it } from "vitest";
import { CollaborationMetricsStore } from "#lib/collaboration/metrics.ts";

describe("CollaborationMetricsStore", () => {
  it("tracks connection, messages, and bounded asset transfer measurements", () => {
    const store = new CollaborationMetricsStore();
    store.beginConnection("room", 10);
    store.markConnected(35);
    store.recordDocumentUpdate("send", 120);
    store.recordMessage("receive", 80);

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
    expect(state.status).toBe("connected");
    expect(state.connectionDurationMs).toBe(25);
    expect(state.documentUpdatesSent).toBe(1);
    expect(state.messagesSent).toBe(1);
    expect(state.messagesReceived).toBe(1);
    expect(state.bytesSent).toBe(120);
    expect(state.bytesReceived).toBe(80);
    expect(state.assetTransfersSent).toBe(55);
    expect(state.transfers).toHaveLength(50);
    expect(state.transfers[0]?.assetHash).toBe("asset-5");
  });
});
