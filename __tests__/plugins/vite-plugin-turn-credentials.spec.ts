import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTurnCredentialMiddleware } from "../../plugins/vite-plugin-turn-credentials.ts";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("Vite TURN credential middleware", () => {
  it("serves the production credential handler during local development", async () => {
    const upstreamFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        iceServers: [
          { urls: ["stun:stun.example:3478"] },
          {
            urls: ["turn:turn.example:3478?transport=udp"],
            username: "user",
            credential: "secret",
          },
        ],
      }),
    );
    const middleware = createTurnCredentialMiddleware({
      turnKeyId: "turn-key",
      apiToken: "api-token",
      fetcher: upstreamFetch,
    });
    const server = createServer((request, response) =>
      middleware(request, response, () => {
        response.statusCode = 404;
        response.end();
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
    const origin = `http://127.0.0.1:${address.port}`;

    const response = await Bun.fetch(`${origin}/api/ice-servers`, {
      method: "POST",
      headers: { Origin: origin },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      iceServers: [
        { urls: ["stun:stun.example:3478"] },
        { urls: ["turn:turn.example:3478?transport=udp"] },
      ],
    });
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("leaves unrelated requests to Vite", async () => {
    const middleware = createTurnCredentialMiddleware({
      turnKeyId: "turn-key",
      apiToken: "api-token",
      fetcher: vi.fn<typeof fetch>(),
    });
    const next = vi.fn<() => void>();

    middleware({ url: "/assets/app.js" } as never, {} as never, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
