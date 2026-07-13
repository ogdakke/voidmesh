import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCloudflareTurnProvider,
  createIceServerHandler,
  type TurnCredentialProvider,
} from "../../api/ice-servers.ts";

afterEach(() => vi.restoreAllMocks());

describe("ICE server credential endpoint", () => {
  it("adapts Cloudflare credentials and removes browser-blocked port 53 URLs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
          {
            urls: [
              "turn:turn.cloudflare.com:53?transport=udp",
              "turn:turn.cloudflare.com:3478?transport=udp",
              "turns:turn.cloudflare.com:443?transport=tcp",
            ],
            username: "user",
            credential: "secret",
          },
        ],
      }),
    );
    const provider = createCloudflareTurnProvider({
      turnKeyId: "key/id",
      apiToken: "api-token",
      ttlSeconds: 3_600,
      fetcher,
    });

    await expect(provider.generateIceServers()).resolves.toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "user",
        credential: "secret",
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key%2Fid/credentials/generate-ice-servers",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer api-token" }),
        body: JSON.stringify({ ttl: 3_600 }),
      }),
    );
  });

  it("returns a non-cacheable provider-neutral credential response", async () => {
    const handler = createIceServerHandler({
      provider: {
        generateIceServers: vi
          .fn<TurnCredentialProvider["generateIceServers"]>()
          .mockResolvedValue([
            {
              urls: "turn:turn.example:3478",
              username: "user",
              credential: "secret",
            },
          ]),
      },
      ttlSeconds: 3_600,
      now: () => 10_000,
    });
    const response = await handler(
      new Request("https://voidmesh.test/api/ice-servers", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      iceServers: [
        {
          urls: "turn:turn.example:3478",
          username: "user",
          credential: "secret",
        },
      ],
      expiresAt: 3_610_000,
    });
  });

  it("rejects other methods and hides upstream errors", async () => {
    const handler = createIceServerHandler({
      provider: {
        generateIceServers: vi
          .fn<TurnCredentialProvider["generateIceServers"]>()
          .mockRejectedValue(new Error("provider secret")),
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const getResponse = await handler(new Request("https://voidmesh.test/api/ice-servers"));
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");

    const crossOriginResponse = await handler({
      method: "POST",
      url: "https://voidmesh.test/api/ice-servers",
      headers: new Headers({ Origin: "https://attacker.test" }),
      signal: new AbortController().signal,
    } as Request);
    expect(crossOriginResponse.status).toBe(403);

    const postResponse = await handler(
      new Request("https://voidmesh.test/api/ice-servers", { method: "POST" }),
    );
    expect(postResponse.status).toBe(502);
    await expect(postResponse.json()).resolves.toEqual({
      error: "Unable to issue relay credentials",
    });
  });
});
