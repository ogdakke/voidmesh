import { GlassKind } from "#types/canvas.ts";
import type { EffectRenderEntity } from "../effect-render-entity.ts";
import glassFlowingSource from "../glass-flowing.wgsl?raw";
import glassFlutedSource from "../glass-fluted.wgsl?raw";
import glassFrostedSource from "../glass-frosted.wgsl?raw";
import {
  createExternalTextureShaderSource,
  type ExternalTextureSource,
  ShaderPass,
} from "./shader-pass.ts";

const FLOWING_IMMEDIATE_DECLARATION = `
struct FlowingGlassImmediates {
  time: f32,
}

var<immediate> immediates: FlowingGlassImmediates;
`;

function createFlowingImmediateShaderSource(source: string): string {
  const rewritten = source
    .replace(
      /@group\(0\)\s+@binding\(2\)\s+var\s+sourceSampler\s*:\s*sampler;/,
      `$&\n${FLOWING_IMMEDIATE_DECLARATION}`,
    )
    .replace(/\buniforms\.time\b/g, "immediates.time");

  if (rewritten === source || !rewritten.includes("var<immediate>")) {
    throw new Error("Failed to create flowing glass immediate shader source.");
  }
  return rewritten;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export class GlassShader extends ShaderPass {
  #flutedPipeline: GPURenderPipeline | null = null;
  #flowingPipeline: GPURenderPipeline | null = null;
  #flowingImmediatePipeline: GPURenderPipeline | null = null;
  #externalFlutedPipeline: GPURenderPipeline | null = null;
  #externalFlowingPipeline: GPURenderPipeline | null = null;
  #externalFlowingImmediatePipeline: GPURenderPipeline | null = null;
  #flowingImmediateData = new Float32Array(1);
  #flowingImmediateUniformBuffers = new Map<string, GPUBuffer>();
  #flowingImmediateUniformDataCache = new Map<string, Uint8Array>();

  /** Per-entity last frame timestamps for delta-time calculation */
  #lastFrameTimes = new Map<string, number>();

  override needsContinuousRender(entity: EffectRenderEntity): boolean {
    return (
      entity.shaderParams.glass?.kind === GlassKind.flowing &&
      entity.shaderParams.timeAutoPlay !== false
    );
  }

  /** Default shader source (frosted) - used by base class pipeline creation */
  getShaderSource(): string {
    return glassFrostedSource;
  }

  override async initialize(): Promise<void> {
    // Frosted pipeline (default, stored in this.pipeline via base class)
    this.bindGroupLayout = this.createBindGroupLayout();
    this.pipeline = this.createPipeline();
    this.externalBindGroupLayout = this.createExternalBindGroupLayout();
    this.externalPipeline = this.createExternalPipeline();

    // Fluted pipeline (separate render pipeline, same bind group layout)
    const flutedModule = this.ctx.device.createShaderModule({
      label: "GlassShader fluted shader",
      code: glassFlutedSource,
    });
    const pipelineLayout = this.ctx.device.createPipelineLayout({
      label: "GlassShader fluted pipeline layout",
      bindGroupLayouts: [this.bindGroupLayout!],
    });
    this.#flutedPipeline = this.ctx.device.createRenderPipeline({
      label: "GlassShader fluted pipeline",
      layout: pipelineLayout,
      vertex: { module: flutedModule, entryPoint: "vs_main" },
      fragment: {
        module: flutedModule,
        entryPoint: "fs_main",
        targets: [{ format: this.ctx.intermediateFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
    const externalFlutedModule = this.ctx.device.createShaderModule({
      label: "GlassShader external fluted shader",
      code: createExternalTextureShaderSource(glassFlutedSource),
    });
    const externalFlutedPipelineLayout = this.ctx.device.createPipelineLayout({
      label: "GlassShader external fluted pipeline layout",
      bindGroupLayouts: [this.externalBindGroupLayout!],
    });
    this.#externalFlutedPipeline = this.ctx.device.createRenderPipeline({
      label: "GlassShader external fluted pipeline",
      layout: externalFlutedPipelineLayout,
      vertex: { module: externalFlutedModule, entryPoint: "vs_main" },
      fragment: {
        module: externalFlutedModule,
        entryPoint: "fs_main",
        targets: [{ format: this.ctx.intermediateFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    // Flowing pipeline (separate render pipeline, same bind group layout)
    const flowingModule = this.ctx.device.createShaderModule({
      label: "GlassShader flowing shader",
      code: glassFlowingSource,
    });
    const flowingPipelineLayout = this.ctx.device.createPipelineLayout({
      label: "GlassShader flowing pipeline layout",
      bindGroupLayouts: [this.bindGroupLayout!],
    });
    this.#flowingPipeline = this.ctx.device.createRenderPipeline({
      label: "GlassShader flowing pipeline",
      layout: flowingPipelineLayout,
      vertex: { module: flowingModule, entryPoint: "vs_main" },
      fragment: {
        module: flowingModule,
        entryPoint: "fs_main",
        targets: [{ format: this.ctx.intermediateFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
    const externalFlowingModule = this.ctx.device.createShaderModule({
      label: "GlassShader external flowing shader",
      code: createExternalTextureShaderSource(glassFlowingSource),
    });
    const externalFlowingPipelineLayout = this.ctx.device.createPipelineLayout({
      label: "GlassShader external flowing pipeline layout",
      bindGroupLayouts: [this.externalBindGroupLayout!],
    });
    this.#externalFlowingPipeline = this.ctx.device.createRenderPipeline({
      label: "GlassShader external flowing pipeline",
      layout: externalFlowingPipelineLayout,
      vertex: { module: externalFlowingModule, entryPoint: "vs_main" },
      fragment: {
        module: externalFlowingModule,
        entryPoint: "fs_main",
        targets: [{ format: this.ctx.intermediateFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    if (this.ctx.supportsImmediates) {
      const flowingImmediateSource = createFlowingImmediateShaderSource(glassFlowingSource);
      const flowingImmediateModule = this.ctx.device.createShaderModule({
        label: "GlassShader flowing immediate shader",
        code: flowingImmediateSource,
      });
      const flowingImmediatePipelineLayout = this.ctx.device.createPipelineLayout({
        label: "GlassShader flowing immediate pipeline layout",
        bindGroupLayouts: [this.bindGroupLayout!],
        immediateSize: 4,
      });
      this.#flowingImmediatePipeline = this.ctx.device.createRenderPipeline({
        label: "GlassShader flowing immediate pipeline",
        layout: flowingImmediatePipelineLayout,
        vertex: { module: flowingImmediateModule, entryPoint: "vs_main" },
        fragment: {
          module: flowingImmediateModule,
          entryPoint: "fs_main",
          targets: [{ format: this.ctx.intermediateFormat }],
        },
        primitive: { topology: "triangle-list" },
      });

      const externalFlowingImmediateModule = this.ctx.device.createShaderModule({
        label: "GlassShader external flowing immediate shader",
        code: createExternalTextureShaderSource(flowingImmediateSource),
      });
      const externalFlowingImmediatePipelineLayout = this.ctx.device.createPipelineLayout({
        label: "GlassShader external flowing immediate pipeline layout",
        bindGroupLayouts: [this.externalBindGroupLayout!],
        immediateSize: 4,
      });
      this.#externalFlowingImmediatePipeline = this.ctx.device.createRenderPipeline({
        label: "GlassShader external flowing immediate pipeline",
        layout: externalFlowingImmediatePipelineLayout,
        vertex: { module: externalFlowingImmediateModule, entryPoint: "vs_main" },
        fragment: {
          module: externalFlowingImmediateModule,
          entryPoint: "fs_main",
          targets: [{ format: this.ctx.intermediateFormat }],
        },
        primitive: { topology: "triangle-list" },
      });
    }
  }

  writeVariantUniforms(entity: EffectRenderEntity): void {
    const glassKind = entity.shaderParams.glass?.kind ?? GlassKind.frostedVoronoi;

    if (glassKind === GlassKind.fluted) {
      // Fluted: offset 5 = caustic, offset 6 = dispersion, offset 7 = angle
      this.ctx.floatView[5] = entity.shaderParams.glass?.caustic ?? 1.0;
      this.ctx.floatView[6] = entity.shaderParams.glass?.dispersion ?? 0.6;
      this.ctx.floatView[7] = entity.shaderParams.glass?.angle ?? 0;
    } else if (glassKind === GlassKind.flowing) {
      // Flowing: offset 5 = dispersion, offset 6 = time (per-entity), offset 7 = flow
      this.ctx.floatView[5] = entity.shaderParams.glass?.dispersion ?? 0.3;
      this.ctx.floatView[6] = entity.shaderParams.time ?? 0;
      this.ctx.floatView[7] = entity.shaderParams.glass?.flow ?? 0.5;
    } else {
      // Frosted: offset 5 = highlight, offset 6 = dispersion, offset 7 = frostiness
      this.ctx.floatView[5] = entity.shaderParams.glass?.highlight ?? 0.5;
      this.ctx.floatView[6] = entity.shaderParams.glass?.dispersion ?? 0.6;
      this.ctx.floatView[7] = entity.shaderParams.glass?.frostiness ?? 0.4;
    }
  }

  override execute(
    entity: EffectRenderEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    const glassKind = entity.shaderParams.glass?.kind ?? GlassKind.frostedVoronoi;

    if (glassKind === GlassKind.fluted) {
      this.#executeFluted(entity, sourceTexture, outputTexture, encoder);
    } else if (glassKind === GlassKind.flowing) {
      this.#executeFlowing(entity, sourceTexture, outputTexture, encoder);
    } else {
      super.execute(entity, sourceTexture, outputTexture, encoder);
    }
  }

  override executeExternal(
    entity: EffectRenderEntity,
    source: ExternalTextureSource,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    const glassKind = entity.shaderParams.glass?.kind ?? GlassKind.frostedVoronoi;

    if (glassKind === GlassKind.fluted) {
      this.#executeExternalVariant(
        entity,
        source,
        outputTexture,
        encoder,
        this.#externalFlutedPipeline,
        "GlassShader external fluted render pass",
      );
    } else if (glassKind === GlassKind.flowing) {
      const pipeline = this.#externalFlowingImmediatePipeline ?? this.#externalFlowingPipeline;
      this.#executeExternalVariant(
        entity,
        source,
        outputTexture,
        encoder,
        pipeline,
        "GlassShader external flowing render pass",
        this.#externalFlowingImmediatePipeline ? "flowingImmediate" : "uniform",
      );
      this.#advanceFlowingTime(entity);
    } else {
      super.executeExternal(entity, source, outputTexture, encoder);
    }
  }

  #executeExternalVariant(
    entity: EffectRenderEntity,
    source: ExternalTextureSource,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline | null,
    label: string,
    mode: "uniform" | "flowingImmediate" = "uniform",
  ): void {
    if (!pipeline) return;

    const uniformBuffer =
      mode === "flowingImmediate"
        ? this.#writeFlowingImmediateUniformBuffer(entity)
        : this.writeEntityUniformBuffer(entity);
    const bindGroup = this.createExternalBindGroup(source, uniformBuffer);

    const pass = encoder.beginRenderPass({
      label,
      colorAttachments: [
        {
          view: this.getTextureView(outputTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    if (mode === "flowingImmediate") this.#setFlowingTimeImmediate(pass, entity);
    pass.draw(3);
    pass.end();
  }

  #executeFluted(
    entity: EffectRenderEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    if (!this.#flutedPipeline) return;

    const uniformBuffer = this.writeEntityUniformBuffer(entity);
    const bindGroup = this.getBindGroup(sourceTexture, uniformBuffer);

    const pass = encoder.beginRenderPass({
      label: "GlassShader fluted render pass",
      colorAttachments: [
        {
          view: this.getTextureView(outputTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.#flutedPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  #executeFlowing(
    entity: EffectRenderEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    const pipeline = this.#flowingImmediatePipeline ?? this.#flowingPipeline;
    if (!pipeline) return;

    const useImmediates = pipeline === this.#flowingImmediatePipeline;
    const uniformBuffer = useImmediates
      ? this.#writeFlowingImmediateUniformBuffer(entity)
      : this.writeEntityUniformBuffer(entity);
    const bindGroup = this.getBindGroup(sourceTexture, uniformBuffer);

    const pass = encoder.beginRenderPass({
      label: "GlassShader flowing render pass",
      colorAttachments: [
        {
          view: this.getTextureView(outputTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    if (useImmediates) this.#setFlowingTimeImmediate(pass, entity);
    pass.draw(3);
    pass.end();

    this.#advanceFlowingTime(entity);
  }

  #getFlowingImmediateUniformBuffer(entityId: string): GPUBuffer {
    const cached = this.#flowingImmediateUniformBuffers.get(entityId);
    if (cached) return cached;

    const buffer = this.ctx.device.createBuffer({
      label: `GlassShader flowing immediate uniforms ${entityId}`,
      size: this.ctx.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#flowingImmediateUniformBuffers.set(entityId, buffer);
    return buffer;
  }

  #writeFlowingImmediateUniformBuffer(entity: EffectRenderEntity): GPUBuffer {
    this.writeUniforms(entity);
    this.ctx.floatView[6] = 0;

    const bytes = new Uint8Array(this.ctx.uniformData);
    const cached = this.#flowingImmediateUniformDataCache.get(entity.id);
    const buffer = this.#getFlowingImmediateUniformBuffer(entity.id);
    if (!cached || !equalBytes(cached, bytes)) {
      this.ctx.device.queue.writeBuffer(buffer, 0, this.ctx.uniformData);
      this.#flowingImmediateUniformDataCache.set(entity.id, new Uint8Array(bytes));
    }
    return buffer;
  }

  #setFlowingTimeImmediate(pass: GPURenderPassEncoder, entity: EffectRenderEntity): void {
    this.#flowingImmediateData[0] = entity.shaderParams.time ?? 0;
    pass.setImmediates(0, this.#flowingImmediateData);
  }

  #advanceFlowingTime(entity: EffectRenderEntity): void {
    // Auto-increment time per-entity (mutate in-place, no React/undo involvement)
    if (entity.shaderParams.timeAutoPlay !== false) {
      const now = performance.now();
      const lastFrame = this.#lastFrameTimes.get(entity.id);
      if (lastFrame !== undefined) {
        const dt = Math.min((now - lastFrame) / 1000, 0.1);
        entity.shaderParams.time = (entity.shaderParams.time ?? 0) + dt;
      }
      this.#lastFrameTimes.set(entity.id, now);
    } else {
      this.#lastFrameTimes.delete(entity.id);
    }
  }

  /** Clean up tracking for a removed entity */
  removeEntity(entityId: string): void {
    this.#lastFrameTimes.delete(entityId);
    this.#flowingImmediateUniformBuffers.get(entityId)?.destroy();
    this.#flowingImmediateUniformBuffers.delete(entityId);
    this.#flowingImmediateUniformDataCache.delete(entityId);
  }

  override destroy(): void {
    this.#flutedPipeline = null;
    this.#flowingPipeline = null;
    this.#flowingImmediatePipeline = null;
    this.#externalFlutedPipeline = null;
    this.#externalFlowingPipeline = null;
    this.#externalFlowingImmediatePipeline = null;
    for (const buffer of this.#flowingImmediateUniformBuffers.values()) {
      buffer.destroy();
    }
    this.#flowingImmediateUniformBuffers.clear();
    this.#flowingImmediateUniformDataCache.clear();
    this.#lastFrameTimes.clear();
    super.destroy();
  }
}
