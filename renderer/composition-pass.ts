import { config } from "#config";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import compositionShaderSource from "./composition.wgsl?raw";

export type CompositionSource =
  | { kind: "texture"; texture: GPUTexture }
  | { kind: "external"; texture: GPUExternalTexture };

export interface CompositionDrawItem {
  bindGroup: GPUBindGroup;
  pipeline: "texture" | "external";
  entity: ShaderCanvasEntity;
  isSelected: boolean;
  offsetX: number;
  offsetY: number;
}

export interface CompositionPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  viewportUniformBuffer: GPUBuffer;
}

export interface PrepareCompositionItemOptions {
  entity: ShaderCanvasEntity;
  source: CompositionSource;
  isHovered: boolean;
  isSelected: boolean;
  debugMode: boolean;
  positionOffsetX: number;
  positionOffsetY: number;
  visualScale: number;
}

export interface DisintegrationCompositionUniforms {
  position: { x: number; y: number };
  size: { width: number; height: number };
  rotation: number;
  progress: number;
  seed: number;
}

function createExternalCompositionShaderSource(source: string): string {
  const rewritten = source
    .replace(
      /@group\(0\)\s+@binding\(2\)\s+var\s+entityTexture\s*:\s*texture_2d<f32>;/,
      "@group(0) @binding(2) var entityTexture: texture_external;",
    )
    .replace(
      /textureSample\(entityTexture,\s*entitySampler,/g,
      "textureSampleBaseClampToEdge(entityTexture, entitySampler,",
    );

  if (rewritten === source || !rewritten.includes("texture_external")) {
    throw new Error("Failed to rewrite composition shader source for external texture input.");
  }
  return rewritten;
}

export class CompositionPass {
  readonly #device: GPUDevice;
  readonly #viewportUniformBuffer: GPUBuffer;
  readonly #pipeline: GPURenderPipeline;
  readonly #externalPipeline: GPURenderPipeline;
  readonly #bindGroupLayout: GPUBindGroupLayout;
  readonly #externalBindGroupLayout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #entityUniformData = new ArrayBuffer(config.rendering.entityUniformSize);
  readonly #entityFloatView = new Float32Array(this.#entityUniformData);
  readonly #entityUintView = new Uint32Array(this.#entityUniformData);

  // Entity composition cache (uniform buffers, bind groups, texture views).
  // Invalidated when entity composition texture or visual state changes.
  readonly #entityCompositionCache: Map<
    string,
    {
      uniformBuffer: GPUBuffer;
      texture: GPUTexture;
      textureView: GPUTextureView;
      bindGroup: GPUBindGroup;
      lastHovered: boolean;
      lastSelected: boolean;
      lastDebugMode: boolean;
    }
  > = new Map();

  readonly #entityExternalCompositionCache: Map<
    string,
    {
      uniformBuffer: GPUBuffer;
    }
  > = new Map();

  constructor(options: CompositionPassOptions) {
    this.#device = options.device;
    this.#viewportUniformBuffer = options.viewportUniformBuffer;

    const shaderModule = this.#device.createShaderModule({
      label: "Composition shader",
      code: compositionShaderSource,
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Composition bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.#externalBindGroupLayout = this.#device.createBindGroupLayout({
      label: "External composition bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.#sampler = this.#device.createSampler({
      label: "Composition sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Composition pipeline layout",
      bindGroupLayouts: [this.#bindGroupLayout],
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Composition pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: options.format,
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
      primitive: {
        topology: "triangle-list",
      },
    });

    const externalShaderModule = this.#device.createShaderModule({
      label: "External composition shader",
      code: createExternalCompositionShaderSource(compositionShaderSource),
    });

    const externalPipelineLayout = this.#device.createPipelineLayout({
      label: "External composition pipeline layout",
      bindGroupLayouts: [this.#externalBindGroupLayout],
    });

    this.#externalPipeline = this.#device.createRenderPipeline({
      label: "External composition pipeline",
      layout: externalPipelineLayout,
      vertex: {
        module: externalShaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: externalShaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: options.format,
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
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  prepareDrawItem(options: PrepareCompositionItemOptions): CompositionDrawItem {
    const { entity, source, isHovered, isSelected, debugMode, positionOffsetX, positionOffsetY } =
      options;

    if (source.kind === "texture") {
      const cached = this.#entityCompositionCache.get(entity.id);
      const textureChanged = cached?.texture !== source.texture;
      const needsNewBindGroup =
        !cached ||
        textureChanged ||
        cached.lastHovered !== isHovered ||
        cached.lastSelected !== isSelected ||
        cached.lastDebugMode !== debugMode;

      if (needsNewBindGroup) {
        const uniformBuffer =
          cached?.uniformBuffer ??
          this.#device.createBuffer({
            label: `Entity ${entity.id} composition uniform`,
            size: config.rendering.entityUniformSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });

        this.#writeLiveEntityUniforms(uniformBuffer, options);

        const textureView =
          cached && !textureChanged ? cached.textureView : source.texture.createView();
        const bindGroup = this.#device.createBindGroup({
          label: `Entity ${entity.id} composition bind group`,
          layout: this.#bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
            { binding: 1, resource: { buffer: uniformBuffer } },
            { binding: 2, resource: textureView },
            { binding: 3, resource: this.#sampler },
          ],
        });

        this.#entityCompositionCache.set(entity.id, {
          uniformBuffer,
          texture: source.texture,
          textureView,
          bindGroup,
          lastHovered: isHovered,
          lastSelected: isSelected,
          lastDebugMode: debugMode,
        });

        return {
          bindGroup,
          pipeline: "texture",
          entity,
          isSelected,
          offsetX: positionOffsetX,
          offsetY: positionOffsetY,
        };
      }

      // Reuse cached bind group, but always update uniforms for drag/position changes.
      this.#writeLiveEntityUniforms(cached.uniformBuffer, options);
      return {
        bindGroup: cached.bindGroup,
        pipeline: "texture",
        entity,
        isSelected,
        offsetX: positionOffsetX,
        offsetY: positionOffsetY,
      };
    }

    const cached = this.#entityExternalCompositionCache.get(entity.id);
    const uniformBuffer =
      cached?.uniformBuffer ??
      this.#device.createBuffer({
        label: `Entity ${entity.id} external composition uniform`,
        size: config.rendering.entityUniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    this.#writeLiveEntityUniforms(uniformBuffer, options);

    const bindGroup = this.#device.createBindGroup({
      label: `Entity ${entity.id} external composition bind group`,
      layout: this.#externalBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: source.texture },
        { binding: 3, resource: this.#sampler },
      ],
    });

    if (!cached) {
      this.#entityExternalCompositionCache.set(entity.id, { uniformBuffer });
    }

    return {
      bindGroup,
      pipeline: "external",
      entity,
      isSelected,
      offsetX: positionOffsetX,
      offsetY: positionOffsetY,
    };
  }

  drawItem(pass: GPURenderPassEncoder, item: CompositionDrawItem): void {
    pass.setPipeline(item.pipeline === "external" ? this.#externalPipeline : this.#pipeline);
    pass.setBindGroup(0, item.bindGroup);
    pass.draw(6);
  }

  createTextureBindGroup(
    label: string,
    textureView: GPUTextureView,
    uniformBuffer: GPUBuffer,
  ): GPUBindGroup {
    return this.#device.createBindGroup({
      label,
      layout: this.#bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: textureView },
        { binding: 3, resource: this.#sampler },
      ],
    });
  }

  writeDisintegrationUniforms(
    uniformBuffer: GPUBuffer,
    uniforms: DisintegrationCompositionUniforms,
  ): void {
    this.#entityFloatView[0] = uniforms.position.x;
    this.#entityFloatView[1] = uniforms.position.y;
    this.#entityFloatView[2] = uniforms.size.width;
    this.#entityFloatView[3] = uniforms.size.height;
    this.#entityFloatView[4] = (uniforms.rotation * Math.PI) / 180;
    this.#entityUintView[5] = 0;
    this.#entityUintView[6] = 0;
    this.#entityUintView[7] = 0;
    this.#entityFloatView[8] = 1.0;
    this.#entityFloatView[9] = uniforms.progress;
    this.#entityFloatView[10] = uniforms.seed;
    this.#entityFloatView[11] = 0;

    this.#device.queue.writeBuffer(uniformBuffer, 0, this.#entityUniformData);
  }

  drawTextureBindGroup(pass: GPURenderPassEncoder, bindGroup: GPUBindGroup): void {
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
  }

  removeEntity(entityId: string): void {
    const cached = this.#entityCompositionCache.get(entityId);
    if (cached) {
      cached.uniformBuffer.destroy();
      this.#entityCompositionCache.delete(entityId);
    }

    const externalCached = this.#entityExternalCompositionCache.get(entityId);
    if (externalCached) {
      externalCached.uniformBuffer.destroy();
      this.#entityExternalCompositionCache.delete(entityId);
    }
  }

  destroy(): void {
    for (const cached of this.#entityCompositionCache.values()) {
      cached.uniformBuffer.destroy();
    }
    this.#entityCompositionCache.clear();

    for (const cached of this.#entityExternalCompositionCache.values()) {
      cached.uniformBuffer.destroy();
    }
    this.#entityExternalCompositionCache.clear();
  }

  #writeLiveEntityUniforms(uniformBuffer: GPUBuffer, options: PrepareCompositionItemOptions): void {
    const {
      entity,
      isHovered,
      isSelected,
      debugMode,
      positionOffsetX,
      positionOffsetY,
      visualScale,
    } = options;
    this.#entityFloatView[0] = entity.position.x + positionOffsetX;
    this.#entityFloatView[1] = entity.position.y + positionOffsetY;
    this.#entityFloatView[2] = entity.size.width;
    this.#entityFloatView[3] = entity.size.height;
    this.#entityFloatView[4] = (entity.rotation * Math.PI) / 180;
    this.#entityUintView[5] = isHovered ? 1 : 0;
    this.#entityUintView[6] = isSelected ? 1 : 0;
    this.#entityUintView[7] = debugMode ? 1 : 0;
    this.#entityFloatView[8] = visualScale;
    this.#entityFloatView[9] = 0;
    this.#entityFloatView[10] = 0;
    this.#entityFloatView[11] = 0;

    this.#device.queue.writeBuffer(uniformBuffer, 0, this.#entityUniformData);
  }
}
