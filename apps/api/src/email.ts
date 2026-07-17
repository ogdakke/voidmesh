import { trustedCallbackOrigin } from "./web-origins.ts";

interface EmailConfiguration {
  apiKey: string;
  from: string;
  webOrigin: string;
}

interface AuthEmail {
  recipientName: string;
  subject: string;
  text: string;
  html: string;
  to: string;
}

type EmailFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";

export function hasEmailDelivery(env: Env): boolean {
  return readEmailConfiguration(env) !== null;
}

export async function sendPasswordResetEmail(
  env: Env,
  input: { email: string; name: string; url: string },
  fetcher: EmailFetch = fetch,
): Promise<void> {
  const publicUrl = toPublicAuthUrl(env, input.url);
  await sendAuthEmail(
    env,
    {
      html: authEmailHtml({
        actionLabel: "Reset password",
        body: "A password reset was requested for your Voidmesh account. This link expires in one hour.",
        recipientName: input.name,
        url: publicUrl,
      }),
      recipientName: input.name,
      subject: "Reset your Voidmesh password",
      text: `Reset your Voidmesh password: ${publicUrl}\n\nThis link expires in one hour. If you did not request it, you can ignore this email.`,
      to: input.email,
    },
    fetcher,
  );
}

export async function sendAccountVerificationEmail(
  env: Env,
  input: { email: string; name: string; url: string },
  fetcher: EmailFetch = fetch,
): Promise<void> {
  const publicUrl = toPublicAuthUrl(env, input.url);
  await sendAuthEmail(
    env,
    {
      html: authEmailHtml({
        actionLabel: "Verify email",
        body: "Verify this email address to finish creating your Voidmesh hosted account.",
        recipientName: input.name,
        url: publicUrl,
      }),
      recipientName: input.name,
      subject: "Verify your Voidmesh account",
      text: `Verify your Voidmesh account: ${publicUrl}\n\nThis link expires in one hour. If you did not create this account, you can ignore this email.`,
      to: input.email,
    },
    fetcher,
  );
}

async function sendAuthEmail(env: Env, email: AuthEmail, fetcher: EmailFetch): Promise<void> {
  const config = readEmailConfiguration(env);
  if (!config) throw new Error("Email delivery is not configured");
  const response = await fetcher(RESEND_EMAIL_ENDPOINT, {
    body: JSON.stringify({
      from: config.from,
      html: email.html,
      subject: email.subject,
      text: email.text,
      to: [email.to],
    }),
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    const requestId = response.headers.get("x-request-id");
    throw new Error(
      `Email provider rejected the request (${response.status})${requestId ? ` [${requestId}]` : ""}`,
    );
  }
}

function readEmailConfiguration(env: Env): EmailConfiguration | null {
  const bindings = env as unknown as Record<string, unknown>;
  const apiKey = bindings.RESEND_API_KEY;
  const from = bindings.EMAIL_FROM;
  const webOrigin = bindings.WEB_ORIGIN;
  if ((apiKey === undefined || apiKey === "") && (from === undefined || from === "")) {
    return null;
  }
  if (
    typeof apiKey !== "string" ||
    apiKey.length === 0 ||
    typeof from !== "string" ||
    from.length === 0 ||
    typeof webOrigin !== "string" ||
    webOrigin.length === 0
  ) {
    throw new Error("RESEND_API_KEY, EMAIL_FROM, and WEB_ORIGIN must be configured together");
  }
  return { apiKey, from, webOrigin };
}

function toPublicAuthUrl(env: Env, internalUrl: string): string {
  const config = readEmailConfiguration(env);
  if (!config) throw new Error("Email delivery is not configured");
  const source = new URL(internalUrl);
  return new URL(`${source.pathname}${source.search}`, trustedCallbackOrigin(env, internalUrl))
    .href;
}

function authEmailHtml(input: {
  actionLabel: string;
  body: string;
  recipientName: string;
  url: string;
}): string {
  const name = escapeHtml(input.recipientName.trim() || "there");
  const actionLabel = escapeHtml(input.actionLabel);
  const body = escapeHtml(input.body);
  const url = escapeHtml(input.url);
  return `<!doctype html>
<html lang="en"><body style="margin:0;background:#111;color:#eee;font-family:ui-sans-serif,system-ui,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:48px 24px">
    <p style="font-weight:700;letter-spacing:-.02em">Voidmesh</p>
    <h1 style="font-size:24px;margin:32px 0 12px">Hi ${name},</h1>
    <p style="color:#aaa;line-height:1.6">${body}</p>
    <p style="margin:32px 0"><a href="${url}" style="display:inline-block;background:#eee;color:#111;text-decoration:none;border-radius:8px;padding:12px 18px;font-weight:700">${actionLabel}</a></p>
    <p style="color:#777;font-size:13px;line-height:1.5">If the button does not work, paste this address into your browser:<br><a href="${url}" style="color:#aaa;word-break:break-all">${url}</a></p>
  </div>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
