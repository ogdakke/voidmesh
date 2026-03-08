import type { ModelSize, WeightFile } from "./upscale-types.ts";
import { UpscaleComputeLayer } from "./upscale-compute-layer.ts";
import { UpscaleDisplayLayer } from "./upscale-display-layer.ts";
import {
  generateConv3x4,
  generateConv8x4,
  generateConv16x4,
  generateConv56x4,
  generateConv112x4,
  generateConcat2,
  generateDisplay,
} from "./upscale-wgsl.ts";

/** 3x3 kernel offsets as Float32Array (9 vec4f: [-1,-1,0,0] to [1,1,0,0]) */
const KERNEL_OFFSETS = new Float32Array([
  -1, -1, 0, 0, -1, 0, 0, 0, -1, 1, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, -1, 0, 0, 1, 0, 0,
  0, 1, 1, 0, 0,
]);

export interface UpscaleNetwork {
  computeLayers: UpscaleComputeLayer[];
  displayLayer: UpscaleDisplayLayer;
  /** All GPU buffers to destroy after use */
  buffers: GPUBuffer[];
}

/** Create a uniform buffer with the given data */
function createUniformBuffer(device: GPUDevice, label: string, data: Float32Array): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  return buffer;
}

/** Create a storage buffer of the given size */
function createStorageBuffer(device: GPUDevice, label: string, pixelCount: number): GPUBuffer {
  return device.createBuffer({
    label,
    // vec4f per pixel = 16 bytes per pixel
    size: pixelCount * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
}

/**
 * Build the full network graph for the given model size.
 * Returns compute layers (in execution order) + display layer + all GPU buffers.
 */
export function buildNetwork(
  device: GPUDevice,
  model: ModelSize,
  weights: WeightFile,
  width: number,
  height: number,
  inputTexture: GPUTexture,
  outputTexture: GPUTexture,
): UpscaleNetwork {
  const pixelCount = width * height;
  const w = weights.layers;
  const allBuffers: GPUBuffer[] = [];

  // Storage buffer pool (keyed by name for wiring)
  const storageBuffers = new Map<string, GPUBuffer>();
  function getBuffer(name: string): GPUBuffer {
    let buf = storageBuffers.get(name);
    if (!buf) {
      buf = createStorageBuffer(device, `upscale-${name}`, pixelCount);
      storageBuffers.set(name, buf);
      allBuffers.push(buf);
    }
    return buf;
  }

  // Shared kernel offsets uniform
  const kernelOffsetsBuffer = createUniformBuffer(device, "upscale-kernel-offsets", KERNEL_OFFSETS);
  allBuffers.push(kernelOffsetsBuffer);

  // Sampler for display layer
  const sampler = device.createSampler({
    addressModeU: "repeat",
    addressModeV: "repeat",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
  });

  const computeLayers: UpscaleComputeLayer[] = [];

  /** Helper: create a Conv3x4 layer (texture → buffer) */
  function addConv3x4(weightKey: string, outputName: string): void {
    const layer = w[weightKey]!;
    const kernelsBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-kernels`,
      new Float32Array(layer.weights),
    );
    const biasBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-bias`,
      new Float32Array(layer.bias),
    );
    allBuffers.push(kernelsBuffer, biasBuffer);

    computeLayers.push(
      new UpscaleComputeLayer(
        device,
        `conv3x4-${weightKey}`,
        generateConv3x4(width),
        [
          { binding: 0, resource: inputTexture.createView() },
          { binding: 1, resource: { buffer: kernelOffsetsBuffer } },
          { binding: 2, resource: { buffer: kernelsBuffer } },
          { binding: 3, resource: { buffer: biasBuffer } },
          { binding: 4, resource: { buffer: getBuffer(outputName) } },
        ],
        width,
        height,
      ),
    );
  }

  /** Helper: create a Conv8x4 layer (buffer → buffer) */
  function addConv8x4(weightKey: string, inputName: string, outputName: string): void {
    const layer = w[weightKey]!;
    const kernelsBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-kernels`,
      new Float32Array(layer.weights),
    );
    const biasBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-bias`,
      new Float32Array(layer.bias),
    );
    allBuffers.push(kernelsBuffer, biasBuffer);

    computeLayers.push(
      new UpscaleComputeLayer(
        device,
        `conv8x4-${weightKey}`,
        generateConv8x4(width),
        [
          { binding: 0, resource: { buffer: getBuffer(inputName) } },
          { binding: 1, resource: { buffer: kernelOffsetsBuffer } },
          { binding: 2, resource: { buffer: kernelsBuffer } },
          { binding: 3, resource: { buffer: biasBuffer } },
          { binding: 4, resource: { buffer: getBuffer(outputName) } },
        ],
        width,
        height,
      ),
    );
  }

  /** Helper: create a Conv16x4 layer (2 buffers → buffer) */
  function addConv16x4(
    weightKey: string,
    input0: string,
    input1: string,
    outputName: string,
  ): void {
    const layer = w[weightKey]!;
    const kernelsBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-kernels`,
      new Float32Array(layer.weights),
    );
    const biasBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-bias`,
      new Float32Array(layer.bias),
    );
    allBuffers.push(kernelsBuffer, biasBuffer);

    computeLayers.push(
      new UpscaleComputeLayer(
        device,
        `conv16x4-${weightKey}`,
        generateConv16x4(width),
        [
          { binding: 0, resource: { buffer: getBuffer(input0) } },
          { binding: 1, resource: { buffer: getBuffer(input1) } },
          { binding: 2, resource: { buffer: kernelOffsetsBuffer } },
          { binding: 3, resource: { buffer: kernelsBuffer } },
          { binding: 4, resource: { buffer: biasBuffer } },
          { binding: 5, resource: { buffer: getBuffer(outputName) } },
        ],
        width,
        height,
      ),
    );
  }

  /** Helper: create a Conv56x4 layer (7 buffers → buffer) */
  function addConv56x4(weightKey: string, inputs: string[], outputName: string): void {
    const layer = w[weightKey]!;
    const kernelsBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-kernels`,
      new Float32Array(layer.weights),
    );
    const biasBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-bias`,
      new Float32Array(layer.bias),
    );
    allBuffers.push(kernelsBuffer, biasBuffer);

    const entries: GPUBindGroupEntry[] = inputs.map((name, i) => ({
      binding: i,
      resource: { buffer: getBuffer(name) },
    }));
    entries.push({ binding: 7, resource: { buffer: kernelsBuffer } });
    entries.push({ binding: 8, resource: { buffer: biasBuffer } });
    entries.push({ binding: 9, resource: { buffer: getBuffer(outputName) } });

    computeLayers.push(
      new UpscaleComputeLayer(
        device,
        `conv56x4-${weightKey}`,
        generateConv56x4(width),
        entries,
        width,
        height,
      ),
    );
  }

  /** Helper: create a Conv112x4 layer (7 buffers → buffer) */
  function addConv112x4(
    weightKey: string,
    inputs: string[],
    outputName: string,
    first: boolean,
  ): void {
    const layer = w[weightKey]!;
    const kernelsBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-kernels-${first ? "first" : "second"}`,
      new Float32Array(layer.weights),
    );
    allBuffers.push(kernelsBuffer);

    const entries: GPUBindGroupEntry[] = inputs.map((name, i) => ({
      binding: i,
      resource: { buffer: getBuffer(name) },
    }));
    entries.push({ binding: 7, resource: { buffer: kernelsBuffer } });
    entries.push({ binding: 8, resource: { buffer: getBuffer(outputName) } });

    computeLayers.push(
      new UpscaleComputeLayer(
        device,
        `conv112x4-${weightKey}-${first ? "first" : "second"}`,
        generateConv112x4(width, first),
        entries,
        width,
        height,
      ),
    );
  }

  /** Helper: create a Concat2 layer (2 buffers → buffer) */
  function addConcat2(weightKey: string, input0: string, input1: string, outputName: string): void {
    const layer = w[weightKey]!;
    const biasBuffer = createUniformBuffer(
      device,
      `upscale-${weightKey}-bias`,
      new Float32Array(layer.bias),
    );
    allBuffers.push(biasBuffer);

    computeLayers.push(
      new UpscaleComputeLayer(
        device,
        `concat2-${weightKey}`,
        generateConcat2(width),
        [
          { binding: 0, resource: { buffer: getBuffer(input0) } },
          { binding: 1, resource: { buffer: getBuffer(input1) } },
          { binding: 2, resource: { buffer: biasBuffer } },
          { binding: 3, resource: { buffer: getBuffer(outputName) } },
        ],
        width,
        height,
      ),
    );
  }

  // Build model-specific graph
  if (model === "s") {
    buildSmallModel();
  } else if (model === "m") {
    buildMediumModel();
  } else {
    buildLargeModel();
  }

  function buildSmallModel(): void {
    addConv3x4("conv2d_tf", "conv2d_tf");
    addConv8x4("conv2d_1_tf", "conv2d_tf", "conv2d_1_tf");
    addConv8x4("conv2d_2_tf", "conv2d_1_tf", "conv2d_2_tf");
    addConv8x4("conv2d_last_tf", "conv2d_2_tf", "conv2d_last_tf");
  }

  function buildMediumModel(): void {
    addConv3x4("conv2d_tf", "conv2d_tf");
    addConv8x4("conv2d_1_tf", "conv2d_tf", "conv2d_1_tf");
    addConv8x4("conv2d_2_tf", "conv2d_1_tf", "conv2d_2_tf");
    addConv8x4("conv2d_3_tf", "conv2d_2_tf", "conv2d_3_tf");
    addConv8x4("conv2d_4_tf", "conv2d_3_tf", "conv2d_4_tf");
    addConv8x4("conv2d_5_tf", "conv2d_4_tf", "conv2d_5_tf");
    addConv8x4("conv2d_6_tf", "conv2d_5_tf", "conv2d_6_tf");

    const skipInputs = [
      "conv2d_tf",
      "conv2d_1_tf",
      "conv2d_2_tf",
      "conv2d_3_tf",
      "conv2d_4_tf",
      "conv2d_5_tf",
      "conv2d_6_tf",
    ];

    addConv56x4("conv2d_7_tf", skipInputs, "conv2d_7_tf");
    addConv56x4("conv2d_7_tf1", skipInputs, "conv2d_7_tf1");
    addConv56x4("conv2d_7_tf2", skipInputs, "conv2d_7_tf2");
  }

  function buildLargeModel(): void {
    // Two parallel initial convolutions
    addConv3x4("conv2d_tf", "conv2d_tf");
    addConv3x4("conv2d_tf1", "conv2d_tf1");

    // 6 paired Conv16x4 stages
    for (let i = 1; i < 7; i++) {
      const source = i === 1 ? "conv2d_tf" : `conv2d_${i - 1}_tf`;
      addConv16x4(`conv2d_${i}_tf`, source, `${source}1`, `conv2d_${i}_tf`);
      addConv16x4(`conv2d_${i}_tf1`, source, `${source}1`, `conv2d_${i}_tf1`);
    }

    // 3 output channels via Conv112x4 + Concat2
    for (let c = 0; c < 3; c++) {
      const sources0: string[] = [];
      const sources1: string[] = [];
      for (let i = 0; i < 7; i++) {
        const name = i === 0 ? "conv2d_tf" : `conv2d_${i}_tf`;
        sources0.push(name);
        sources1.push(`${name}1`);
      }

      const dest = c === 0 ? "conv2d_last_tf" : `conv2d_last_tf${c}`;
      addConv112x4(dest, sources0, `conv2d_last_${c}_pt1`, true);
      addConv112x4(dest, sources1, `conv2d_last_${c}_pt2`, false);
      addConcat2(dest, `conv2d_last_${c}_pt1`, `conv2d_last_${c}_pt2`, dest);
    }
  }

  // Display layer
  const displayChannels: 1 | 3 = model === "s" ? 1 : 3;
  const displayWgsl = generateDisplay(width, height, displayChannels);

  let displayEntries: GPUBindGroupEntry[];
  if (model === "s") {
    displayEntries = [
      { binding: 0, resource: { buffer: getBuffer("conv2d_last_tf") } },
      { binding: 1, resource: inputTexture.createView() },
      { binding: 2, resource: sampler },
    ];
  } else if (model === "m") {
    // M model: 3 parallel Conv56x4 outputs
    displayEntries = [
      { binding: 0, resource: { buffer: getBuffer("conv2d_7_tf") } },
      { binding: 1, resource: { buffer: getBuffer("conv2d_7_tf1") } },
      { binding: 2, resource: { buffer: getBuffer("conv2d_7_tf2") } },
      { binding: 3, resource: inputTexture.createView() },
      { binding: 4, resource: sampler },
    ];
  } else {
    // L model: 3 Concat2 outputs
    displayEntries = [
      { binding: 0, resource: { buffer: getBuffer("conv2d_last_tf") } },
      { binding: 1, resource: { buffer: getBuffer("conv2d_last_tf1") } },
      { binding: 2, resource: { buffer: getBuffer("conv2d_last_tf2") } },
      { binding: 3, resource: inputTexture.createView() },
      { binding: 4, resource: sampler },
    ];
  }

  const displayLayer = new UpscaleDisplayLayer(
    device,
    "upscale-display",
    displayWgsl,
    displayEntries,
    outputTexture.format,
  );

  return { computeLayers, displayLayer, buffers: allBuffers };
}
