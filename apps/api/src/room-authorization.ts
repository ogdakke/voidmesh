import { base64UrlToBytes, bytesToBase64Url } from "@voidmesh/collaboration";
import { WorkspaceRole, type UserId, type WorkspaceId } from "@voidmesh/domain";

const AUTHORIZATION_VERSION = 1;
const AUTHORIZATION_TTL_MS = 30_000;
const MAX_AUTHORIZATION_BYTES = 2_048;

export interface RoomAuthorization {
  expiresAt: number;
  issuedAt: number;
  name: string;
  role: WorkspaceRole;
  sessionId: string;
  userId: UserId;
  version: 1;
  workspaceId: WorkspaceId;
}

export async function issueRoomAuthorization(
  secret: string,
  input: Pick<RoomAuthorization, "name" | "role" | "sessionId" | "userId" | "workspaceId">,
  now = Date.now(),
): Promise<string> {
  const authorization: RoomAuthorization = {
    ...input,
    expiresAt: now + AUTHORIZATION_TTL_MS,
    issuedAt: now,
    name: input.name.slice(0, 64),
    version: AUTHORIZATION_VERSION,
  };
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(authorization)));
  const signature = bytesToBase64Url(new Uint8Array(await sign(secret, payload)));
  return `${payload}.${signature}`;
}

export async function verifyRoomAuthorization(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<RoomAuthorization | null> {
  if (token.length > MAX_AUTHORIZATION_BYTES) return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, separator);
  const signature = base64UrlToBytes(token.slice(separator + 1));
  if (!signature) return null;
  const key = await authorizationKey(secret, ["verify"]);
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(`voidmesh-room-authorization:${payload}`),
    ))
  ) {
    return null;
  }
  const bytes = base64UrlToBytes(payload);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRoomAuthorization(value, now) ? value : null;
  } catch {
    return null;
  }
}

async function sign(secret: string, payload: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign(
    "HMAC",
    await authorizationKey(secret, ["sign"]),
    new TextEncoder().encode(`voidmesh-room-authorization:${payload}`),
  );
}

function authorizationKey(secret: string, usage: Array<"sign" | "verify">): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    usage,
  );
}

function isRoomAuthorization(value: unknown, now: number): value is RoomAuthorization {
  if (!value || typeof value !== "object") return false;
  const expiresAt = Reflect.get(value, "expiresAt");
  const issuedAt = Reflect.get(value, "issuedAt");
  const name = Reflect.get(value, "name");
  const role = Reflect.get(value, "role");
  const sessionId = Reflect.get(value, "sessionId");
  const userId = Reflect.get(value, "userId");
  const version = Reflect.get(value, "version");
  const workspaceId = Reflect.get(value, "workspaceId");
  return (
    version === AUTHORIZATION_VERSION &&
    typeof issuedAt === "number" &&
    Number.isSafeInteger(issuedAt) &&
    issuedAt <= now + 5_000 &&
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > now &&
    expiresAt <= issuedAt + AUTHORIZATION_TTL_MS &&
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 64 &&
    (role === WorkspaceRole.owner ||
      role === WorkspaceRole.editor ||
      role === WorkspaceRole.viewer) &&
    typeof sessionId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) &&
    typeof userId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(userId) &&
    typeof workspaceId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)
  );
}
