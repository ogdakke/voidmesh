import {
  PARTICLE_LIFETIME_MS,
  type DisintegrationOverlay,
} from "../engine/disintegration-controller.ts";
import spawnShaderSource from "./disintegration-spawn.wgsl?raw";
import updateShaderSource from "./disintegration-update.wgsl?raw";
import renderShaderSource from "./disintegration-render.wgsl?raw";

const PARTICLE_COUNT = 15000;
const PARTICLE_STRUCT_SIZE = 48; // bytes per particle
// Params struct: 22 fields × 4 bytes = 88 bytes, rounded up to 16-byte alignment = 96
const PARAMS_BUFFER_SIZE = 96;

interface ParticleOverlayGPU {
  particleBuffer: GPUBuffer;
  paramsBuffer: GPUBuffer;
  spawnBindGroup: GPUBindGroup;
  updateBindGroup: GPUBindGroup;
  renderBindGroup: GPUBindGroup;
  startTime: number;
}

export class DisintegrationParticleSystem {
  #device: GPUDevice;
  #spawnPipeline: GPUComputePipeline | null = null;
  #updatePipeline: GPUComputePipeline | null = null;
  #renderPipeline: GPURenderPipeline | null = null;
  #spawnBindGroupLayout: GPUBindGroupLayout | null = null;
  #updateBindGroupLayout: GPUBindGroupLayout | null = null;
  #renderBindGroupLayout: GPUBindGroupLayout | null = null;
  #overlays = new Map<string, ParticleOverlayGPU>();
  #viewportUniformBuffer: GPUBuffer | null = null;

