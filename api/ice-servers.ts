import {
  parseIceServerCredentials,
  type IceServerCredentials,
} from "../lib/collaboration/ice-server-provider.ts";

const CREDENTIAL_TTL_SECONDS = 60 * 60;
const CLOUDFLARE_TURN_API_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";

export interface TurnCredentialProvider {
  generateIceServers(signal?: AbortSignal): Promise<RTCIceServer[]>;
}

interface CloudflareTurnProviderOptions {
  turnKeyId: string;
  apiToken: string;
  ttlSeconds?: number;
  fetcher?: typeof fetch;
}

export function createCloudflareTurnProvider({
  turnKeyId,
  apiToken,
  ttlSeconds = CREDENTIAL_TTL_SECONDS,
  fetcher = fetch,
}: CloudflareTurnProviderOptions): TurnCredentialProvider {
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
      const value = (await response.json()) as { iceServers?: unknown };
      if (!Array.isArray(value.iceServers)) {
        throw new Error("Cloudflare TURN response has no ICE servers");
      }
      return filterBrowserIceServers(value.iceServers);
    },
  };
}

export function createIceServerHandler({
  provider,
  ttlSeconds = CREDENTIAL_TTL_SECONDS,
  now = Date.now,
}: {
  provider: TurnCredentialProvider;
  ttlSeconds?: number;
  now?: () => number;
}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) {
      return jsonResponse({ error: "Cross-origin requests are not allowed" }, 403);
    }
    try {
      const issuedAt = now();
      const credentials = parseIceServerCredentials(
        {
          iceServers: await provider.generateIceServers(request.signal),
          expiresAt: issuedAt + ttlSeconds * 1000,
        },
        issuedAt,
      );
      return jsonResponse(credentials, 200);
    } catch (error) {
      console.error("[turn] credential generation failed", error);
      return jsonResponse({ error: "Unable to issue relay credentials" }, 502);
    }
  };
}

export function filterBrowserIceServers(value: unknown[]): RTCIceServer[] {
  return value.flatMap((server) => {
    if (!server || typeof server !== "object") return [];
    const record = server as Record<string, unknown>;
    const sourceUrls = typeof record.urls === "string" ? [record.urls] : record.urls;
    if (!Array.isArray(sourceUrls)) return [];
    const urls = sourceUrls.filter(
      (url): url is string => typeof url === "string" && !/:53(?:\?|$)/.test(url),
    );
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

function jsonResponse(
  body: IceServerCredentials | { error: string },
  status: number,
  extraHeaders: HeadersInit = {},
): Response {
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

let defaultHandler: ((request: Request) => Promise<Response>) | null = null;

export default {
  fetch(request: Request) {
    defaultHandler ??= createIceServerHandler({
      provider: createCloudflareTurnProvider({
        turnKeyId: process.env.CF_TURN_ID ?? "",
        apiToken: process.env.CF_TURN_API_TOKEN ?? "",
      }),
    });
    return defaultHandler(request);
  },
};
