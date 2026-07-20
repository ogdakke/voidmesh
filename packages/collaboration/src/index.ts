import type { UserId, WorkspaceRole } from "@voidmesh/domain";

export const COLLABORATION_PROTOCOL_VERSION = 5;
export const MAX_SCENE_COMMAND_BYTES = 2 * 1024 * 1024;
export const MAX_SCENE_ENTITIES = 10_000;
export const MAX_PRESENCE_MESSAGE_BYTES = 256 * 1024;
export const MAX_SELECTED_ENTITY_IDS = 2_048;

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_SHARED_VALUE_DEPTH = 8;

export type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface HostedAssetReference {
  byteLength: number;
  contentHash?: string | null;
  contentType: string;
  id: string;
  mediaType: "gif" | "image" | "svg" | "video";
  originalFilename: string;
}

export interface HostedEntityRevisions {
  appearance: number;
  asset: number;
  geometry: number;
  identity: number;
  layering: number;
}

export interface HostedSceneEntityInput {
  asset: HostedAssetReference;
  edited: boolean;
  fps?: number | null;
  generation: number;
  hasAudio?: boolean;
  id: string;
  locked: boolean;
  name: string;
  originalPalette?: JsonObject;
  originalSize: { height: number; width: number };
  playbackDuration?: number;
  position: { x: number; y: number };
  rotation: number;
  shaderParams: JsonObject;
  shaderType: string;
  size: { height: number; width: number };
  zIndex: number;
}

export interface HostedSceneEntity extends HostedSceneEntityInput {
  revisions: HostedEntityRevisions;
}

export interface HostedEntityPatch {
  appearance?: Pick<HostedSceneEntityInput, "shaderParams" | "shaderType">;
  asset?: Pick<HostedSceneEntityInput, "asset" | "fps" | "hasAudio" | "playbackDuration">;
  geometry?: Pick<HostedSceneEntityInput, "originalSize" | "position" | "rotation" | "size">;
  identity?: Pick<HostedSceneEntityInput, "edited" | "locked" | "name" | "originalPalette">;
  layering?: Pick<HostedSceneEntityInput, "zIndex">;
}

export type HostedEntityRevisionGroup = keyof HostedEntityRevisions;
export type ExpectedEntityRevisions = Partial<HostedEntityRevisions>;

interface SceneCommandBase {
  operationId: string;
}

export interface CreateEntityCommand extends SceneCommandBase {
  entity: HostedSceneEntityInput;
  kind: "entity.create";
}

export interface PatchEntityCommand extends SceneCommandBase {
  entityId: string;
  expected: ExpectedEntityRevisions;
  generation: number;
  kind: "entity.patch";
  patch: HostedEntityPatch;
}

export interface RemoveEntitiesCommand extends SceneCommandBase {
  entities: Array<{ generation: number; id: string }>;
  kind: "entities.remove";
}

export interface ReplaceSceneCommand extends SceneCommandBase {
  entities: HostedSceneEntityInput[];
  kind: "scene.replace";
}

export type HostedSceneCommand =
  | CreateEntityCommand
  | PatchEntityCommand
  | RemoveEntitiesCommand
  | ReplaceSceneCommand;

export interface ClientSceneCommandMessage {
  command: HostedSceneCommand;
  type: "scene-command";
}

export type HostedSceneChange =
  | { entity: HostedSceneEntity; type: "entity.created" }
  | {
      entityId: string;
      generation: number;
      patch: HostedEntityPatch;
      revisions: HostedEntityRevisions;
      type: "entity.patched";
    }
  | { entityId: string; generation: number; type: "entity.removed" }
  | { entities: HostedSceneEntity[]; type: "scene.replaced" };

export interface ServerScenePatchMessage {
  changes: HostedSceneChange[];
  operationId: string;
  roomSequence: number;
  type: "scene-patch";
}

export interface MediaPlaybackAnchor {
  commandId: string;
  duration: number;
  effectiveAtRoomMs: number;
  entityId: string;
  loop: boolean;
  mediaRevision: number;
  playbackRate: number;
  positionSeconds: number;
  sequence: number;
  state: "paused" | "playing";
  type: "media";
}

