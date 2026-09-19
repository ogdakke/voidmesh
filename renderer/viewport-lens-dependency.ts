import type { WlurPixelRegion } from "#wlur";
import type { ViewportLensDistortionConfig } from "#types/canvas.ts";

const SAMPLE_STRIDE_PX = 16;
const MAX_AXIS_SEGMENTS = 128;
const LINEAR_FILTER_PADDING_PX = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lensSuperellipsePower(
  config: ViewportLensDistortionConfig,
  width: number,
  height: number,
): number {
  const minDimension = Math.min(width, height);
  const edgeWidthPx = config.radius * minDimension * 0.5;
  const maxRadiusPx = Math.min(32, minDimension * 0.045);
  const cornerRadiusPx = clamp(edgeWidthPx * 0.18, 8, maxRadiusPx);
  const radiusT = clamp((cornerRadiusPx - 8) / Math.max(maxRadiusPx - 8, 1), 0, 1);
  return 24 + (5 - 24) * radiusT;
}

function resolveLensSample(
  u: number,
  v: number,
  channelOffset: number,
  config: ViewportLensDistortionConfig,
  aspect: number,
  power: number,
  output: { u: number; v: number; edge: number; normalX: number; normalY: number },
): void {
  const centeredX = u - 0.5;
  const centeredY = v - 0.5;
  const aspectX = centeredX * aspect;
  const halfX = 0.5 * aspect;
  const normalizedX = Math.abs(aspectX) / Math.max(halfX, 0.0001);
  const normalizedY = Math.abs(centeredY) / 0.5;
  const measure = Math.pow(Math.pow(normalizedX, power) + Math.pow(normalizedY, power), 1 / power);
  const normalizedDistance = clamp(1 - measure, 0, 1);
  const edge = Math.pow(
    1 - smoothstep(0, Math.max(config.radius, 0.0001), normalizedDistance),
    config.falloff,
  );
  output.edge = edge;
  if (edge <= 0.0001) {
    output.u = u;
    output.v = v;
    output.normalX = 0;
    output.normalY = 0;
    return;
  }

  const signX = aspectX >= 0 ? 1 : -1;
  const signY = centeredY >= 0 ? 1 : -1;
  const nx = Math.max(normalizedX, 0.0001);
  const ny = Math.max(normalizedY, 0.0001);
  const gradientX = (signX * Math.pow(nx, power - 1)) / Math.max(halfX, 0.0001);
  const gradientY = (signY * Math.pow(ny, power - 1)) / 0.5;
  const gradientLength = Math.max(Math.hypot(gradientX, gradientY), 0.0001);
  const normalX = gradientX / gradientLength;
  const normalY = gradientY / gradientLength;
  const roll = edge * edge * config.strength * 0.18;
  const stretch = edge * config.strength * 0.08;
  const offset = roll + channelOffset * edge * 0.0035;
  const sampleAspectX = aspectX - normalX * offset;
  const sampleAspectY = centeredY - normalY * offset;
  const scale = 1 - stretch * config.scale;
  output.u = clamp(0.5 + (sampleAspectX / aspect) * scale, 0, 1);
  output.v = clamp(0.5 + sampleAspectY * scale, 0, 1);
  output.normalX = normalX;
  output.normalY = normalY;
}

/**
 * Maps a lens-output region back to the scene pixels sampled by the lens shader.
 * The grid follows the shader's warped RGB and reflection taps, then expands by
 * two sample cells plus linear-filter support to conservatively cover extrema.
 */
export function getViewportLensSourceDependencyRegion(
  outputRegion: WlurPixelRegion,
  width: number,
  height: number,
  config: ViewportLensDistortionConfig,
  output: WlurPixelRegion,
): WlurPixelRegion {
  if (!config.enabled || (config.strength <= 0.001 && config.dispersion <= 0.001)) {
    output.x = outputRegion.x;
    output.y = outputRegion.y;
    output.width = outputRegion.width;
    output.height = outputRegion.height;
    return output;
  }

  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const u0 = clamp(outputRegion.x / safeWidth, 0, 1);
  const v0 = clamp(outputRegion.y / safeHeight, 0, 1);
  const u1 = clamp((outputRegion.x + outputRegion.width) / safeWidth, 0, 1);
  const v1 = clamp((outputRegion.y + outputRegion.height) / safeHeight, 0, 1);
  const xSegments = Math.min(
    MAX_AXIS_SEGMENTS,
    Math.max(1, Math.ceil(outputRegion.width / SAMPLE_STRIDE_PX)),
  );
  const ySegments = Math.min(
    MAX_AXIS_SEGMENTS,
    Math.max(1, Math.ceil(outputRegion.height / SAMPLE_STRIDE_PX)),
  );
  const aspect = safeWidth / safeHeight;
  const power = lensSuperellipsePower(config, safeWidth, safeHeight);
  const sample = { u: 0, v: 0, edge: 0, normalX: 0, normalY: 0 };
  let minU = 1;
  let minV = 1;
  let maxU = 0;
  let maxV = 0;
  const include = (u: number, v: number) => {
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
  };

  for (let yIndex = 0; yIndex <= ySegments; yIndex++) {
    const v = v0 + ((v1 - v0) * yIndex) / ySegments;
    for (let xIndex = 0; xIndex <= xSegments; xIndex++) {
      const u = u0 + ((u1 - u0) * xIndex) / xSegments;
      resolveLensSample(u, v, 0, config, aspect, power, sample);
      const greenU = sample.u;
      const greenV = sample.v;
      const edge = sample.edge;
      const normalU = sample.normalX / aspect;
      const normalV = sample.normalY;
      include(greenU, greenV);

      const dispersion = config.dispersion * edge;
      resolveLensSample(u, v, dispersion, config, aspect, power, sample);
      include(sample.u, sample.v);
      resolveLensSample(u, v, -dispersion, config, aspect, power, sample);
      include(sample.u, sample.v);

      if (config.reflectionIntensity > 0.001) {
        include(
          clamp(greenU - normalU * edge * 0.075, 0, 1),
          clamp(greenV - normalV * edge * 0.075, 0, 1),
        );
        include(
          clamp(greenU - normalU * edge * 0.15, 0, 1),
          clamp(greenV - normalV * edge * 0.15, 0, 1),
        );
        include(
          clamp(greenU - normalU * edge * 0.3, 0, 1),
          clamp(greenV - normalV * edge * 0.3, 0, 1),
        );
      }
    }
  }

  const paddingU = ((u1 - u0) / xSegments) * 2 + LINEAR_FILTER_PADDING_PX / safeWidth;
  const paddingV = ((v1 - v0) / ySegments) * 2 + LINEAR_FILTER_PADDING_PX / safeHeight;
  const sourceX0 = Math.max(0, Math.floor((minU - paddingU) * safeWidth));
  const sourceY0 = Math.max(0, Math.floor((minV - paddingV) * safeHeight));
  const sourceX1 = Math.min(safeWidth, Math.ceil((maxU + paddingU) * safeWidth));
  const sourceY1 = Math.min(safeHeight, Math.ceil((maxV + paddingV) * safeHeight));
  output.x = sourceX0;
  output.y = sourceY0;
  output.width = sourceX1 - sourceX0;
  output.height = sourceY1 - sourceY0;
  return output;
}
