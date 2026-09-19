import { resolve } from "node:path";
import wgslMinifyPlugin from "../../plugins/vite-plugin-wgsl-minify.ts";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { releaseImageAsset, retainImageAsset } from "#lib/media-assets.ts";
import {
  CompositionPass,
  createExternalCompositionShaderSource,
  type CompositionDrawItem,
  type FullSceneBatchKey,
  type FullSceneTextureRange,
  type PrepareCompositionItemOptions,
} from "#renderer/composition-pass.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("CompositionPass instancing", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8 });
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, COPY_DST: 2, TEXTURE_BINDING: 4 });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("minifies complete composition modules before rewriting external textures", async () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const plugin = wgslMinifyPlugin();
    if (typeof plugin.configResolved !== "function" || typeof plugin.load !== "function")
      throw new Error("WGSL plugin hooks are unavailable");
    Reflect.apply(plugin.configResolved, {}, [{ command: "build" }]);
    const context = {
      addWatchFile: vi.fn<(path: string) => void>(),
      debug: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string) => void>(),
    };
    const modules = vi
      .mocked(device.createShaderModule)
      .mock.calls.map(([descriptor]) => descriptor);
    for (const module of modules.filter(
      (module) => module.label !== "External composition shader",
    )) {
      expect(module.code).toContain("fn crossingColor(");
      const file =
        module.label === "Composition shader" ? "composition.wgsl" : "composition-instanced.wgsl";
      const output: unknown = await Reflect.apply(plugin.load, context, [
        resolve("renderer", file) + "?raw",
      ]);
      if (typeof output !== "string") throw new Error("WGSL build returned no shader source");
      const code: string = JSON.parse(output.slice("export default ".length));
      expect(context.warn).not.toHaveBeenCalled();
      // Minifying a fragment alone removes this declaration as unused.
      expect(code).toContain("entityTexture:texture_2d<f32>");
      const external = createExternalCompositionShaderSource(code);
      expect(external).toContain("entityTexture: texture_external;");
      expect(external).toContain("textureSampleBaseClampToEdge(entityTexture,");
      expect(external).not.toMatch(/textureSample\(entityTexture,/);
    }
    const proof: unknown = await Reflect.apply(plugin.load, context, [
      resolve("renderer/opaque-texture-proof.wgsl") + "?raw",
    ]);
    if (typeof proof !== "string") throw new Error("Opacity WGSL build returned no shader source");
    const proofCode: string = JSON.parse(proof.slice("export default ".length));
    expect(context.warn).not.toHaveBeenCalled();
    expect(proofCode).toContain("proveOpacity(");
    expect(proofCode).toContain("@compute");
    pass.destroy();
  });

  test("exposes the viewport to fragment shading for the effected selection outline", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const layout = vi
      .mocked(device.createBindGroupLayout)
      .mock.calls.find(
        ([descriptor]) => descriptor.label === "Instanced composition bind group layout",
      )![0];
    expect(Array.from(layout.entries).find((entry) => entry.binding === 0)?.visibility).toBe(
      GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    );
    pass.destroy();
  });

  test("keeps active material out of the scene that will be blurred", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const entities = ["active", "middle", "upper"].map((id) => createTestEntity({ id }));
    pass.crossing.update(
      entities,
      {
        active: true,
        entityIds: new Set(["active"]),
        entityOffset: { x: 0, y: 0 },
        blurIntensity: 1,
      },
      0,
      1,
      1,
    );
    pass.beginFrame(3);
    const texture = createTexture();
    const render = createRenderPass();
    pass.drawBackdropScene(
      render,
      entities.map((entity) => prepare(pass, entity, texture)),
    );
    expect(render.draw).toHaveBeenCalledExactlyOnceWith(6, 2, 0, 0);
    expect(pass.crossing.hasSharpScene).toBe(true);
    pass.crossing.update(
      entities,
      {
        active: true,
        entityIds: new Set(["active"]),
        entityOffset: { x: 0, y: 0 },
        blurIntensity: 1,
      },
      1000,
      1,
      1,
    );
    expect(pass.crossing.hasSharpScene).toBe(false);
    pass.destroy();
  });

  test("shares exact opacity proofs and reserves instance storage before prepass draws", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const entities = Array.from({ length: 8 }, (_, i) =>
      createTestEntity({ id: `card-${i}`, size: { width: 300, height: 220 } }),
    );
    for (const entity of entities)
      entity.shaderParams = { ...entity.shaderParams, showOriginal: true };
    const action = {
      active: true,
      entityIds: new Set([entities[0]!.id]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 1,
    };
    pass.crossing.update(entities, action, 0, 1, 1);
    const texture = createTexture();
    const items = entities.map((entity) => prepare(pass, entity, texture));
    const compute = {
      setPipeline: vi.fn<GPUComputePassEncoder["setPipeline"]>(),
      setBindGroup: vi.fn<GPUComputePassEncoder["setBindGroup"]>(),
      dispatchWorkgroups: vi.fn<GPUComputePassEncoder["dispatchWorkgroups"]>(),
      end: vi.fn<GPUComputePassEncoder["end"]>(),
    };
    const depth = { ...createRenderPass(), end: vi.fn<GPURenderPassEncoder["end"]>() };
    const encoder = {
      beginComputePass: vi.fn<GPUCommandEncoder["beginComputePass"]>(
        () => compute as unknown as GPUComputePassEncoder,
      ),
      beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(
        () => depth as unknown as GPURenderPassEncoder,
      ),
      copyBufferToBuffer: vi.fn<GPUCommandEncoder["copyBufferToBuffer"]>(),
    } as unknown as GPUCommandEncoder;
    pass.beginFrame(8);
    const attachment = pass.prepareOcclusion(encoder, items, 200, 200, 1);
    expect(attachment?.depthReadOnly).toBe(true);
    expect(attachment?.depthLoadOp).toBeUndefined();
    expect(compute.dispatchWorkgroups).toHaveBeenCalledExactlyOnceWith(4, 4);
    expect(depth.draw).toHaveBeenCalledExactlyOnceWith(6, 7, 0, 0);
    const allocated = device.createBuffer.mock.calls.length;
    pass.drawItems(createRenderPass(), items, "scene");
    pass.drawItems(createRenderPass(), [items[0]!], "action");
    expect(device.createBuffer.mock.calls.length).toBe(allocated);
    pass.endFrame();
    pass.beginFrame(8);
    pass.prepareOcclusion(encoder, items, 200, 200, 1);
    expect(compute.dispatchWorkgroups).toHaveBeenCalledOnce();
    expect(pass.getStats()).toMatchObject({
      opacityProofs: 1,
      opacityBufferBytes: 512,
      occlusionPasses: 2,
      layerTextureBytes: 160000,
    });
    pass.destroy();
  });

  test("rejects an external rewrite when the material sample cannot be converted", () => {
    expect(() =>
      createExternalCompositionShaderSource(
        "@group(0) @binding(2) var entityTexture: texture_2d<f32>; fn sample(uv: vec2f) -> vec4f { return textureSampleLevel(entityTexture, entitySampler, uv, 2.0); }",
      ),
    ).toThrow("Failed to rewrite composition shader source");
  });

  test("does not cache opacity of mutable processed textures", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const entities = Array.from({ length: 8 }, (_, i) =>
      createTestEntity({
        id: `processed-${i}`,
        size: { width: 300, height: 220 },
        shaderParams: { showOriginal: false },
      }),
    );
    pass.crossing.update(
      entities,
      {
        active: true,
        entityIds: new Set([entities[0]!.id]),
        entityOffset: { x: 0, y: 0 },
        blurIntensity: 1,
      },
      0,
      1,
      1,
    );
    pass.beginFrame(8);
    const texture = createTexture();
    expect(
      pass.prepareOcclusion(
        {} as GPUCommandEncoder,
        entities.map((entity) => prepare(pass, entity, texture)),
        200,
        200,
        1,
      ),
    ).toBeUndefined();
    expect(device.createTexture).not.toHaveBeenCalled();
    expect(device.createComputePipeline).not.toHaveBeenCalled();
    pass.destroy();
  });

  test("reuses backdrop targets across transitions and destroys replaced targets", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const entities = ["active", "cover"].map((id) => createTestEntity({ id }));
    pass.crossing.update(
      entities,
      {
        active: true,
        entityIds: new Set(["active"]),
        entityOffset: { x: 0, y: 0 },
        blurIntensity: 1,
      },
      0,
      1,
      1,
    );
    const texture = createTexture();
    const items = entities.map((entity) => prepare(pass, entity, texture));
    const copy = vi.fn<GPUCommandEncoder["copyTextureToTexture"]>();
    const encoder = {
      copyTextureToTexture: copy,
      beginRenderPass: () => ({ ...createRenderPass(), end: vi.fn<GPURenderPassEncoder["end"]>() }),
    } as unknown as GPUCommandEncoder;
    const target = { ...createTexture(), width: 512, height: 384 } as GPUTexture;
    for (let i = 0; i < 2; i++) {
      pass.beginFrame(32);
      pass.restoreSharpScene(encoder, target, target.createView(), items);
    }
    expect(copy.mock.calls[0]![1].texture).toBe(copy.mock.calls[1]![1].texture);
    const retained = copy.mock.calls[0]![1].texture;
    expect(retained.destroy).not.toHaveBeenCalled();
    const resized = { ...target, width: 640, height: 360 } as GPUTexture;
    pass.beginFrame(32);
    pass.restoreSharpScene(encoder, resized, resized.createView(), items);
    expect(retained.destroy).toHaveBeenCalledOnce();
    expect(pass.getStats().layerTextureBytes).toBe(640 * 360 * 4);
    const replacement = copy.mock.calls[2]![1].texture;
    pass.destroy();
    expect(replacement.destroy).toHaveBeenCalledOnce();
  });

  test.each([false, true])(
    "partitions a lifted material around every cover, including culled partners (%s)",
    (cullMiddle) => {
      const { device } = createDevice();
      const pass = createPass(device);
      const entities = ["lifted", "middle", "upper"].map((id) => createTestEntity({ id }));
      const action = {
        active: true,
        entityIds: new Set(["lifted"]),
        entityOffset: { x: 0, y: 0 },
        blurIntensity: 0,
      };
      pass.crossing.update(entities, action, 0, 1, 1);
      pass.crossing.update(entities, action, 100, 1, 1);
      const texture = createTexture();
      const items = entities.map((entity) => prepare(pass, entity, texture));
      const renderPass = createRenderPass();
      // Input arrives in the instantaneous depth order, not its resting order.
      pass.drawItems(
        renderPass,
        cullMiddle ? [items[2]!, items[0]!] : [items[2]!, items[0]!, items[1]!],
      );
      const calls = renderPass.draw.mock.calls;
      expect(calls.map((call) => call[2])).toEqual(cullMiddle ? [6, 12, 0, 24] : [6, 0, 12, 0, 24]);
      // Only the lifted material is split. Covers retain their full source alpha.
      expect(calls.every((call) => call[0] === 6 && call[1] === 1)).toBe(true);
      const uploads = device.queue.writeBuffer.mock.calls.filter(
        (call) => call[2] instanceof ArrayBuffer,
      );
      const instanceUpload = uploads.at(-1)!;
      const keys = new Uint32Array(instanceUpload[2] as ArrayBuffer);
      expect(calls.map((call) => keys[Number(call[3]) * 6 + 5])).toEqual(
        (cullMiddle
          ? ["lifted", "lifted", "upper", "lifted"]
          : ["lifted", "middle", "lifted", "upper", "lifted"]
        ).map((id) => pass.crossing.key(id)),
      );
      pass.destroy();
      entities.forEach(releaseImageEntity);
    },
  );

  test.each([0, 100, 200])("partitions crossing draws around the blur pass at %s ms", (now) => {
    const { device } = createDevice();
    const pass = createPass(device);
    const entities = ["lifted", "middle", "upper"].map((id) => createTestEntity({ id }));
    const action = {
      active: true,
      entityIds: new Set(["lifted"]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 1,
    };
    pass.crossing.update(entities, action, 0, 1, 1);
    pass.crossing.update(entities, action, now, 1, 1);
    const texture = createTexture();
    const items = entities.map((entity) => prepare(pass, entity, texture));
    const scene = createRenderPass();
    const sharp = createRenderPass();
    pass.beginFrame(4);
    pass.drawItems(scene, items, "scene");
    const buffers = device.createBuffer.mock.calls.length;
    pass.drawItems(sharp, [items[0]!], "action");
    expect(scene.draw.mock.calls.map((call) => call[2])).toEqual(now === 100 ? [6, 0, 12, 0] : [0]);
    expect(sharp.draw.mock.calls.map((call) => call[2])).toEqual(
      now === 0 ? [] : now === 100 ? [24] : [0],
    );
    expect(scene.draw.mock.calls.map((call) => call[1])).toEqual(
      now === 100 ? [1, 1, 1, 1] : [now === 0 ? 3 : 2],
    );
    expect(device.createBuffer.mock.calls).toHaveLength(buffers);
    pass.destroy();
    entities.forEach(releaseImageEntity);
  });

  test("splits external video draws and returns to ordinary batching after the crossing", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const lifted = createTestEntity({ id: "video" });
    const cover = createTestEntity({ id: "cutout" });
    const entities = [lifted, cover];
    const action = {
      active: true,
      entityIds: new Set([lifted.id]),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    pass.crossing.update(entities, action, 0, 1, 1);
    expect(pass.crossing.hasSlices).toBe(false);
    pass.crossing.update(entities, action, 100, 1, 1);
    const video = pass.prepareDrawItem({
      entity: lifted,
      source: { kind: "external", texture: {} as GPUExternalTexture },
      isSelected: true,
      debugMode: false,
      positionOffsetX: 0,
      positionOffsetY: 0,
      visualScale: 1,
    });
    const image = prepare(pass, cover, createTexture());
    const renderPass = createRenderPass();
    pass.drawItems(renderPass, [video, image]);
    expect(renderPass.draw.mock.calls.map((call) => call[2])).toEqual([6, 0, 12]);
    pass.crossing.update(entities, { ...action, returning: true }, 100, 1, 1);
    expect(pass.crossing.hasSlices).toBe(true);
    pass.crossing.update(entities, { ...action, active: false }, 1000, 1, 1);
    expect(pass.crossing.hasSlices).toBe(false);
    pass.destroy();
    entities.forEach(releaseImageEntity);
  });

  test("rebuilds an external composition bind group when the texture identity is revived", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const entity = createTestEntity({ id: "external-cache", mediaType: "video" });
    const firstFrame = {} as GPUExternalTexture;
    const secondFrame = {} as GPUExternalTexture;
    const options = {
      entity,
      source: { kind: "external" as const, texture: firstFrame },
      isSelected: false,
      debugMode: false,
      positionOffsetX: 0,
      positionOffsetY: 0,
      visualScale: 1,
    };
    const initialBindGroupCount = device.createBindGroup.mock.calls.length;

    const first = pass.prepareDrawItem(options);
    const firstBindGroup = first.bindGroup;
    const revived = pass.prepareDrawItem(options);

    expect(revived.bindGroup).not.toBe(firstBindGroup);
    expect(device.createBindGroup).toHaveBeenCalledTimes(initialBindGroupCount + 2);
    expect(pass.getStats()).toMatchObject({
      externalBindGroupCreations: 2,
    });

    const next = pass.prepareDrawItem({
      ...options,
      source: { kind: "external", texture: secondFrame },
    });
    expect(next.bindGroup).not.toBe(firstBindGroup);
    expect(device.createBindGroup).toHaveBeenCalledTimes(initialBindGroupCount + 3);
    expect(pass.getStats()).toMatchObject({
      externalBindGroupCreations: 3,
    });

    pass.destroy();
  });

  test("draws adjacent entities sharing one texture as one instance batch", () => {
    const { device, instanceBuffer } = createDevice();
    const pass = createPass(device);
    const firstEntity = createTestEntity({ id: "instance-first", position: { x: 10, y: 20 } });
    const secondEntity = cloneImageEntity(firstEntity, "instance-second", { x: 30, y: 40 });
    const texture = createTexture();
    const first = prepare(pass, firstEntity, texture);
    const second = prepare(pass, secondEntity, texture);
    const renderPass = createRenderPass();

    pass.drawItems(renderPass, [first, second]);

    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(device.createBuffer).toHaveBeenCalledTimes(3);
    expect(device.createBindGroup).toHaveBeenCalledTimes(2);
    expect(renderPass.setPipeline).toHaveBeenCalledOnce();
    expect(renderPass.setBindGroup).toHaveBeenCalledTimes(2);
    expect(renderPass.draw).toHaveBeenCalledWith(6, 2, 0, 0);

    const upload = device.queue.writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const floats = new Float32Array(upload);
    expect(Array.from(floats.slice(0, 4))).toEqual([10, 20, 200, 150]);
    expect(Array.from(floats.slice(6, 10))).toEqual([30, 40, 200, 150]);

    pass.destroy();
    expect(instanceBuffer.destroy).toHaveBeenCalledTimes(3);
    releaseImageEntity(firstEntity);
    releaseImageEntity(secondEntity);
  });

  test("batches selected entities with adjacent entities sharing their texture", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const base = createTestEntity({ id: "batch-base" });
    const second = cloneImageEntity(base, "batch-second", { x: 10, y: 0 });
    const selected = cloneImageEntity(base, "batch-selected", { x: 20, y: 0 });
    const fourth = cloneImageEntity(base, "batch-fourth", { x: 30, y: 0 });
    const final = cloneImageEntity(base, "batch-final", { x: 40, y: 0 });
    const textureA = createTexture();
    const textureB = createTexture();
    const items: CompositionDrawItem[] = [
      prepare(pass, base, textureA),
      prepare(pass, second, textureA),
      prepare(pass, selected, textureA, true),
      prepare(pass, fourth, textureA),
      prepare(pass, final, textureB),
    ];
    const renderPass = createRenderPass();
    pass.drawItems(renderPass, items);

    expect(renderPass.draw.mock.calls).toEqual([
      [6, 4, 0, 0],
      [6, 1, 0, 4],
    ]);
    expect(device.createBindGroup).toHaveBeenCalledTimes(3);
    expect(renderPass.setPipeline).toHaveBeenCalledOnce();

    pass.destroy();
    releaseImageEntity(base);
    releaseImageEntity(second);
    releaseImageEntity(selected);
    releaseImageEntity(fourth);
    releaseImageEntity(final);
  });

  test("packs rotation, visual scale, and flags into a 24-byte instance", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const entity = createTestEntity({ id: "packed-instance", rotation: 90, locked: true });
    const texture = createTexture();
    const item = pass.prepareDrawItem({
      entity,
      source: { kind: "texture", texture },
      isSelected: true,
      debugMode: true,
      positionOffsetX: 0,
      positionOffsetY: 0,
      visualScale: 0.95,
    });

    pass.drawItems(createRenderPass(), [item]);

    expect(device.queue.writeBuffer.mock.calls[0]![4]).toBe(24);
    const upload = device.queue.writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const packedState = new Uint32Array(upload)[4]!;
    const rotationDegrees = ((packedState & 0xffff) / 0xffff) * 360;
    const scaleCode = (packedState >>> 16) & 0x3ff;
    const visualScale = 0.8 + scaleCode * (0.25 / 1022);
    expect(rotationDegrees).toBeCloseTo(90, 2);
    expect(visualScale).toBeCloseTo(0.95, 3);
    expect(packedState & (1 << 26)).not.toBe(0);
    expect(packedState & (1 << 27)).not.toBe(0);
    expect(packedState & (1 << 28)).not.toBe(0);

    pass.destroy();
    releaseImageEntity(entity);
  });

  test("appends multiple render phases into disjoint instance-buffer ranges", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const base = createTestEntity({ id: "phase-base" });
    const second = cloneImageEntity(base, "phase-second", { x: 10, y: 0 });
    const actionLayer = cloneImageEntity(base, "phase-action", { x: 20, y: 0 });
    const texture = createTexture();
    const sceneItems = [prepare(pass, base, texture), prepare(pass, second, texture)];
    const actionItems = [prepare(pass, actionLayer, texture)];
    const scenePass = createRenderPass();
    const actionPass = createRenderPass();

    pass.beginFrame(3);
    pass.drawItems(scenePass, sceneItems);
    pass.drawItems(actionPass, actionItems);

    expect(device.queue.writeBuffer.mock.calls[0]![1]).toBe(0);
    expect(device.queue.writeBuffer.mock.calls[1]![1]).toBe(2 * 24);
    expect(scenePass.draw).toHaveBeenCalledWith(6, 2, 0, 0);
    expect(actionPass.draw).toHaveBeenCalledWith(6, 1, 0, 2);

    pass.destroy();
    releaseImageEntity(base);
    releaseImageEntity(second);
    releaseImageEntity(actionLayer);
  });

  test("uploads a full-scene instance payload once across viewport-only frames", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "full-scene-first", position: { x: 10, y: 20 } });
    const second = cloneImageEntity(first, "full-scene-second", { x: 30, y: 40 });
    const texture = createTexture();
    const key = createFullSceneKey(texture, 2);

    pass.prepareFullSceneBatch({ ...key, entities: [first, second], selectedEntityIds: new Set() });
    pass.beginFrame(2);
    expect(pass.drawFullSceneBatch(createRenderPass(), key)).toBe(true);
    expect(pass.hasFullSceneBatch({ ...key, textureCacheRevision: 2 })).toBe(true);

    pass.prepareFullSceneBatch({ ...key, entities: [first, second], selectedEntityIds: new Set() });
    pass.beginFrame(2);
    const secondFramePass = createRenderPass();
    expect(pass.drawFullSceneBatch(secondFramePass, key)).toBe(true);

    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(pass.getStats()).toEqual({
      fullSceneBatchRebuilds: 1,
      fullSceneBatchUploadBytes: 48,
      normalInstanceUploadBytes: 0,
      occlusionPasses: 0,
      opacityProofs: 0,
      opacityBufferBytes: 0,
      layerTextureBytes: 0,
      externalBindGroupCreations: 0,
    });
    expect(secondFramePass.draw).toHaveBeenCalledWith(6, 2, 0, 0);
    expect(first.textureDirty).toBe(false);
    expect(second.textureDirty).toBe(false);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
  });

  test("uses the lightweight vertex pipeline unless GPU interaction state is active", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const entity = createTestEntity({ id: "pipeline-selection" });
    const texture = createTexture();
    const key = createFullSceneKey(texture, 1);
    pass.prepareFullSceneBatch({ ...key, entities: [entity], selectedEntityIds: new Set() });
    const lightweightPipeline = device.createRenderPipeline.mock.results.find(
      (result) => (result.value as { label?: string }).label === "Instanced composition pipeline",
    )?.value;
    const interactivePipeline = device.createRenderPipeline.mock.results.find(
      (result) =>
        (result.value as { label?: string }).label === "Interactive instanced composition pipeline",
    )?.value;

    const panPass = createRenderPass();
    expect(pass.drawFullSceneBatch(panPass, key)).toBe(true);
    expect(panPass.setPipeline).toHaveBeenCalledWith(lightweightPipeline);

    const dragSelectionPass = createRenderPass();
    expect(
      pass.drawFullSceneBatch(
        dragSelectionPass,
        key,
        undefined,
        1,
        { x: 0, y: 0, width: 100, height: 100 },
        "replace",
      ),
    ).toBe(true);
    expect(dragSelectionPass.setPipeline).toHaveBeenCalledWith(interactivePipeline);

    pass.destroy();
    releaseImageEntity(entity);
  });

  test("persists mixed-texture instance ranges across viewport-only frames", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "mixed-first" });
    const second = cloneImageEntity(first, "mixed-second", { x: 20, y: 0 });
    const third = cloneImageEntity(first, "mixed-third", { x: 40, y: 0 });
    const textureA = createTexture();
    const textureB = createTexture();
    const key = { ...createFullSceneKey(textureA, 3), texture: null };
    const entities = [first, second, third];
    const textureRanges = [
      { texture: textureA, firstInstance: 0, instanceCount: 2 },
      { texture: textureB, firstInstance: 2, instanceCount: 1 },
    ];

    prepareMixed(pass, key, entities, textureRanges);
    const renderPass = createRenderPass();
    expect(pass.drawFullSceneBatch(renderPass, key)).toBe(true);
    expect(renderPass.draw.mock.calls).toEqual([
      [6, 2, 0, 0],
      [6, 1, 0, 2],
    ]);

    prepareMixed(pass, key, entities, textureRanges);
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
    releaseImageEntity(third);
  });

  test("restores a mixed batch from retained instance data after normal draws", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "restore-first" });
    const second = cloneImageEntity(first, "restore-second", { x: 20, y: 0 });
    const third = cloneImageEntity(first, "restore-third", { x: 40, y: 0 });
    const textureA = createTexture();
    const textureB = createTexture();
    const textureC = createTexture();
    const key = { ...createFullSceneKey(textureA, 3), texture: null };

    prepareMixed(
      pass,
      key,
      [first, second, third],
      [
        { texture: textureA, firstInstance: 0, instanceCount: 2 },
        { texture: textureB, firstInstance: 2, instanceCount: 1 },
      ],
    );
    pass.beginFrame(1);
    pass.drawItems(createRenderPass(), [prepare(pass, first, textureA)]);
    expect(pass.hasFullSceneBatch(key)).toBe(false);
    device.queue.writeBuffer.mockClear();

    expect(
      pass.restoreFullSceneBatch(key, [
        { texture: textureC, firstInstance: 0, instanceCount: 2 },
        { texture: textureB, firstInstance: 2, instanceCount: 1 },
      ]),
    ).toBe(true);
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(device.queue.writeBuffer.mock.calls[0]![4]).toBe(3 * 24);
    expect(pass.getStats().fullSceneBatchRebuilds).toBe(1);

    const renderPass = createRenderPass();
    expect(pass.drawFullSceneBatch(renderPass, key)).toBe(true);
    expect(renderPass.draw.mock.calls).toEqual([
      [6, 2, 0, 0],
      [6, 1, 0, 2],
    ]);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
    releaseImageEntity(third);
  });

  test("patches committed drag transforms without rebuilding instance data", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "drag-commit-first" });
    const second = cloneImageEntity(first, "drag-commit-second", { x: 20, y: 0 });
    const texture = createTexture();
    const key = createFullSceneKey(texture, 2);
    pass.prepareFullSceneBatch({
      ...key,
      entities: [first, second],
      selectedEntityIds: new Set([first.id]),
    });
    device.queue.writeBuffer.mockClear();

    first.position.x = 120;
    first.position.y = -45;
    const committedKey = { ...key, geometryVersion: 2 };
    expect(
      pass.patchFullSceneInstances(committedKey, [{ index: 0, entity: first, isSelected: true }]),
    ).toBe(true);
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(device.queue.writeBuffer.mock.calls[0]![1]).toBe(0);
    expect(device.queue.writeBuffer.mock.calls[0]![4]).toBe(24);
    expect(pass.getStats().fullSceneBatchRebuilds).toBe(1);
    expect(pass.drawFullSceneBatch(createRenderPass(), committedKey)).toBe(true);

    pass.beginFrame(1);
    pass.drawItems(createRenderPass(), [prepare(pass, first, texture)]);
    expect(pass.hasFullSceneBatch(committedKey)).toBe(false);
    expect(
      pass.restoreFullSceneBatch(committedKey, [{ texture, firstInstance: 0, instanceCount: 2 }]),
    ).toBe(true);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
  });

  test("visits each cached mixed texture once regardless of z-order fragmentation", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "resident-first" });
    const second = cloneImageEntity(first, "resident-second", { x: 20, y: 0 });
    const third = cloneImageEntity(first, "resident-third", { x: 40, y: 0 });
    const fourth = cloneImageEntity(first, "resident-fourth", { x: 60, y: 0 });
    const textureA = createTexture();
    const textureB = createTexture();
    const key = { ...createFullSceneKey(textureA, 4), texture: null };

    prepareMixed(
      pass,
      key,
      [first, second, third, fourth],
      [
        { texture: textureA, firstInstance: 0, instanceCount: 1 },
        { texture: textureB, firstInstance: 1, instanceCount: 1 },
        { texture: textureA, firstInstance: 2, instanceCount: 1 },
        { texture: textureB, firstInstance: 3, instanceCount: 1 },
      ],
    );
    const visitor = vi.fn<(texture: GPUTexture) => void>();

    expect(pass.visitCachedFullSceneTextures(visitor)).toBe(true);
    expect(visitor.mock.calls).toEqual([[textureA], [textureB]]);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
    releaseImageEntity(third);
    releaseImageEntity(fourth);
  });

  test("patches one full-scene texture run without rebuilding the instance payload", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "patch-first" });
    const second = cloneImageEntity(first, "patch-second", { x: 20, y: 0 });
    const third = cloneImageEntity(first, "patch-third", { x: 40, y: 0 });
    const textureA = createTexture();
    const textureB = createTexture();
    const initialKey = createFullSceneKey(textureA, 3);
    pass.prepareFullSceneBatch({
      ...initialKey,
      entities: [first, second, third],
      selectedEntityIds: new Set(),
    });

    const patchedKey = {
      ...initialKey,
      entityVersion: 2,
      selectionVersion: 2,
      texture: null,
    };
    expect(
      pass.patchMixedFullSceneBatch(patchedKey, [
        { index: 1, entity: second, texture: textureB, isSelected: false },
      ]),
    ).toBe(true);
    const patchedPass = createRenderPass();
    expect(pass.drawFullSceneBatch(patchedPass, patchedKey)).toBe(true);
    expect(patchedPass.draw.mock.calls).toEqual([
      [6, 1, 0, 0],
      [6, 1, 0, 1],
      [6, 1, 0, 2],
    ]);
    expect(pass.getStats()).toMatchObject({
      fullSceneBatchRebuilds: 1,
      fullSceneBatchUploadBytes: 4 * 24,
    });

    const restoredKey = { ...patchedKey, entityVersion: 3, selectionVersion: 3 };
    expect(
      pass.patchMixedFullSceneBatch(restoredKey, [
        { index: 1, entity: second, texture: textureA, isSelected: false },
      ]),
    ).toBe(true);
    const restoredPass = createRenderPass();
    expect(pass.drawFullSceneBatch(restoredPass, restoredKey)).toBe(true);
    expect(restoredPass.draw).toHaveBeenCalledWith(6, 3, 0, 0);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
    releaseImageEntity(third);
  });

  test("coalesces unsorted adjacent full-scene patches into one buffer upload", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "bulk-patch-first" });
    const second = cloneImageEntity(first, "bulk-patch-second", { x: 20, y: 0 });
    const third = cloneImageEntity(first, "bulk-patch-third", { x: 40, y: 0 });
    const fourth = cloneImageEntity(first, "bulk-patch-fourth", { x: 60, y: 0 });
    const textureA = createTexture();
    const textureB = createTexture();
    const textureC = createTexture();
    const initialKey = createFullSceneKey(textureA, 4);
    pass.prepareFullSceneBatch({
      ...initialKey,
      entities: [first, second, third, fourth],
      selectedEntityIds: new Set(),
    });
    device.queue.writeBuffer.mockClear();

    const patchedKey = { ...initialKey, entityVersion: 2, texture: null };
    expect(
      pass.patchMixedFullSceneBatch(patchedKey, [
        { index: 2, entity: third, texture: textureB, isSelected: false },
        { index: 0, entity: first, texture: textureC, isSelected: false },
        { index: 1, entity: second, texture: textureB, isSelected: false },
      ]),
    ).toBe(true);

    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(device.queue.writeBuffer.mock.calls[0]![1]).toBe(0);
    expect(device.queue.writeBuffer.mock.calls[0]![4]).toBe(3 * 24);
    const renderPass = createRenderPass();
    expect(pass.drawFullSceneBatch(renderPass, patchedKey)).toBe(true);
    expect(renderPass.draw.mock.calls).toEqual([
      [6, 1, 0, 0],
      [6, 2, 0, 1],
      [6, 1, 0, 3],
    ]);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
    releaseImageEntity(third);
    releaseImageEntity(fourth);
  });

  test("persists selection and debug flags without splitting the full-scene batch", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "full-scene-selected" });
    const second = cloneImageEntity(first, "full-scene-after-selected", { x: 20, y: 0 });
    const texture = createTexture();
    const key = {
      ...createFullSceneKey(texture, 2),
      selectionVersion: 2,
      debugMode: true,
      singleSelectedIndex: 0,
    };
    const selectedEntityIds = new Set([first.id]);

    pass.prepareFullSceneBatch({ ...key, entities: [first, second], selectedEntityIds });
    const upload = device.queue.writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const uints = new Uint32Array(upload);
    expect(uints[4]! & (1 << 26)).not.toBe(0);
    expect(uints[4]! & (1 << 27)).not.toBe(0);
    expect(uints[10]! & (1 << 26)).toBe(0);
    expect(uints[10]! & (1 << 27)).not.toBe(0);

    const renderPass = createRenderPass();
    expect(pass.drawFullSceneBatch(renderPass, key)).toBe(true);
    expect(renderPass.draw).toHaveBeenCalledWith(6, 2, 0, 0);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
  });

  test("updates a selected-group drag transform without rebuilding instance data", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "drag-transform-first" });
    const second = cloneImageEntity(first, "drag-transform-second", { x: 20, y: 0 });
    const texture = createTexture();
    const key = createFullSceneKey(texture, 2);
    const selectedEntityIds = new Set([first.id]);
    pass.prepareFullSceneBatch({ ...key, entities: [first, second], selectedEntityIds });
    device.queue.writeBuffer.mockClear();

    expect(pass.drawFullSceneBatch(createRenderPass(), key, { x: 120, y: -45 }, 0.95)).toBe(true);

    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    const interactionUniform = device.queue.writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const interactionFloats = new Float32Array(interactionUniform);
    expect(Array.from(interactionFloats.slice(0, 2))).toEqual([120, -45]);
    expect(interactionFloats[2]).toBeCloseTo(0.95);
    expect(interactionFloats[3]).toBe(0);
    expect(pass.getStats().fullSceneBatchRebuilds).toBe(1);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
  });

  test("updates drag-selection bounds without rebuilding full-scene instances", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "drag-select-first" });
    const second = cloneImageEntity(first, "drag-select-second", { x: 20, y: 0 });
    const texture = createTexture();
    const key = createFullSceneKey(texture, 2);
    pass.prepareFullSceneBatch({ ...key, entities: [first, second], selectedEntityIds: new Set() });
    device.queue.writeBuffer.mockClear();

    expect(
      pass.drawFullSceneBatch(
        createRenderPass(),
        key,
        undefined,
        1,
        { x: 10, y: 20, width: 300, height: 200 },
        "replace",
      ),
    ).toBe(true);

    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    const interactionUniform = device.queue.writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const floats = new Float32Array(interactionUniform);
    const uints = new Uint32Array(interactionUniform);
    expect(uints[3]).toBe(1);
    expect(Array.from(floats.slice(4, 8))).toEqual([10, 20, 300, 200]);
    expect(pass.getStats().fullSceneBatchRebuilds).toBe(1);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
  });

  test("invalidates the full-scene payload after geometry or normal instance writes", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const first = createTestEntity({ id: "full-scene-rebuild-first" });
    const second = cloneImageEntity(first, "full-scene-rebuild-second", { x: 20, y: 0 });
    const texture = createTexture();
    const key = createFullSceneKey(texture, 2);
    const movedKey = { ...key, geometryVersion: 2 };

    pass.prepareFullSceneBatch({ ...key, entities: [first, second], selectedEntityIds: new Set() });
    first.position.x = 5;
    pass.prepareFullSceneBatch({
      ...movedKey,
      entities: [first, second],
      selectedEntityIds: new Set(),
    });
    expect(device.queue.writeBuffer).toHaveBeenCalledTimes(2);

    pass.beginFrame(3);
    pass.drawItems(createRenderPass(), [prepare(pass, first, texture)]);
    expect(pass.hasFullSceneBatch(movedKey)).toBe(false);
    expect(pass.drawFullSceneBatch(createRenderPass(), movedKey)).toBe(false);

    pass.destroy();
    releaseImageEntity(first);
    releaseImageEntity(second);
  });
});

