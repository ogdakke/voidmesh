export interface IceServerCredentials {
  iceServers: RTCIceServer[];
  expiresAt: number;
}

export interface IceServerProvider {
  getCredentials(signal?: AbortSignal): Promise<IceServerCredentials>;
}

export interface PeerConnectionPath {
  type: "unknown" | "direct" | "relay";
  protocol: string | null;
}

export class HttpIceServerProvider implements IceServerProvider {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint = "/api/ice-servers", fetcher: typeof fetch = fetch) {
    this.#endpoint = endpoint;
    this.#fetch = fetcher.bind(globalThis);
  }

  async getCredentials(signal?: AbortSignal): Promise<IceServerCredentials> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Unable to acquire relay credentials (${response.status})`);
    }
    return parseIceServerCredentials(await response.json());
  }
}

export function parseIceServerCredentials(value: unknown, now = Date.now()): IceServerCredentials {
  if (!value || typeof value !== "object") {
    throw new Error("Relay credential response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.iceServers) || record.iceServers.length === 0) {
    throw new Error("Relay credential response has no ICE servers");
  }
  if (record.iceServers.length > 16) {
    throw new Error("Relay credential response has too many ICE servers");
  }
  const expiresAt = record.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("Relay credentials are already expired");
  }
  const iceServers = record.iceServers.map(parseIceServer);
  if (!iceServers.some(hasTurnUrl)) {
    throw new Error("Relay credential response has no TURN server");
  }
  return { iceServers, expiresAt };
}

export async function measurePeerConnectionPath(
  connection: Pick<RTCPeerConnection, "getStats">,
): Promise<PeerConnectionPath> {
  try {
    const report = await connection.getStats();
    const stats = new Map<string, Record<string, unknown>>();
    report.forEach((entry) => stats.set(entry.id, entry as unknown as Record<string, unknown>));
    const transport = [...stats.values()].find((entry) => entry.type === "transport");
    const selectedPairId = transport?.selectedCandidatePairId;
    const pair =
      (typeof selectedPairId === "string" ? stats.get(selectedPairId) : undefined) ??
      [...stats.values()].find(
        (entry) =>
          entry.type === "candidate-pair" &&
          entry.state === "succeeded" &&
          entry.nominated === true,
      );
    if (!pair) return { type: "unknown", protocol: null };
    const localCandidate = getCandidate(stats, pair.localCandidateId);
    const remoteCandidate = getCandidate(stats, pair.remoteCandidateId);
    const relayCandidate = [localCandidate, remoteCandidate].find(
      (candidate) => candidate?.candidateType === "relay",
    );
    if (!relayCandidate) return { type: "direct", protocol: null };
    const protocol = relayCandidate.relayProtocol ?? relayCandidate.protocol;
    return { type: "relay", protocol: typeof protocol === "string" ? protocol : null };
  } catch {
    return { type: "unknown", protocol: null };
  }
}

function parseIceServer(value: unknown): RTCIceServer {
  if (!value || typeof value !== "object") {
    throw new Error("ICE server must be an object");
  }
  const record = value as Record<string, unknown>;
  const urls = parseIceServerUrls(record.urls);
  const hasTurnUrl = urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
  const username = record.username;
  const credential = record.credential;
  if (username !== undefined && typeof username !== "string") {
    throw new Error("ICE server username must be a string");
  }
  if (credential !== undefined && typeof credential !== "string") {
    throw new Error("ICE server credential must be a string");
  }
  if (hasTurnUrl && (!username || !credential)) {
    throw new Error("TURN server is missing credentials");
  }
  return {
    urls: Array.isArray(record.urls) ? urls : urls[0]!,
    ...(username === undefined ? {} : { username }),
    ...(credential === undefined ? {} : { credential }),
  };
}

function hasTurnUrl(server: RTCIceServer): boolean {
  const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
  return urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
}

function parseIceServerUrls(value: unknown): string[] {
  const urls = typeof value === "string" ? [value] : value;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 16) {
    throw new Error("ICE server URLs must be a non-empty string or string array");
  }
  return urls.map((url) => {
    if (
      typeof url !== "string" ||
      (!url.startsWith("stun:") && !url.startsWith("turn:") && !url.startsWith("turns:"))
    ) {
      throw new Error("ICE server URL uses an unsupported protocol");
    }
    return url;
  });
}

function getCandidate(
  stats: ReadonlyMap<string, Record<string, unknown>>,
  candidateId: unknown,
): Record<string, unknown> | undefined {
  return typeof candidateId === "string" ? stats.get(candidateId) : undefined;
}