  // Shared reusable buffer for writing params
  #paramsData = new ArrayBuffer(PARAMS_BUFFER_SIZE);
  #paramsFloat = new Float32Array(this.#paramsData);
  #paramsUint = new Uint32Array(this.#paramsData);

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  async initialize(
    canvasFormat: GPUTextureFormat,
    viewportUniformBuffer: GPUBuffer,
  ): Promise<void> {
    this.#viewportUniformBuffer = viewportUniformBuffer;

    // --- Bind group layouts ---

    this.#spawnBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Particle spawn bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });

    this.#updateBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Particle update bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });

    this.#renderBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Particle render bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });

    // --- Compute pipelines ---

    const spawnModule = this.#device.createShaderModule({
      label: "Particle spawn shader",
      code: spawnShaderSource,
    });

    const updateModule = this.#device.createShaderModule({
      label: "Particle update shader",
      code: updateShaderSource,
    });

    const renderModule = this.#device.createShaderModule({
      label: "Particle render shader",
      code: renderShaderSource,
    });

    this.#spawnPipeline = this.#device.createComputePipeline({
      label: "Particle spawn pipeline",
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#spawnBindGroupLayout],
      }),
      compute: { module: spawnModule, entryPoint: "main" },
    });

    this.#updatePipeline = this.#device.createComputePipeline({
      label: "Particle update pipeline",
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#updateBindGroupLayout],
      }),
      compute: { module: updateModule, entryPoint: "main" },
    });

    this.#renderPipeline = this.#device.createRenderPipeline({
      label: "Particle render pipeline",
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#renderBindGroupLayout],
      }),
      vertex: {
        module: renderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: renderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: canvasFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  spawn(id: string, snapshotTexture: GPUTexture, overlay: DisintegrationOverlay): void {
    if (
      !this.#spawnPipeline ||
      !this.#spawnBindGroupLayout ||
      !this.#updateBindGroupLayout ||
      !this.#renderBindGroupLayout ||
      !this.#viewportUniformBuffer
    )
      return;

    const particleBuffer = this.#device.createBuffer({
      label: `Particle buffer ${id}`,
      size: PARTICLE_COUNT * PARTICLE_STRUCT_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const paramsBuffer = this.#device.createBuffer({
      label: `Particle params ${id}`,
      size: PARAMS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Compute rotation values
    const rotRad = (overlay.rotation * Math.PI) / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    const dissolveSec = overlay.dissolveDuration / 1000;
    const particleLifetimeSec = PARTICLE_LIFETIME_MS / 1000;

    // Particle size scales with entity size
    const maxDim = Math.max(overlay.size.width, overlay.size.height);
    const particleSize = maxDim * 0.004;

    // Write spawn params
    this.#paramsFloat[0] = overlay.position.x; // entityPosition.x
    this.#paramsFloat[1] = overlay.position.y; // entityPosition.y
    this.#paramsFloat[2] = overlay.size.width; // entitySize.x
    this.#paramsFloat[3] = overlay.size.height; // entitySize.y
    this.#paramsFloat[4] = overlay.seed; // seed
    this.#paramsUint[5] = PARTICLE_COUNT; // particleCount
    this.#paramsFloat[6] = dissolveSec; // duration (dissolve sweep duration, for spawn delay calc)
    this.#paramsFloat[7] = particleLifetimeSec; // particleLifetime (time after spawn to fully decay)
    this.#paramsFloat[8] = 0.7; // windX
    this.#paramsFloat[9] = -0.4; // windY (upward in screen coords)
    this.#paramsFloat[10] = maxDim * 0.3; // windStrength (pixels/sec)
    this.#paramsFloat[11] = maxDim * 0.04; // scatterStrength
    this.#paramsFloat[12] = particleSize; // particleSize
    this.#paramsFloat[13] = maxDim * 0.08; // turbulence
    this.#paramsFloat[14] = 0.8; // shrinkRate
    this.#paramsFloat[15] = cosR; // cosR
    this.#paramsFloat[16] = sinR; // sinR
    this.#paramsFloat[17] = 0; // elapsed (0 at spawn)
    this.#paramsFloat[18] = 0; // dt (0 at spawn)
    this.#paramsFloat[19] = maxDim * 0.2; // windAccel

    this.#device.queue.writeBuffer(paramsBuffer, 0, this.#paramsData);

    // Create bind groups
    const snapshotView = snapshotTexture.createView();

    const spawnBindGroup = this.#device.createBindGroup({
      label: `Particle spawn bind group ${id}`,
      layout: this.#spawnBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: snapshotView },
        { binding: 2, resource: { buffer: particleBuffer } },
      ],
    });

    const updateBindGroup = this.#device.createBindGroup({
      label: `Particle update bind group ${id}`,
      layout: this.#updateBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: particleBuffer } },
      ],
    });

    const renderBindGroup = this.#device.createBindGroup({
      label: `Particle render bind group ${id}`,
      layout: this.#renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: particleBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
      ],
    });

    // Dispatch spawn compute
    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#spawnPipeline);
    pass.setBindGroup(0, spawnBindGroup);
    pass.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 64));
    pass.end();
    this.#device.queue.submit([encoder.finish()]);

    this.#overlays.set(id, {
      particleBuffer,
      paramsBuffer,
      spawnBindGroup,
      updateBindGroup,
      renderBindGroup,
      startTime: overlay.startTime,
    });
  }

  update(id: string, elapsed: number, dt: number, encoder: GPUCommandEncoder): void {
    const gpu = this.#overlays.get(id);
    if (!gpu || !this.#updatePipeline) return;

    // Write updated elapsed + dt to params buffer
    this.#paramsFloat[17] = elapsed;
    this.#paramsFloat[18] = dt;
    this.#device.queue.writeBuffer(
      gpu.paramsBuffer,
      17 * 4, // offset to elapsed field
      this.#paramsData,
      17 * 4,
      2 * 4, // only elapsed + dt
    );

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#updatePipeline);
    pass.setBindGroup(0, gpu.updateBindGroup);
    pass.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 64));
    pass.end();
  }

  render(id: string, encoder: GPUCommandEncoder, targetView: GPUTextureView): void {
    const gpu = this.#overlays.get(id);
    if (!gpu || !this.#renderPipeline) return;

    const pass = encoder.beginRenderPass({
      label: `Particle render ${id}`,
      colorAttachments: [
        {
          view: targetView,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(this.#renderPipeline);
    pass.setBindGroup(0, gpu.renderBindGroup);
    pass.draw(6, PARTICLE_COUNT); // 6 vertices per quad × PARTICLE_COUNT instances
    pass.end();
  }

  remove(id: string): void {
    const gpu = this.#overlays.get(id);
    if (!gpu) return;
    gpu.particleBuffer.destroy();
    gpu.paramsBuffer.destroy();
    this.#overlays.delete(id);
  }

  destroy(): void {
    for (const gpu of this.#overlays.values()) {
      gpu.particleBuffer.destroy();
      gpu.paramsBuffer.destroy();
    }
    this.#overlays.clear();
  }
}
