export type MonotonicClock = () => number;

export interface PeerClockSample {
  offsetMs: number;
  roundTripMs: number;
}

export type ClockSyncMessage =
  | { type: "request"; requestId: string; sentAt: number }
  | {
      type: "response";
      requestId: string;
      requesterSentAt: number;
      receiverReceivedAt: number;
      receiverSentAt: number;
    };

/** Epoch-compatible timestamp backed by the monotonic Performance clock. */
export function monotonicEpochNow(): number {
  return performance.timeOrigin + performance.now();
}

/** Calculate the remote-minus-local clock offset using the four NTP timestamps. */
export function calculatePeerClockSample(
  requesterSentAt: number,
  receiverReceivedAt: number,
  receiverSentAt: number,
  requesterReceivedAt: number,
): PeerClockSample {
  const values = [requesterSentAt, receiverReceivedAt, receiverSentAt, requesterReceivedAt];
  if (!values.every(Number.isFinite)) throw new Error("Invalid peer clock sample");
  if (receiverSentAt < receiverReceivedAt || requesterReceivedAt < requesterSentAt) {
    throw new Error("Peer clock timestamps are out of order");
  }
  return {
    offsetMs: (receiverReceivedAt - requesterSentAt + (receiverSentAt - requesterReceivedAt)) / 2,
    roundTripMs: Math.max(
      0,
      requesterReceivedAt - requesterSentAt - (receiverSentAt - receiverReceivedAt),
    ),
  };
}

export function isClockSyncMessage(value: unknown): value is ClockSyncMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ClockSyncMessage> & Record<string, unknown>;
  if (typeof message.requestId !== "string" || message.requestId.length === 0) return false;
  if (message.type === "request") return Number.isFinite(message.sentAt);
  return (
    message.type === "response" &&
    Number.isFinite(message.requesterSentAt) &&
    Number.isFinite(message.receiverReceivedAt) &&
    Number.isFinite(message.receiverSentAt)
  );
}
