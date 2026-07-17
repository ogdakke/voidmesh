export function readTrustedWebOrigins(env: Env): string[] {
  const bindings = env as unknown as Record<string, unknown>;
  const primary = readRequiredBinding(bindings, "WEB_ORIGIN");
  const additional = bindings.TRUSTED_WEB_ORIGINS;
  if (additional !== undefined && typeof additional !== "string") {
    throw new Error("TRUSTED_WEB_ORIGINS must be a comma-separated string");
  }

  return [
    ...new Set(
      [primary, ...(additional?.split(",") ?? [])]
        .map((value) => value.trim())
        .filter(Boolean)
        .map(normalizeWebOrigin),
    ),
  ];
}

export function primaryWebOrigin(env: Env): string {
  return readTrustedWebOrigins(env)[0]!;
}

export function trustedRequestOrigin(env: Env, request: Request): string {
  const trustedOrigins = readTrustedWebOrigins(env);
  const candidates = [request.headers.get("origin"), new URL(request.url).origin];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const origin = normalizeWebOrigin(candidate);
      if (trustedOrigins.includes(origin)) return origin;
    } catch {
      // An untrusted request origin must not affect generated application URLs.
    }
  }
  return trustedOrigins[0]!;
}

export function trustedCallbackOrigin(env: Env, internalUrl: string): string {
  const trustedOrigins = readTrustedWebOrigins(env);
  const callbackURL = new URL(internalUrl).searchParams.get("callbackURL");
  if (callbackURL) {
    try {
      const origin = normalizeWebOrigin(new URL(callbackURL).origin);
      if (trustedOrigins.includes(origin)) return origin;
    } catch {
      // Relative or malformed callback URLs use the primary public origin.
    }
  }
  return trustedOrigins[0]!;
}

function normalizeWebOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Web origins must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Web origin must not include credentials, a path, query, or hash: ${value}`);
  }
  return url.origin;
}

function readRequiredBinding(bindings: Record<string, unknown>, name: string): string {
  const value = bindings[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required Worker binding: ${name}`);
  }
  return value;
}
