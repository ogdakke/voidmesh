declare module "gifenc" {
  export function GIFEncoder(opt?: {
    initialCapacity?: number;
    auto?: boolean;
  }): GIFEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: "rgb565" | "rgb444" | "rgba4444"; oneBitAlpha?: boolean | number },
  ): [number, number, number][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: [number, number, number][],
    format?: "rgb565" | "rgb444" | "rgba4444",
  ): Uint8Array;

  export function prequantize(
    rgba: Uint8Array | Uint8ClampedArray,
    options?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void;

  export function nearestColorIndex(
    palette: [number, number, number][],
    pixel: [number, number, number],
  ): number;

  export function nearestColor(
    palette: [number, number, number][],
    pixel: [number, number, number],
  ): [number, number, number];

  export function nearestColorIndexWithDistance(
    palette: [number, number, number][],
    pixel: [number, number, number],
  ): [number, number];

  export function snapColorsToPalette(
    palette: [number, number, number][],
    knownColors: [number, number, number][],
    threshold?: number,
  ): void;

  interface GIFEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
    bytesView(): Uint8Array<ArrayBuffer>;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: [number, number, number][];
        delay?: number;
        repeat?: number;
        dispose?: number;
        transparent?: boolean;
        transparentIndex?: number;
      },
    ): void;
  }

  export default GIFEncoder;
}
