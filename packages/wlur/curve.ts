import {
  DEFAULT_WLUR_CURVE,
  WLUR_CURVE_LUT_SIZE,
  type WlurCurve,
  type WlurCurveInput,
} from "./types.ts";

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 0.0000001;
const SUBDIVISION_MAX_ITERATIONS = 10;
const SPLINE_TABLE_SIZE = 11;
const SAMPLE_STEP = 1 / (SPLINE_TABLE_SIZE - 1);

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function A(a1: number, a2: number): number {
  return 1 - 3 * a2 + 3 * a1;
}

function B(a1: number, a2: number): number {
  return 3 * a2 - 6 * a1;
}

function C(a1: number): number {
  return 3 * a1;
}

function calcBezier(t: number, a1: number, a2: number): number {
  return ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
}

function getSlope(t: number, a1: number, a2: number): number {
  return 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);
}

function binarySubdivide(x: number, a: number, b: number, x1: number, x2: number): number {
  let start = a;
  let end = b;
  let current = 0;

  for (let i = 0; i < SUBDIVISION_MAX_ITERATIONS; i++) {
    current = start + (end - start) / 2;
    const currentX = calcBezier(current, x1, x2) - x;
    if (Math.abs(currentX) <= SUBDIVISION_PRECISION) {
      return current;
    }
    if (currentX > 0) {
      end = current;
    } else {
      start = current;
    }
  }

  return current;
}

function newtonRaphsonIterate(x: number, guessT: number, x1: number, x2: number): number {
  let t = guessT;
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const slope = getSlope(t, x1, x2);
    if (Math.abs(slope) < 0.000001) {
      return t;
    }
    const currentX = calcBezier(t, x1, x2) - x;
    t -= currentX / slope;
  }
  return t;
}

function normalizeCurveParts(parts: readonly number[]): WlurCurve {
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return DEFAULT_WLUR_CURVE;
  }

  return [clamp(parts[0] ?? 0, 0, 1), parts[1] ?? 0, clamp(parts[2] ?? 1, 0, 1), parts[3] ?? 1];
}

export function resolveWlurCurve(input?: WlurCurveInput | null): WlurCurve {
  if (Array.isArray(input) && input.length === 4 && input.every(isFiniteNumber)) {
    return normalizeCurveParts(input);
  }

  return DEFAULT_WLUR_CURVE;
}

function getTForX(x: number, x1: number, x2: number): number {
  const sampleValues = new Float32Array(SPLINE_TABLE_SIZE);
  for (let i = 0; i < SPLINE_TABLE_SIZE; i++) {
    sampleValues[i] = calcBezier(i * SAMPLE_STEP, x1, x2);
  }

  let intervalStart = 0;
  let currentSample = 1;
  const lastSample = SPLINE_TABLE_SIZE - 1;

  while (currentSample !== lastSample && sampleValues[currentSample]! <= x) {
    intervalStart += SAMPLE_STEP;
    currentSample++;
  }
  currentSample--;

  const lower = sampleValues[currentSample]!;
  const upper = sampleValues[currentSample + 1]!;
  const denominator = upper - lower;
  const dist = Math.abs(denominator) <= 0.000001 ? 0 : (x - lower) / denominator;
  const guessForT = intervalStart + dist * SAMPLE_STEP;
  const initialSlope = getSlope(guessForT, x1, x2);

  if (initialSlope >= NEWTON_MIN_SLOPE) {
    return newtonRaphsonIterate(x, guessForT, x1, x2);
  }
  if (Math.abs(initialSlope) <= 0.000001) {
    return guessForT;
  }

  return binarySubdivide(x, intervalStart, intervalStart + SAMPLE_STEP, x1, x2);
}

export function sampleResolvedWlurCurve(curve: WlurCurve, progress: number): number {
  const x = clamp(progress, 0, 1);
  if (x <= 0 || x >= 1) {
    return x;
  }

  const [x1, y1, x2, y2] = curve;
  if (x1 === y1 && x2 === y2) {
    return x;
  }

  const t = getTForX(x, x1, x2);
  return clamp(calcBezier(t, y1, y2), 0, 1);
}

export function sampleWlurCurve(curve: WlurCurveInput | undefined, progress: number): number {
  return sampleResolvedWlurCurve(resolveWlurCurve(curve), progress);
}

export function createWlurCurveLut(
  curve: WlurCurveInput | undefined,
  sampleCount = WLUR_CURVE_LUT_SIZE,
): Float32Array {
  const resolvedCurve = resolveWlurCurve(curve);
  const count = Math.max(2, Math.round(sampleCount));
  const lut = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const progress = i / (count - 1);
    lut[i] = sampleResolvedWlurCurve(resolvedCurve, progress);
  }

  return lut;
}

export function createPackedWlurCurveRows(
  rows: readonly [WlurCurveInput | undefined, WlurCurveInput | undefined],
  sampleCount = WLUR_CURVE_LUT_SIZE,
): Uint8Array {
  const count = Math.max(2, Math.round(sampleCount));
  const data = new Uint8Array(count * 2 * 4);
  const luts = rows.map((curve) => createWlurCurveLut(curve, count));

  for (let row = 0; row < luts.length; row++) {
    const lut = luts[row]!;
    for (let x = 0; x < count; x++) {
      const value = Math.round(clamp(lut[x] ?? 0, 0, 1) * 255);
      const offset = (row * count + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }

  return data;
}

export function getWlurCurveKey(curve: WlurCurveInput | undefined): string {
  return resolveWlurCurve(curve).join(",");
}