export interface ShaderPlaybackAnchor {
  appearanceRevision: number;
  commandId: string;
  effectiveAtRoomMs: number;
  entityId: string;
  sequence: number;
  shaderTime: number;
  state: "paused" | "playing";
  type: "shader";
}

export type HostedPlaybackAnchor = MediaPlaybackAnchor | ShaderPlaybackAnchor;

export type HostedPlaybackCommand =
  | (Omit<MediaPlaybackAnchor, "effectiveAtRoomMs" | "sequence" | "type"> & {
      type: "media";
    })
  | (Omit<ShaderPlaybackAnchor, "effectiveAtRoomMs" | "sequence" | "type"> & {
      type: "shader";
    });

export interface ClientPlaybackCommandMessage {
  command: HostedPlaybackCommand;
  type: "playback-command";
}

export interface ServerPlaybackMessage {
  anchor: HostedPlaybackAnchor;
  roomSequence: number;
  type: "playback";
}

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
  serverTime: number;
  type: "hello";
  user: Omit<CollaborationPeer, "connectionId" | "role">;
}

export interface ServerSceneSnapshotMessage {
  entities: HostedSceneEntity[];
  playback: HostedPlaybackAnchor[];
  roomSequence: number;
  type: "scene-snapshot";
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
  operationId: string;
  roomSequence: number;
  type: "ack";
}

export interface ServerConflictMessage {
  current?: HostedSceneEntity;
  operationId: string;
  reason: "entity-exists" | "entity-missing" | "generation" | "revision";
  roomSequence: number;
  type: "conflict";
}

