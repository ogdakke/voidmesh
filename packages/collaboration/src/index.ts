import type { UserId, WorkspaceRole } from "@voidmesh/domain";

export const COLLABORATION_PROTOCOL_VERSION = 4;
export const MAX_YJS_UPDATE_BYTES = 16 * 1024 * 1024;
export const MAX_PRESENCE_MESSAGE_BYTES = 256 * 1024;
export const MAX_SELECTED_ENTITY_IDS = 2_048;

const CLIENT_YJS_FRAME = 1;
const SERVER_YJS_FRAME = 2;
const CLIENT_YJS_REBASE_FRAME = 3;
const SERVER_YJS_REBASE_FRAME = 4;
const UPDATE_ID_BYTES = 36;
const SERVER_SEQUENCE_BYTES = 8;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder(undefined, {
  fatal: true,
  ignoreBOM: false,
});

export interface PresencePoint {
  x: number;
  y: number;
}

export interface ClientPresenceMessage {
  cursor?: PresencePoint | null;
  selectedEntityIds?: string[];
  sequence: number;
  type: "presence";
}

export interface ClientClockPingMessage {
  clientTime: number;
  requestId: string;
  type: "clock-ping";
}

export interface CollaborationPeer {
  color: string;
  connectionId: string;
  name: string;
  role: WorkspaceRole;
  userId: UserId;
}

export interface ServerHelloMessage {
  connectionId: string;
  peers: CollaborationPeer[];
  protocolVersion: typeof COLLABORATION_PROTOCOL_VERSION;
  role: WorkspaceRole;
  roomSequence: number;
  /** Epoch milliseconds from the room authority, used to align playback anchors. */
  serverTime: number;
  type: "hello";
  user: Omit<CollaborationPeer, "connectionId" | "role">;
}

export interface ServerPresenceMessage extends ClientPresenceMessage {
  color: string;
  connectionId: string;
  name: string;
  userId: UserId;
}

export interface ServerPeerLeftMessage {
  connectionId: string;
  type: "peer-left";
  userId: UserId;
}

export interface ServerAckMessage {
  roomSequence: number;
  type: "ack";
  updateId: string;
}

export interface ServerErrorMessage {
  code: string;
  type: "error";
  updateId?: string;
}

export interface ServerSyncCompleteMessage {
  roomSequence: number;
  stateVector: string;
  type: "sync-complete";
}

export interface ServerRoleChangedMessage {
  role: WorkspaceRole;
  type: "role-changed";
}

export interface ServerClockPongMessage {
  clientTime: number;
  requestId: string;
  serverTime: number;
  type: "clock-pong";
}

export interface DecodedYjsUpdate {
  update: Uint8Array;
  updateId: string;
}

export interface DecodedServerYjsUpdate extends DecodedYjsUpdate {
  roomSequence: number;
}

export function encodeClientYjsUpdate(updateId: string, update: Uint8Array): ArrayBuffer {
  return encodeClientFrame(CLIENT_YJS_FRAME, updateId, update);
}

export function encodeClientYjsRebase(updateId: string, update: Uint8Array): ArrayBuffer {
  return encodeClientFrame(CLIENT_YJS_REBASE_FRAME, updateId, update);
}

export function decodeClientYjsUpdate(frame: ArrayBuffer): DecodedYjsUpdate | null {
  const bytes = new Uint8Array(frame);
  if (bytes.byteLength <= 1 + UPDATE_ID_BYTES || bytes[0] !== CLIENT_YJS_FRAME) return null;
  return decodeUpdate(bytes, 1, 1 + UPDATE_ID_BYTES);
}

export function decodeClientYjsRebase(frame: ArrayBuffer): DecodedYjsUpdate | null {
  const bytes = new Uint8Array(frame);
  if (bytes.byteLength <= 1 + UPDATE_ID_BYTES || bytes[0] !== CLIENT_YJS_REBASE_FRAME) return null;
  return decodeUpdate(bytes, 1, 1 + UPDATE_ID_BYTES);
}

export function encodeServerYjsUpdate(
  roomSequence: number,
  updateId: string,
  update: Uint8Array,
): ArrayBuffer {
  return encodeServerFrame(SERVER_YJS_FRAME, roomSequence, updateId, update);
}

export function encodeServerYjsRebase(
  roomSequence: number,
  updateId: string,
  update: Uint8Array,
): ArrayBuffer {
  return encodeServerFrame(SERVER_YJS_REBASE_FRAME, roomSequence, updateId, update);
}

function encodeServerFrame(
  kind: typeof SERVER_YJS_FRAME | typeof SERVER_YJS_REBASE_FRAME,
  roomSequence: number,
  updateId: string,
  update: Uint8Array,
): ArrayBuffer {
  assertUpdate(updateId, update);
  if (!Number.isSafeInteger(roomSequence) || roomSequence <= 0) {
    throw new Error("Room sequence must be a positive safe integer");
  }
  const frame = new Uint8Array(1 + SERVER_SEQUENCE_BYTES + UPDATE_ID_BYTES + update.byteLength);
  frame[0] = kind;
  new DataView(frame.buffer).setBigUint64(1, BigInt(roomSequence), false);
  frame.set(textEncoder.encode(updateId), 1 + SERVER_SEQUENCE_BYTES);
  frame.set(update, 1 + SERVER_SEQUENCE_BYTES + UPDATE_ID_BYTES);
  return frame.buffer;
}

