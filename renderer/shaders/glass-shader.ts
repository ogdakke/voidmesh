import { GlassKind, type ShaderCanvasEntity } from "#types/canvas.ts";
import glassFlowingSource from "../glass-flowing.wgsl?raw";
import glassFlutedSource from "../glass-fluted.wgsl?raw";
import glassFrostedSource from "../glass-frosted.wgsl?raw";
import { ShaderPass } from "./shader-pass.ts";

export class GlassShader extends ShaderPass {
  #flutedPipeline: GPURenderPipeline | null = null;
  #flowingPipeline: GPURenderPipeline | null = null;

  /** Per-entity last frame timestamps for delta-time calculation */
  #lastFrameTimes = new Map<string, number>();

  override needsContinuousRender(entity: ShaderCanvasEntity): boolean {
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
  }

  writeVariantUniforms(entity: ShaderCanvasEntity): void {
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
    entity: ShaderCanvasEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
  ): void {
    const glassKind = entity.shaderParams.glass?.kind ?? GlassKind.frostedVoronoi;

    if (glassKind === GlassKind.fluted) {
      this.#executeFluted(entity, sourceTexture, outputTexture);
    } else if (glassKind === GlassKind.flowing) {
      this.#executeFlowing(entity, sourceTexture, outputTexture);
    } else {
      // Frosted uses the default pipeline (this.pipeline)
      super.execute(entity, sourceTexture, outputTexture);
    }
  }

  #executeFluted(
    entity: ShaderCanvasEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
  ): void {
    if (!this.#flutedPipeline) return;

    this.writeUniforms(entity);
    this.ctx.device.queue.writeBuffer(this.ctx.uniformBuffer, 0, this.ctx.uniformData);

    const bindGroup = this.createBindGroup(sourceTexture.createView());

    const encoder = this.ctx.device.createCommandEncoder({
      label: "GlassShader fluted encoder",
    });

    const pass = encoder.beginRenderPass({
      label: "GlassShader fluted render pass",
      colorAttachments: [
        {
          view: outputTexture.createView(),
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

    this.ctx.device.queue.submit([encoder.finish()]);
  }

  #executeFlowing(
    entity: ShaderCanvasEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
  ): void {
    if (!this.#flowingPipeline) return;

    this.writeUniforms(entity);
    this.ctx.device.queue.writeBuffer(this.ctx.uniformBuffer, 0, this.ctx.uniformData);

    const bindGroup = this.createBindGroup(sourceTexture.createView());

    const encoder = this.ctx.device.createCommandEncoder({
      label: "GlassShader flowing encoder",
    });

    const pass = encoder.beginRenderPass({
      label: "GlassShader flowing render pass",
      colorAttachments: [
        {
          view: outputTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.#flowingPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    this.ctx.device.queue.submit([encoder.finish()]);

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
      // Reset so we don't get a large jump when resuming
      this.#lastFrameTimes.delete(entity.id);
    }
  }

  /** Clean up tracking for a removed entity */
  removeEntity(entityId: string): void {
    this.#lastFrameTimes.delete(entityId);
  }

  override destroy(): void {
    this.#flutedPipeline = null;
    this.#flowingPipeline = null;
    this.#lastFrameTimes.clear();
    super.destroy();
  }
}
