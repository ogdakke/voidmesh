import { describe, expect, it } from "vitest";
import {
  readTrustedWebOrigins,
  trustedCallbackOrigin,
  trustedRequestOrigin,
} from "../src/web-origins.ts";

const env = {
  TRUSTED_WEB_ORIGINS: "https://voidmesh.localhost, https://dws-computer-2.tailf9b0ae.ts.net",
  WEB_ORIGIN: "https://voidmesh.localhost",
} as unknown as Env;

describe("trusted web origins", () => {
  it("allows explicitly configured localhost and Tailnet origins", () => {
    expect(readTrustedWebOrigins(env)).toEqual([
      "https://voidmesh.localhost",
      "https://dws-computer-2.tailf9b0ae.ts.net",
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