export function decodeServerYjsUpdate(frame: ArrayBuffer): DecodedServerYjsUpdate | null {
  return decodeServerFrame(frame, SERVER_YJS_FRAME);
}

export function decodeServerYjsRebase(frame: ArrayBuffer): DecodedServerYjsUpdate | null {
  return decodeServerFrame(frame, SERVER_YJS_REBASE_FRAME);
}

function decodeServerFrame(
  frame: ArrayBuffer,
  kind: typeof SERVER_YJS_FRAME | typeof SERVER_YJS_REBASE_FRAME,
): DecodedServerYjsUpdate | null {
  const bytes = new Uint8Array(frame);
  const updateOffset = 1 + SERVER_SEQUENCE_BYTES + UPDATE_ID_BYTES;
  if (bytes.byteLength <= updateOffset || bytes[0] !== kind) return null;
  const roomSequence = Number(new DataView(frame).getBigUint64(1, false));
  if (!Number.isSafeInteger(roomSequence) || roomSequence <= 0) return null;
  const decoded = decodeUpdate(
    bytes,
    1 + SERVER_SEQUENCE_BYTES,
    1 + SERVER_SEQUENCE_BYTES + UPDATE_ID_BYTES,
  );
  return decoded ? { ...decoded, roomSequence } : null;
}

function encodeClientFrame(
  kind: typeof CLIENT_YJS_FRAME | typeof CLIENT_YJS_REBASE_FRAME,
  updateId: string,
  update: Uint8Array,
): ArrayBuffer {
  assertUpdate(updateId, update);
  const frame = new Uint8Array(1 + UPDATE_ID_BYTES + update.byteLength);
  frame[0] = kind;
  frame.set(textEncoder.encode(updateId), 1);
  frame.set(update, 1 + UPDATE_ID_BYTES);
  return frame.buffer;
}

export function parseClientPresenceMessage(value: string): ClientPresenceMessage | null {
  if (value.length > MAX_PRESENCE_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as Partial<ClientPresenceMessage>;
  if (message.type !== "presence" || !Number.isSafeInteger(message.sequence)) return null;
  if (Number(message.sequence) < 0) return null;
  if (message.cursor !== undefined && message.cursor !== null && !isPoint(message.cursor)) {
    return null;
  }
  if (
    message.selectedEntityIds !== undefined &&
    (!Array.isArray(message.selectedEntityIds) ||
      message.selectedEntityIds.length > MAX_SELECTED_ENTITY_IDS ||
      !message.selectedEntityIds.every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 128,
      ))
  ) {
    return null;
  }
  if (message.cursor === undefined && message.selectedEntityIds === undefined) return null;
  return {
    ...(message.cursor !== undefined && { cursor: message.cursor }),
    ...(message.selectedEntityIds !== undefined && {
      selectedEntityIds: [...message.selectedEntityIds],
    }),
    sequence: Number(message.sequence),
    type: "presence",
  };
}

export function parseClientClockPingMessage(value: string): ClientClockPingMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as Partial<ClientClockPingMessage>;
  if (
    message.type !== "clock-ping" ||
    !isUpdateId(message.requestId ?? "") ||
    !Number.isFinite(message.clientTime) ||
    Math.abs(Number(message.clientTime) - Date.now()) > 24 * 60 * 60 * 1_000
  ) {
    return null;
  }
  return {
    clientTime: Number(message.clientTime),
    requestId: message.requestId!,
    type: "clock-ping",
  };
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return Uint8Array.from(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function decodeUpdate(
  bytes: Uint8Array,
  idStart: number,
  updateStart: number,
): DecodedYjsUpdate | null {
  try {
    const updateId = textDecoder.decode(bytes.subarray(idStart, updateStart));
    const update = bytes.slice(updateStart);
    if (!isUpdateId(updateId) || update.byteLength > MAX_YJS_UPDATE_BYTES) return null;
    return { update, updateId };
  } catch {
    return null;
  }
}

function assertUpdate(updateId: string, update: Uint8Array): void {
  if (!isUpdateId(updateId)) throw new Error("Update ID must be a UUID");
  if (update.byteLength < 1 || update.byteLength > MAX_YJS_UPDATE_BYTES) {
    throw new Error("Yjs update size is outside protocol bounds");
  }
}

function isUpdateId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPoint(value: object): value is PresencePoint {
  const point = value as Partial<PresencePoint>;
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Math.abs(Number(point.x)) <= 1e9 &&
    Math.abs(Number(point.y)) <= 1e9
  );
}