function createFullSceneKey(texture: GPUTexture, instanceCount: number): FullSceneBatchKey {
  return {
    entityVersion: 1,
    geometryVersion: 1,
    selectionVersion: 1,
    debugMode: false,
    singleSelectedIndex: -1,
    renderWidth: 64,
    renderHeight: 64,
    texture,
    textureCacheRevision: 1,
    instanceCount,
  };
}

function createPass(device: GPUDevice): CompositionPass {
  return new CompositionPass({
    device,
    format: "bgra8unorm",
    viewportUniformBuffer: {} as GPUBuffer,
  });
}

function prepare(
  pass: CompositionPass,
  entity: ShaderCanvasEntity,
  texture: GPUTexture,
  isSelected = false,
): CompositionDrawItem {
  const options: PrepareCompositionItemOptions = {
    entity,
    source: { kind: "texture", texture },
    isSelected,
    debugMode: false,
    positionOffsetX: 0,
    positionOffsetY: 0,
    visualScale: 1,
  };
  return pass.prepareDrawItem(options);
}

function prepareMixed(
  pass: CompositionPass,
  key: FullSceneBatchKey,
  entities: readonly ShaderCanvasEntity[],
  textureRanges: readonly FullSceneTextureRange[],
): void {
  pass.prepareMixedFullSceneBatch({
    ...key,
    entities,
    selectedEntityIds: new Set(),
    textureRanges,
  });
}

