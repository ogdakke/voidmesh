import type { GpuColorConfig } from "./gpu-color-space.ts";

export interface ReadRgba8TextureOptions {
  width: number;
  height: number;
  cropWidth?: number;
  cropHeight?: number;
  encoder?: GPUCommandEncoder;
  label?: string;
}

export function createRgba8Texture(
  device: GPUDevice,
  width: number,
  height: number,
  usage: GPUTextureUsageFlags,
  label: string,
): GPUTexture {
  return device.createTexture({
    label,
    size: [width, height],
    format: "rgba8unorm",
    usage,
  });
}

export function uploadExternalImageToTexture(
  device: GPUDevice,
  source: ImageBitmap | OffscreenCanvas | HTMLCanvasElement | HTMLVideoElement | VideoFrame,
  texture: GPUTexture,
  width: number,
  height: number,
  colorConfig?: Pick<GpuColorConfig, "textureColorSpace">,
): void {
  device.queue.copyExternalImageToTexture(
    { source },
    { texture, colorSpace: colorConfig?.textureColorSpace },
    [width, height],
  );
}

export async function readRgba8TextureToPixels(
  device: GPUDevice,
  texture: GPUTexture,
  options: ReadRgba8TextureOptions,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const {
    width,
    height,
    cropWidth = width,
    cropHeight = height,
    label = "Texture readback",
  } = options;
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const bufferSize = bytesPerRow * height;
  const stagingBuffer = device.createBuffer({
    label: `${label} buffer`,
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = options.encoder ?? device.createCommandEncoder({ label: `${label} encoder` });
  encoder.copyTextureToBuffer({ texture }, { buffer: stagingBuffer, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);

  await device.queue.onSubmittedWorkDone();
  await stagingBuffer.mapAsync(GPUMapMode.READ);

  const mapped = stagingBuffer.getMappedRange();
  const source = new Uint8ClampedArray(mapped);
  const data: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    const sourceOffset = y * bytesPerRow;
    const destinationOffset = y * cropWidth * 4;
    data.set(source.subarray(sourceOffset, sourceOffset + cropWidth * 4), destinationOffset);
  }

  stagingBuffer.unmap();
  stagingBuffer.destroy();
  return data;
}

export async function rgba8TextureToImageBitmap(
  device: GPUDevice,
  texture: GPUTexture,
  options: ReadRgba8TextureOptions & { colorSpace?: PredefinedColorSpace },
): Promise<ImageBitmap> {
  const pixels = await readRgba8TextureToPixels(device, texture, options);
  return createImageBitmap(
    new ImageData(
      pixels,
      options.cropWidth ?? options.width,
      options.cropHeight ?? options.height,
      {
        colorSpace: options.colorSpace,
      },
    ),
  );
}
