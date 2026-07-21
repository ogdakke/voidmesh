import type { ShaderParams } from "#types/canvas.ts";

type ShaderParamsIdentity = number | string;

const identities = new WeakMap<ShaderParams, ShaderParamsIdentity>();

/** Attach a shared runtime identity to structurally identical static shader parameters. */
export function registerShaderParamsIdentity(params: ShaderParams, identity: number): void {
  identities.set(params, identity);
}

/**
 * Return a stable identity for the fields that determine static shader output.
 *
 * Imported workspaces register numeric identities while decoding. Other parameter
 * objects pay the serialization cost once, then reuse the cached signature.
 */
export function getStaticShaderParamsIdentity(params: ShaderParams): ShaderParamsIdentity {
  const cached = identities.get(params);
  if (cached !== undefined) return cached;

  const { time: _time, timeAutoPlay: _timeAutoPlay, ...staticParams } = params;
  const signature = JSON.stringify(staticParams);
  identities.set(params, signature);
  return signature;
}

export function haveEquivalentShaderParams(left: ShaderParams, right: ShaderParams): boolean {
  return (
    Object.is(getStaticShaderParamsIdentity(left), getStaticShaderParamsIdentity(right)) &&
    Object.is(left.time, right.time) &&
    Object.is(left.timeAutoPlay, right.timeAutoPlay)
  );
}
