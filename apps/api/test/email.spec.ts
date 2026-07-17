import { describe, expect, it, vi } from "vitest";
import {
  hasEmailDelivery,
  sendAccountVerificationEmail,
  sendPasswordResetEmail,
} from "../src/email.ts";

const emailEnv = {
  EMAIL_FROM: "Voidmesh <accounts@voidmesh.test>",
  RESEND_API_KEY: "re_test_secret",
  WEB_ORIGIN: "https://app.voidmesh.test",
  TRUSTED_WEB_ORIGINS: "https://app.voidmesh.test,https://device.tailnet.test",
} as unknown as Env;

describe("auth email delivery", () => {
  it("rewrites internal auth URLs to the public app origin and escapes user content", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }),
    );
    await sendAccountVerificationEmail(
      emailEnv,
      {
        email: "person@example.com",
        name: '<Person & "Friend">',
        url: "http://127.0.0.1:8787/v1/auth/verify-email?token=secret&callbackURL=%2Fcloud",
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    const [endpoint, init] = fetcher.mock.calls[0]!;
    expect(String(endpoint)).toBe("https://api.resend.com/emails");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer re_test_secret",
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      from: "Voidmesh <accounts@voidmesh.test>",
      subject: "Verify your Voidmesh account",
      to: ["person@example.com"],
    });
    expect(body.text).toContain(
      "https://app.voidmesh.test/v1/auth/verify-email?token=secret&callbackURL=%2Fcloud",
    );
    expect(body.html).toContain("&lt;Person &amp; &quot;Friend&quot;&gt;");
    expect(body.html).not.toContain('<Person & "Friend">');
  });

  it("uses a generic reset message and rejects provider failures", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, {
          headers: { "x-request-id": "email_request" },
          status: 503,
        }),
    );
    await expect(
      sendPasswordResetEmail(
        emailEnv,
        {
          email: "person@example.com",
          name: "Person",
          url: "https://voidmesh.test/v1/auth/reset-password/token?callbackURL=%2Fcloud",
        },
        fetcher,
      ),
    ).rejects.toThrow("Email provider rejected the request (503) [email_request]");
  });

  it("keeps auth email links on the trusted origin that requested the callback", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }),
    );
    await sendAccountVerificationEmail(
      emailEnv,
      {
        email: "person@example.com",
        name: "Person",
        url: `http://127.0.0.1:8787/v1/auth/verify-email?token=secret&callbackURL=${encodeURIComponent("https://device.tailnet.test/cloud?verified=1")}`,
      },
      fetcher,
    );

    const [, init] = fetcher.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body.text).toContain("https://device.tailnet.test/v1/auth/verify-email");
  });

  it("requires the provider key and sender to be configured together", () => {
    expect(
      hasEmailDelivery({
        WEB_ORIGIN: "https://app.voidmesh.test",
      } as unknown as Env),
    ).toBe(false);
    expect(() =>
      hasEmailDelivery({
        EMAIL_FROM: "accounts@voidmesh.test",
        WEB_ORIGIN: "https://app.voidmesh.test",
      } as unknown as Env),
    ).toThrow("RESEND_API_KEY, EMAIL_FROM, and WEB_ORIGIN must be configured together");
  });
});