export interface ServerErrorMessage {
  code: string;
  operationId?: string;
  type: "error";
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

export type ClientDurableMessage = ClientPlaybackCommandMessage | ClientSceneCommandMessage;

export type ServerCollaborationMessage =
  | ServerAckMessage
  | ServerClockPongMessage
  | ServerConflictMessage
  | ServerErrorMessage
  | ServerHelloMessage
  | ServerPeerLeftMessage
  | ServerPlaybackMessage
  | ServerPresenceMessage
  | ServerRoleChangedMessage
  | ServerScenePatchMessage
  | ServerSceneSnapshotMessage;

export function parseClientDurableMessage(data: string): ClientDurableMessage | null {
  if (new TextEncoder().encode(data).byteLength > MAX_SCENE_COMMAND_BYTES) return null;
  const value = parseJsonObject(data);
  if (!value) return null;
  if (value.type === "scene-command" && isSceneCommand(value.command)) {
    return { command: value.command, type: "scene-command" };
  }
  if (value.type === "playback-command" && isPlaybackCommand(value.command)) {
    return { command: value.command, type: "playback-command" };
  }
  return null;
}

export function parseServerCollaborationMessage(data: string): ServerCollaborationMessage | null {
  const value = parseJsonObject(data);
  if (!value || typeof value.type !== "string") return null;
  switch (value.type) {
    case "hello":
    case "scene-snapshot":
    case "scene-patch":
    case "playback":
    case "ack":
    case "conflict":
    case "error":
    case "presence":
    case "peer-left":
    case "role-changed":
    case "clock-pong":
      return value as unknown as ServerCollaborationMessage;
    default:
      return null;
  }
}

export function parseClientPresenceMessage(data: string): ClientPresenceMessage | null {
  if (new TextEncoder().encode(data).byteLength > MAX_PRESENCE_MESSAGE_BYTES) return null;
  const value = parseJsonObject(data);
  if (!value || value.type !== "presence" || !isNonnegativeSafeInteger(value.sequence)) return null;
  if (value.cursor !== undefined && value.cursor !== null && !isPoint(value.cursor)) return null;
  if (
    value.selectedEntityIds !== undefined &&
    (!Array.isArray(value.selectedEntityIds) ||
      value.selectedEntityIds.length > MAX_SELECTED_ENTITY_IDS ||
      !value.selectedEntityIds.every(isIdentifier))
  ) {
    return null;
  }
  return {
    ...(value.cursor !== undefined && { cursor: value.cursor as PresencePoint | null }),
    ...(value.selectedEntityIds !== undefined && {
      selectedEntityIds: value.selectedEntityIds as string[],
    }),
    sequence: value.sequence,
    type: "presence",
  };
}

export function parseClientClockPingMessage(data: string): ClientClockPingMessage | null {
  const value = parseJsonObject(data);
  if (
    !value ||
    value.type !== "clock-ping" ||
    !isIdentifier(value.requestId) ||
    !isTimestamp(value.clientTime) ||
    value.clientTime === 0
  ) {
    return null;
  }
  return {
    clientTime: value.clientTime,
    requestId: value.requestId,
    type: "clock-ping",
  };
}

export function isSceneCommand(value: unknown): value is HostedSceneCommand {
  if (!isRecord(value) || !isIdentifier(value.operationId) || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "entity.create":
      return isSceneEntityInput(value.entity);
    case "entity.patch":
      return (
        isIdentifier(value.entityId) &&
        isNonnegativeSafeInteger(value.generation) &&
        isExpectedRevisions(value.expected) &&
        isEntityPatch(value.patch)
      );
    case "entities.remove":
      return (
        Array.isArray(value.entities) &&
        value.entities.length > 0 &&
        value.entities.length <= MAX_SCENE_ENTITIES &&
        value.entities.every(
          (entry) =>
            isRecord(entry) && isIdentifier(entry.id) && isNonnegativeSafeInteger(entry.generation),
        )
      );
    case "scene.replace":
      return (
        Array.isArray(value.entities) &&
        value.entities.length <= MAX_SCENE_ENTITIES &&
        value.entities.every(isSceneEntityInput) &&
        new Set(value.entities.map((entity) => entity.id)).size === value.entities.length
      );
    default:
      return false;
  }
}

export function isSceneEntity(value: unknown): value is HostedSceneEntity {
  return isRecord(value) && isSceneEntityInput(value) && isEntityRevisions(value.revisions);
}

export function isSceneEntityInput(value: unknown): value is HostedSceneEntityInput {
  if (!isRecord(value)) return false;
  return (
    isAsset(value.asset) &&
    typeof value.edited === "boolean" &&
    isNonnegativeSafeInteger(value.generation) &&
    isIdentifier(value.id) &&
    typeof value.locked === "boolean" &&
    isBoundedString(value.name, 1_024) &&
    (value.originalPalette === undefined || isJsonObject(value.originalPalette)) &&
    isSize(value.originalSize) &&
    isPoint(value.position) &&
    isCoordinate(value.rotation) &&
    isJsonObject(value.shaderParams) &&
    isBoundedString(value.shaderType, 128) &&
    isSize(value.size) &&
    isCoordinate(value.zIndex) &&
    (value.fps === undefined || value.fps === null || isPositiveNumber(value.fps)) &&
    (value.hasAudio === undefined || typeof value.hasAudio === "boolean") &&
    (value.playbackDuration === undefined || isNonnegativeNumber(value.playbackDuration))
  );
}

export function isEntityPatch(value: unknown): value is HostedEntityPatch {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !isRevisionGroup(key))) return false;
  return (
    (value.identity === undefined || isIdentityPatch(value.identity)) &&
    (value.geometry === undefined || isGeometryPatch(value.geometry)) &&
    (value.appearance === undefined || isAppearancePatch(value.appearance)) &&
    (value.layering === undefined || isLayeringPatch(value.layering)) &&
    (value.asset === undefined || isAssetPatch(value.asset))
  );
}

export function isPlaybackCommand(value: unknown): value is HostedPlaybackCommand {
  if (!isRecord(value) || !isIdentifier(value.commandId) || !isIdentifier(value.entityId)) {
    return false;
  }
  if (value.state !== "paused" && value.state !== "playing") return false;
  if (value.type === "media") {
    return (
      isNonnegativeNumber(value.duration) &&
      typeof value.loop === "boolean" &&
      isNonnegativeSafeInteger(value.mediaRevision) &&
      isPositiveNumber(value.playbackRate) &&
      isNonnegativeNumber(value.positionSeconds)
    );
  }
  return (
    value.type === "shader" &&
    isNonnegativeSafeInteger(value.appearanceRevision) &&
    isCoordinate(value.shaderTime)
  );
}

