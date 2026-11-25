import { getWlurKawaseLevelSizes, getWlurKawaseRegions, type WlurPixelRegion } from "#wlur";
import { describe, expect, test } from "vitest";

// CPU model of the Kawase pyramid's sampling footprint: the same taps, mirror-repeat addressing
// and bilinear filtering as the shaders, with the upsample always reading its coarser level (the
// shader may skip it, never read more). Comparing a full run with a scissored one, where texels
// outside each scissor stay cleared, proves the composite reads identical values.

interface Image {
  width: number;
  height: number;
  data: Float64Array;
}

function createImage(width: number, height: number): Image {
  return { width, height, data: new Float64Array(width * height) };
}

function mirror(index: number, size: number): number {
  const period = size * 2;
  const wrapped = ((index % period) + period) % period;
  return wrapped < size ? wrapped : period - 1 - wrapped;
}

function sample(image: Image, u: number, v: number): number {
  const x = u * image.width - 0.5;
  const y = v * image.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (ix: number, iy: number) =>
    image.data[mirror(iy, image.height) * image.width + mirror(ix, image.width)]!;
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

function render(
  target: Image,
  region: WlurPixelRegion | null,
  shade: (u: number, v: number) => number,
): void {
  target.data.fill(0);
  const x0 = region?.x ?? 0;
  const y0 = region?.y ?? 0;
  const x1 = region ? region.x + region.width : target.width;
  const y1 = region ? region.y + region.height : target.height;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      target.data[y * target.width + x] = shade((x + 0.5) / target.width, (y + 0.5) / target.height);
    }
  }
}

const DOWN_TAPS: [number, number, number][] = [
  [0, 0, 0.125],
  ...([-2, 2] as const).flatMap((dx) =>
    ([-2, 2] as const).map((dy): [number, number, number] => [dx, dy, 0.03125]),
  ),
  [0, -2, 0.0625],
  [-2, 0, 0.0625],
  [2, 0, 0.0625],
  [0, 2, 0.0625],
  [-1, -1, 0.125],
  [1, -1, 0.125],
  [-1, 1, 0.125],
  [1, 1, 0.125],
];

function runPyramid(
  input: Image,
  levelCount: number,
  spread: number,
  regions: ReturnType<typeof getWlurKawaseRegions> | null,
): Image {
  const sizes = getWlurKawaseLevelSizes(input.width, input.height, levelCount);
  const down = sizes.map((size) => createImage(size.width, size.height));
  const up = sizes.slice(0, -1).map((size) => createImage(size.width, size.height));

  let source = input;
  for (let level = 1; level <= levelCount; level++) {
    const src = source;
    render(down[level - 1]!, regions?.down[level - 1] ?? null, (u, v) =>
      DOWN_TAPS.reduce(
        (sum, [dx, dy, w]) => sum + w * sample(src, u + dx / src.width, v + dy / src.height),
        0,
      ),
    );
    source = down[level - 1]!;
  }

  for (let level = levelCount - 1; level >= 1; level--) {
    const coarser = level === levelCount - 1 ? down[level]! : up[level]!;
    const detail = down[level - 1]!;
    const ox = ((1 + spread) / coarser.width) * 1.2909944487;
    const oy = ((1 + spread) / coarser.height) * 1.2909944487;
    render(up[level - 1]!, regions?.up[level - 1] ?? null, (u, v) => {
      const blurred =
        (sample(coarser, u - ox, v - oy) +
          sample(coarser, u + ox, v - oy) +
          sample(coarser, u - ox, v + oy) +
          sample(coarser, u + ox, v + oy)) *
        0.25;
      return (sample(detail, u, v) + blurred) * 0.5;
    });
  }

  return levelCount > 1 ? up[0]! : down[0]!;
}

function effectContains(
  u: number,
  v: number,
  params: { direction: "down" | "up" | "right" | "left"; offset: number; interpolation: number },
): boolean {
  const { direction, offset, interpolation } = params;
  if (direction === "down") return (v - offset) / interpolation > 0.000001;
  if (direction === "up") return 0.5 - (v - offset) / interpolation > 0.000001;
  if (direction === "right") return (u - offset) / interpolation > 0.000001;
  return 0.5 - (u - offset) / interpolation > 0.000001;
}

describe("getWlurKawaseRegions", () => {
  const cases = [
    { direction: "down", offset: 0.58, interpolation: 0.65, levels: 7, spread: 0.12 },
    { direction: "down", offset: 0.9, interpolation: 0.2, levels: 4, spread: 1 },
    { direction: "up", offset: 0.1, interpolation: 0.5, levels: 5, spread: 4 },
    { direction: "right", offset: 0.7, interpolation: 0.3, levels: 3, spread: 0 },
    { direction: "left", offset: 0.2, interpolation: 0.65, levels: 6, spread: 0.5 },
    { direction: "down", offset: 0.58, interpolation: 0.65, levels: 1, spread: 0.12 },
  ] as const;

  test.each(cases)("scissored pyramid matches the full one where composited: %o", (params) => {
    const width = 157;
    const height = 113;
    const input = createImage(width, height);
    let seed = 1;
    for (let index = 0; index < input.data.length; index++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      input.data[index] = seed / 2147483648;
    }

    const regions = getWlurKawaseRegions(width, height, params.levels, params);
    const full = runPyramid(input, params.levels, params.spread, null);
    const limited = runPyramid(input, params.levels, params.spread, regions);

    let compared = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const v = (y + 0.5) / height;
        if (!effectContains(u, v, params)) continue;
        expect(sample(limited, u, v)).toBe(sample(full, u, v));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  test("limits the upsample chain to the effect band", () => {
    const params = { direction: "down", offset: 0.58, interpolation: 0.65, spread: 0.12 } as const;
    const { down, up } = getWlurKawaseRegions(1280, 720, 7, params);
    expect(up).toHaveLength(6);
    expect(down).toHaveLength(7);
    // Level 1 is 640x360; the effect starts at 0.58 × 720 ≈ 417 px (≈ 209 at level 1).
    expect(up[0]).toEqual({ x: 0, y: 207, width: 640, height: 153 });
    // The deepest level's texels span 128 px, so the downsample chain still needs the frame.
    expect(down[0]).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });

  test("keeps the downsample chain in band when the pyramid is shallow", () => {
    const params = { direction: "down", offset: 0.58, interpolation: 0.65, spread: 0.12 } as const;
    const { down } = getWlurKawaseRegions(1280, 720, 3, params);
    expect(down[0]!.y).toBeGreaterThan(150);
    expect(down[0]!.y + down[0]!.height).toBe(360);
  });
});
