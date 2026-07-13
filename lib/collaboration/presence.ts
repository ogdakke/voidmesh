import { adjectives, nouns } from "#lib/files/filename-words.ts";
import type { CollaborationPeerIdentity, Point, RGBA } from "#types/canvas.ts";

const PEER_COLORS: readonly RGBA[] = [
  [0.96, 0.29, 0.49, 1],
  [0.45, 0.38, 1, 1],
  [0, 0.66, 0.59, 1],
  [0.96, 0.5, 0, 1],
  [0.07, 0.54, 0.78, 1],
  [0.8, 0.28, 0.82, 1],
  [0.2, 0.7, 0.35, 1],
  [0.94, 0.36, 0.2, 1],
  [0.12, 0.69, 0.76, 1],
  [0.67, 0.42, 0.16, 1],
  [0.39, 0.56, 0.93, 1],
  [0.84, 0.22, 0.39, 1],
];

const MAX_SELECTION_IDS = 100_000;

export interface CollaborationPresenceUpdate {
  sequence: number;
  identity?: CollaborationPeerIdentity;
  cursor?: Point | null;
  selectedEntityIds?: string[];
}

export function createPeerIdentity(peerId: string): CollaborationPeerIdentity {
  const hash = hashString(peerId);
  const adjective = adjectives[hash % adjectives.length]!;
  const noun = nouns[Math.floor(hash / adjectives.length) % nouns.length]!;
  return {
    name: `${capitalize(adjective)} ${capitalize(noun)}`,
    color: [...PEER_COLORS[hash % PEER_COLORS.length]!] as RGBA,
  };
}

export function isCollaborationPresenceUpdate(
  value: unknown,
): value is CollaborationPresenceUpdate {
  if (!value || typeof value !== "object") return false;
  const update = value as Partial<CollaborationPresenceUpdate> & Record<string, unknown>;
  if (!Number.isSafeInteger(update.sequence) || Number(update.sequence) < 0) return false;
  if (update.identity !== undefined && !isPeerIdentity(update.identity)) return false;
  if (Object.hasOwn(update, "cursor") && update.cursor !== null && !isPoint(update.cursor)) {
    return false;
  }
  if (update.selectedEntityIds !== undefined) {
    if (
      !Array.isArray(update.selectedEntityIds) ||
      update.selectedEntityIds.length > MAX_SELECTION_IDS ||
      !update.selectedEntityIds.every((id) => typeof id === "string" && id.length > 0)
    ) {
      return false;
    }
  }
  return (
    update.identity !== undefined ||
    Object.hasOwn(update, "cursor") ||
    update.selectedEntityIds !== undefined
  );
}

function isPeerIdentity(value: unknown): value is CollaborationPeerIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<CollaborationPeerIdentity>;
  return (
    typeof identity.name === "string" &&
    identity.name.length > 0 &&
    identity.name.length <= 64 &&
    Array.isArray(identity.color) &&
    identity.color.length === 4 &&
    identity.color.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)
  );
}

function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<Point>;
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Math.abs(Number(point.x)) <= 1e9 &&
    Math.abs(Number(point.y)) <= 1e9
  );
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
