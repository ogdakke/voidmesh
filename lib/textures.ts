export function getTextureByteSize(
  width: number,
  height: number,
  format: GPUTextureFormat,
): number {
  switch (format) {
    case "rgba8unorm":
    case "bgra8unorm":
    case "rgba8unorm-srgb":
    case "bgra8unorm-srgb":
      return width * height * 4;
    case "rgba16float":
      return width * height * 8;
    default:
      throw new Error(`Entity texture format ${format} needs an explicit byte-size mapping`);
  }
}
