import { describe, expect, it } from "vitest";
import {
  readTrustedWebOrigins,
  trustedCallbackOrigin,
  trustedRequestOrigin,
} from "../src/web-origins.ts";

const env = {
  TRUSTED_WEB_ORIGINS:
    "https://voidmesh.localhost, https://dws-computer-2.tailf9b0ae.ts.net, https://voidmesh-*-ogdakkes-projects.vercel.app",
  WEB_ORIGIN: "https://voidmesh.localhost",
} as unknown as Env;

describe("trusted web origins", () => {
  it("allows explicitly configured localhost and Tailnet origins", () => {
    expect(readTrustedWebOrigins(env)).toEqual([
      "https://voidmesh.localhost",
      "https://dws-computer-2.tailf9b0ae.ts.net",
      "https://voidmesh-*-ogdakkes-projects.vercel.app",
    ]);
    expect(
      trustedRequestOrigin(
        env,
        new Request("https://api.internal.test/v1/assets", {
          headers: { origin: "https://dws-computer-2.tailf9b0ae.ts.net" },
        }),
      ),
    ).toBe("https://dws-computer-2.tailf9b0ae.ts.net");
  });

  it("allows HTTPS Vercel previews without trusting the apex or lookalike hosts", () => {
    const request = (origin: string) =>
      trustedRequestOrigin(
        env,
        new Request("https://api.internal.test/v1/assets", { headers: { origin } }),
      );
    expect(request("https://voidmesh-git-cloud-ogdakkes-projects.vercel.app")).toBe(
      "https://voidmesh-git-cloud-ogdakkes-projects.vercel.app",
    );
    expect(request("https://attacker-project.vercel.app")).toBe("https://voidmesh.localhost");
    expect(request("https://vercel.app")).toBe("https://voidmesh.localhost");
    expect(request("https://voidmesh.vercel.app.evil.test")).toBe("https://voidmesh.localhost");
    expect(request("http://voidmesh.vercel.app")).toBe("https://voidmesh.localhost");
  });

  it("uses a trusted absolute auth callback and rejects arbitrary callback origins", () => {
    const tailnetCallback = encodeURIComponent(
      "https://dws-computer-2.tailf9b0ae.ts.net/cloud?verified=1",
    );
    expect(
      trustedCallbackOrigin(
        env,
        `http://127.0.0.1:8787/v1/auth/verify-email?callbackURL=${tailnetCallback}`,
      ),
    ).toBe("https://dws-computer-2.tailf9b0ae.ts.net");
    expect(
      trustedCallbackOrigin(
        env,
        "http://127.0.0.1:8787/v1/auth/verify-email?callbackURL=https%3A%2F%2Fevil.test%2F",
      ),
    ).toBe("https://voidmesh.localhost");
  });
});