export function isPlaybackAnchor(value: unknown): value is HostedPlaybackAnchor {
  return (
    isRecord(value) &&
    isTimestamp(value.effectiveAtRoomMs) &&
    isNonnegativeSafeInteger(value.sequence) &&
    isPlaybackCommand(value)
  );
}

export function isTimeDependentShader(
  entity: Pick<HostedSceneEntityInput, "shaderParams" | "shaderType">,
): boolean {
  const glass = entity.shaderParams.glass;
  return entity.shaderType === "glass" && isRecord(glass) && glass.kind === "flowing";
}

export function initialEntityRevisions(): HostedEntityRevisions {
  return { appearance: 0, asset: 0, geometry: 0, identity: 0, layering: 0 };
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isIdentityPatch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.edited === "boolean" &&
    typeof value.locked === "boolean" &&
    isBoundedString(value.name, 1_024) &&
    (value.originalPalette === undefined || isJsonObject(value.originalPalette))
  );
}

function isGeometryPatch(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSize(value.originalSize) &&
    isPoint(value.position) &&
    isCoordinate(value.rotation) &&
    isSize(value.size)
  );
}

function isAppearancePatch(value: unknown): boolean {
  return (
    isRecord(value) && isJsonObject(value.shaderParams) && isBoundedString(value.shaderType, 128)
  );
}

function isLayeringPatch(value: unknown): boolean {
  return isRecord(value) && isCoordinate(value.zIndex);
}

function isAssetPatch(value: unknown): boolean {
  return (
    isRecord(value) &&
    isAsset(value.asset) &&
    (value.fps === undefined || value.fps === null || isPositiveNumber(value.fps)) &&
    (value.hasAudio === undefined || typeof value.hasAudio === "boolean") &&
    (value.playbackDuration === undefined || isNonnegativeNumber(value.playbackDuration))
  );
}

function isExpectedRevisions(value: unknown): value is ExpectedEntityRevisions {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(([key, revision]) => isRevisionGroup(key) && isNonnegativeSafeInteger(revision))
  );
}

function isEntityRevisions(value: unknown): value is HostedEntityRevisions {
  return (
    isRecord(value) &&
    isNonnegativeSafeInteger(value.appearance) &&
    isNonnegativeSafeInteger(value.asset) &&
    isNonnegativeSafeInteger(value.geometry) &&
    isNonnegativeSafeInteger(value.identity) &&
    isNonnegativeSafeInteger(value.layering)
  );
}

function isRevisionGroup(value: string): value is HostedEntityRevisionGroup {
  return (
    value === "appearance" ||
    value === "asset" ||
    value === "geometry" ||
    value === "identity" ||
    value === "layering"
  );
}

function isAsset(value: unknown): value is HostedAssetReference {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.byteLength) &&
    Number(value.byteLength) >= 0 &&
    (value.contentHash === undefined ||
      value.contentHash === null ||
      isBoundedString(value.contentHash, 128)) &&
    isBoundedString(value.contentType, 200) &&
    isIdentifier(value.id) &&
    (value.mediaType === "gif" ||
      value.mediaType === "image" ||
      value.mediaType === "svg" ||
      value.mediaType === "video") &&
    isBoundedString(value.originalFilename, 1_024)
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isBoundedJson(value);
}

function isBoundedJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_SHARED_VALUE_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= 1e15;
  if (typeof value === "string") return value.length <= 4_096;
  if (Array.isArray(value)) {
    return value.length <= 128 && value.every((entry) => isBoundedJson(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 256 &&
    entries.every(
      ([key, entry]) => key.length > 0 && key.length <= 256 && isBoundedJson(entry, depth + 1),
    )
  );
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isCoordinate(value.x) && isCoordinate(value.y);
}

function isSize(value: unknown): value is { height: number; width: number } {
  return isRecord(value) && isPositiveNumber(value.height) && isPositiveNumber(value.width);
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e8;
}

function isPositiveNumber(value: unknown): value is number {
  return isCoordinate(value) && value > 0;
}

function isNonnegativeNumber(value: unknown): value is number {
  return isCoordinate(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e15;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function parseJsonObject(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
