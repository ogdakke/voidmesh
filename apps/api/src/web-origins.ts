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
        .map(normalizeTrustedWebOrigin),
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
      if (trustedOrigins.some((trusted) => matchesTrustedOrigin(trusted, origin))) return origin;
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
      if (trustedOrigins.some((trusted) => matchesTrustedOrigin(trusted, origin))) return origin;
    } catch {
      // Relative or malformed callback URLs use the primary public origin.
    }
  }
  return trustedOrigins[0]!;
}

function normalizeTrustedWebOrigin(value: string): string {
  if (!value.includes("*")) return normalizeWebOrigin(value);
  const match = /^(https?):\/\/([*A-Za-z0-9.-]+)(?::([0-9]+))?$/.exec(value);
  const hostname = match?.[2];
  if (
    !match ||
    !hostname ||
    hostname.split("*").length !== 2 ||
    hostname.startsWith(".") ||
    hostname.endsWith(".")
  ) {
    throw new Error(`Invalid trusted web origin pattern: ${value}`);
  }
  return `${match[1]}://${hostname}${match[3] ? `:${match[3]}` : ""}`;
}

function matchesTrustedOrigin(pattern: string, origin: string): boolean {
  if (!pattern.includes("*")) return pattern === origin;
  const patternURL = new URL(pattern.replace("*", "wildcard"));
  const originURL = new URL(origin);
  const hostnamePattern = patternURL.hostname.replace("wildcard", "*");
  const hostnameExpression = new RegExp(
    `^${hostnamePattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+")}$`,
  );
  return (
    originURL.protocol === patternURL.protocol &&
    originURL.port === patternURL.port &&
    hostnameExpression.test(originURL.hostname)
  );
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
