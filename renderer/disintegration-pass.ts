import { config } from "#config";
import { disintegrationController } from "#engine";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { CompositionPass } from "./composition-pass.ts";
import { DisintegrationParticleSystem } from "./disintegration-particles.ts";

interface DisintegrationPassOptions {
  device: GPUDevice;
  canvasFormat: GPUTextureFormat;
  viewportUniformBuffer: GPUBuffer;
  compositionPass: CompositionPass;
}

interface DisintegrationOverlayGpu {
  texture: GPUTexture;
  textureView: GPUTextureView;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

export class DisintegrationPass {
  readonly #device: GPUDevice;
  readonly #canvasFormat: GPUTextureFormat;
  readonly #viewportUniformBuffer: GPUBuffer;
  readonly #compositionPass: CompositionPass;
  readonly #particleSystem: DisintegrationParticleSystem;
  readonly #overlays = new Map<string, DisintegrationOverlayGpu>();

  constructor(options: DisintegrationPassOptions) {
    this.#device = options.device;
    this.#canvasFormat = options.canvasFormat;
    this.#viewportUniformBuffer = options.viewportUniformBuffer;
    this.#compositionPass = options.compositionPass;
    this.#particleSystem = new DisintegrationParticleSystem(options.device);
  }

  get hasOverlays(): boolean {
    return this.#overlays.size > 0;
  }

  async initialize(): Promise<void> {
    await this.#particleSystem.initialize(this.#canvasFormat, this.#viewportUniformBuffer);
  }

  start(entity: ShaderCanvasEntity, snapshotTexture: GPUTexture): void {
    const textureView = snapshotTexture.createView();
    const uniformBuffer = this.#device.createBuffer({
      label: `Disintegration uniform ${entity.id}`,
      size: config.rendering.entityUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = this.#compositionPass.createTextureBindGroup(
      `Disintegration bind group ${entity.id}`,
      textureView,
      uniformBuffer,
    );

    this.#overlays.set(entity.id, {
      texture: snapshotTexture,
      textureView,
      uniformBuffer,
      bindGroup,
    });

    // Register with the animation controller.
    disintegrationController.addOverlay(entity.id, entity.position, entity.size, entity.rotation);

    // Spawn particles from the snapshot texture.
    const overlayData = disintegrationController.getOverlay(entity.id);
    if (overlayData) {
      this.#particleSystem.spawn(entity.id, snapshotTexture, overlayData);
    }
  }

  cancel(id: string): void {
    disintegrationController.cancelOverlay(id);
    this.#cleanupOverlay(id);
  }

  encode(encoder: GPUCommandEncoder, targetView: GPUTextureView, dt: number): void {
    if (this.#overlays.size === 0) return;

    // Clean up GPU resources for overlays whose animations have completed.
    // The controller removes them from its map when tick() finds them finished.
    const completedIds: string[] = [];
    for (const id of this.#overlays.keys()) {
      if (!disintegrationController.hasOverlay(id)) {
        completedIds.push(id);
      }
    }
    for (const id of completedIds) {
      this.#cleanupOverlay(id);
    }

    // Render active overlays.
    const now = performance.now();
    for (const overlay of disintegrationController.getOverlays()) {
      const gpu = this.#overlays.get(overlay.id);
      if (!gpu) continue;
      if (now < overlay.startTime) continue;

      const progress = disintegrationController.getProgress(overlay.id);

      // Render dissolve front only while dissolve is still in progress (< 1.0).
      if (progress > 0 && progress < 1) {
        this.#compositionPass.writeDisintegrationUniforms(gpu.uniformBuffer, {
          position: overlay.position,
          size: overlay.size,
          rotation: overlay.rotation,
          progress,
          seed: overlay.seed,
        });

        const pass = encoder.beginRenderPass({
          label: `Disintegration overlay ${overlay.id}`,
          colorAttachments: [
            {
              view: targetView,
              loadOp: "load",
              storeOp: "store",
            },
          ],
        });

        this.#compositionPass.drawTextureBindGroup(pass, gpu.bindGroup);
        pass.end();
      }

      // Update + render particles (compute pass must precede render pass).
      const elapsed = Math.max(now - overlay.startTime, 0) / 1000;
      this.#particleSystem.update(overlay.id, elapsed, dt, encoder);
      this.#particleSystem.render(overlay.id, encoder, targetView);
    }
  }

  destroy(): void {
    for (const overlay of this.#overlays.values()) {
      overlay.texture.destroy();
      overlay.uniformBuffer.destroy();
    }
    this.#overlays.clear();
    this.#particleSystem.destroy();
  }

  #cleanupOverlay(id: string): void {
    const overlay = this.#overlays.get(id);
    if (!overlay) return;
    overlay.texture.destroy();
    overlay.uniformBuffer.destroy();
    this.#overlays.delete(id);
    this.#particleSystem.remove(id);
  }
}
