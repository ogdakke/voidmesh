import type { ShaderCanvasEntity } from "#types/canvas.ts";

const REBASABLE_ENTITY_FIELDS = new Set<keyof ShaderCanvasEntity>([
  "position",
  "size",
  "originalSize",
  "shaderParams",
  "originalPalette",
  "playback",
]);

/**
 * Replays or reverses one local edit without replacing unrelated leaves that
 * may have changed remotely since the command was recorded.
 */
export function createRebasedEntityUpdate(
  current: ShaderCanvasEntity,
  before: Partial<ShaderCanvasEntity>,
  after: Partial<ShaderCanvasEntity>,
  target: Partial<ShaderCanvasEntity>,
): Partial<ShaderCanvasEntity> {
  const rebased: Partial<ShaderCanvasEntity> = {};
  for (const key of Object.keys(target) as (keyof ShaderCanvasEntity)[]) {
    const targetValue = target[key];
    const value = REBASABLE_ENTITY_FIELDS.has(key)
      ? rebaseChangedLeaves(current[key], before[key], after[key], targetValue)
      : targetValue;
    (rebased as Record<keyof ShaderCanvasEntity, unknown>)[key] = value;
  }
  return rebased;
}

function rebaseChangedLeaves(
  current: unknown,
  before: unknown,
  after: unknown,
  target: unknown,
): unknown {
  if (sameValue(before, after)) return current;
  if (isPaletteRecord(before) || isPaletteRecord(after) || isPaletteRecord(target)) return target;
  if (isPlainRecord(before) && isPlainRecord(after) && isPlainRecord(target)) {
    const result = isPlainRecord(current) ? { ...current } : {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      result[key] = rebaseChangedLeaves(
        isPlainRecord(current) ? current[key] : undefined,
        before[key],
        after[key],
        target[key],
      );
    }
    return result;
  }
  return target;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left);
    return (
      leftKeys.length === Object.keys(right).length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
    );
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPaletteRecord(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.id === "string" && Array.isArray(value.colors);
}
