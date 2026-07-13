import type { TLSSocket } from "node:tls";
import type { Connect, Plugin } from "vite";
import { createCloudflareTurnProvider, createIceServerHandler } from "../api/ice-servers.js";

interface TurnCredentialsPluginOptions {
  turnKeyId?: string;
  apiToken?: string;
  fetcher?: typeof fetch;
}

export function turnCredentialsPlugin(options: TurnCredentialsPluginOptions): Plugin {
  return {
    name: "voidmesh:turn-credentials",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(createTurnCredentialMiddleware(options));
    },
  };
}

export function createTurnCredentialMiddleware(
  options: TurnCredentialsPluginOptions,
): Connect.NextHandleFunction {
  const handler = createIceServerHandler({
    provider: createCloudflareTurnProvider({
      ...options,
      turnKeyId: options.turnKeyId ?? "",
      apiToken: options.apiToken ?? "",
    }),
  });

  return (request, response, next) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/api/ice-servers") {
      next();
      return;
    }
    void handleRequest(handler, request, response).catch((error: unknown) => {
      console.error("[turn] local credential middleware failed", error);
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: "Unable to serve relay credentials" }));
    });
  };
}

async function handleRequest(
  handler: (request: Request) => Promise<Response>,
  nodeRequest: Connect.IncomingMessage,
  nodeResponse: Parameters<Connect.SimpleHandleFunction>[1],
): Promise<void> {
  const abortController = new AbortController();
  nodeRequest.once("aborted", () => abortController.abort());
  const response = await handler(
    new Request(getRequestUrl(nodeRequest), {
      method: nodeRequest.method,
      headers: getRequestHeaders(nodeRequest),
      signal: abortController.signal,
    }),
  );
  nodeResponse.statusCode = response.status;
  for (const [name, value] of response.headers) nodeResponse.setHeader(name, value);
  nodeResponse.end(new Uint8Array(await response.arrayBuffer()));
}

function getRequestUrl(request: Connect.IncomingMessage): URL {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol =
    (Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol)
      ?.split(",")[0]
      ?.trim() || ((request.socket as TLSSocket).encrypted ? "https" : "http");
  return new URL(request.url ?? "/", `${protocol}://${request.headers.host ?? "localhost"}`);
}

function getRequestHeaders(request: Connect.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}