function cloneImageEntity(
  entity: ShaderCanvasEntity,
  id: string,
  position: { x: number; y: number },
): ShaderCanvasEntity {
  if (entity.mediaSource.type !== "image") throw new Error("Expected image entity");
  retainImageAsset(entity.mediaSource.asset);
  return {
    ...entity,
    id,
    position,
    mediaSource: { type: "image", asset: entity.mediaSource.asset },
  };
}

function releaseImageEntity(entity: ShaderCanvasEntity): void {
  if (entity.mediaSource.type !== "image") throw new Error("Expected image entity");
  releaseImageAsset(entity.mediaSource.asset);
}

function createTexture(): GPUTexture {
  return {
    width: 64,
    height: 64,
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
  } as unknown as GPUTexture;
}

function createRenderPass(): GPURenderPassEncoder & {
  setPipeline: ReturnType<typeof vi.fn<GPURenderPassEncoder["setPipeline"]>>;
  setBindGroup: ReturnType<typeof vi.fn<GPURenderPassEncoder["setBindGroup"]>>;
  draw: ReturnType<typeof vi.fn<GPURenderPassEncoder["draw"]>>;
} {
  return {
    setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
    setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
    draw: vi.fn<GPURenderPassEncoder["draw"]>(),
  } as unknown as GPURenderPassEncoder & {
    setPipeline: ReturnType<typeof vi.fn<GPURenderPassEncoder["setPipeline"]>>;
    setBindGroup: ReturnType<typeof vi.fn<GPURenderPassEncoder["setBindGroup"]>>;
    draw: ReturnType<typeof vi.fn<GPURenderPassEncoder["draw"]>>;
  };
}

