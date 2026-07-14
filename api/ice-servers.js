const CREDENTIAL_TTL_SECONDS = 60 * 60;
const CLOUDFLARE_TURN_API_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";

/**
 * @typedef {{generateIceServers(signal?: AbortSignal): Promise<RTCIceServer[]>}}
 * TurnCredentialProvider
 */

/**
 * @param {{
 *   turnKeyId: string;
 *   apiToken: string;
 *   ttlSeconds?: number;
 *   fetcher?: typeof fetch;
 * }} options
 * @returns {TurnCredentialProvider}
 */
export function createCloudflareTurnProvider({
  turnKeyId,
  apiToken,
  ttlSeconds = CREDENTIAL_TTL_SECONDS,
  fetcher = fetch,
}) {
  if (!turnKeyId || !apiToken) throw new Error("Cloudflare TURN credentials are not configured");
  return {
    async generateIceServers(signal) {
      const response = await fetcher(
        `${CLOUDFLARE_TURN_API_BASE}/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: ttlSeconds }),
          signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Cloudflare TURN credential request failed (${response.status})`);
      }
      const value = /** @type {{iceServers?: unknown}} */ (await response.json());
      if (!Array.isArray(value.iceServers)) {
        throw new Error("Cloudflare TURN response has no ICE servers");
      }
      return filterBrowserIceServers(value.iceServers);
    },
  };
}

/**
 * @param {{
 *   provider: TurnCredentialProvider;
 *   ttlSeconds?: number;
 *   now?: () => number;
 * }} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function createIceServerHandler({
  provider,
  ttlSeconds = CREDENTIAL_TTL_SECONDS,
  now = Date.now,
}) {
  return async (request) => {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) {
      return jsonResponse({ error: "Cross-origin requests are not allowed" }, 403);
    }
    try {
      const issuedAt = now();
      const credentials = {
        iceServers: validateIceServers(await provider.generateIceServers(request.signal)),
        expiresAt: issuedAt + ttlSeconds * 1000,
      };
      return jsonResponse(credentials, 200);
    } catch (error) {
      console.error("[turn] credential generation failed", error);
      return jsonResponse({ error: "Unable to issue relay credentials" }, 502);
    }
  };
}

/**
 * @param {unknown[]} value
 * @returns {RTCIceServer[]}
 */
export function filterBrowserIceServers(value) {
  return value.flatMap((server) => {
    if (!server || typeof server !== "object") return [];
    const record = /** @type {Record<string, unknown>} */ (server);
    const sourceUrls = typeof record.urls === "string" ? [record.urls] : record.urls;
    if (!Array.isArray(sourceUrls)) return [];
    const urls = sourceUrls.filter((url) => typeof url === "string" && !/:53(?:\?|$)/.test(url));
    if (urls.length === 0) return [];
    return [
      {
        urls,
        ...(typeof record.username === "string" ? { username: record.username } : {}),
        ...(typeof record.credential === "string" ? { credential: record.credential } : {}),
      },
    ];
  });
}

/**
 * @param {RTCIceServer[]} iceServers
 * @returns {RTCIceServer[]}
 */
function validateIceServers(iceServers) {
  if (iceServers.length === 0 || iceServers.length > 16) {
    throw new Error("TURN response has an invalid ICE server count");
  }
  let hasTurn = false;
  for (const server of iceServers) {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    const turnUrls = urls.filter((url) => url.startsWith("turn:") || url.startsWith("turns:"));
    if (turnUrls.length > 0 && (!server.username || !server.credential)) {
      throw new Error("TURN server is missing credentials");
    }
    hasTurn ||= turnUrls.length > 0;
  }
  if (!hasTurn) throw new Error("TURN response has no relay server");
  return iceServers;
}

/**
 * @param {{iceServers: RTCIceServer[]; expiresAt: number} | {error: string}} body
 * @param {number} status
 * @param {HeadersInit} [extraHeaders]
 */
function jsonResponse(body, status, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

/** @type {((request: Request) => Promise<Response>) | null} */
let defaultHandler = null;

export default {
  fetch(request) {
    defaultHandler ??= createIceServerHandler({
      provider: createCloudflareTurnProvider({
        turnKeyId: process.env.CF_TURN_ID ?? "",
        apiToken: process.env.CF_TURN_API_TOKEN ?? "",
      }),
    });
    return defaultHandler(request);
  },
};