function createDevice(): {
  device: GPUDevice & {
    queue: { writeBuffer: ReturnType<typeof vi.fn<GPUQueue["writeBuffer"]>> };
    createBuffer: ReturnType<typeof vi.fn<GPUDevice["createBuffer"]>>;
    createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
    createRenderPipeline: ReturnType<typeof vi.fn<GPUDevice["createRenderPipeline"]>>;
  };
  instanceBuffer: GPUBuffer & { destroy: ReturnType<typeof vi.fn<GPUBuffer["destroy"]>> };
} {
  const instanceBuffer = {
    destroy: vi.fn<GPUBuffer["destroy"]>(),
  } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn<GPUBuffer["destroy"]>> };
  const device = {
    limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    queue: { writeBuffer: vi.fn<GPUQueue["writeBuffer"]>() },
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(
      (descriptor) => ({ label: descriptor.label }) as GPURenderPipeline,
    ),
    createComputePipeline: vi.fn<GPUDevice["createComputePipeline"]>(
      () => ({ getBindGroupLayout: () => ({}) }) as unknown as GPUComputePipeline,
    ),
    createTexture: vi.fn<GPUDevice["createTexture"]>((descriptor) => {
      const size = descriptor.size as number[];
      return {
        ...createTexture(),
        width: size[0],
        height: size[1],
        destroy: vi.fn<GPUTexture["destroy"]>(),
      } as unknown as GPUTexture;
    }),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>(() => instanceBuffer),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice & {
    queue: { writeBuffer: ReturnType<typeof vi.fn<GPUQueue["writeBuffer"]>> };
    createBuffer: ReturnType<typeof vi.fn<GPUDevice["createBuffer"]>>;
    createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
    createRenderPipeline: ReturnType<typeof vi.fn<GPUDevice["createRenderPipeline"]>>;
  };
  return { device, instanceBuffer };
}
