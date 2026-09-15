import { CompositionPass, type CompositionLayer } from "#renderer/composition-pass.ts";
import type { ActionLayerRenderState } from "#engine";
import type { ShaderCanvasEntity } from "#types/canvas.ts";

/** Compare zero-RGB fast paths against the same shader's full material math. */
export async function runOverlapVisualGuard(device: GPUDevice, entities: ShaderCanvasEntity[]) {
  const width = 512;
  const height = 384;
  const viewport = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const transforms = new Float32Array(16);
  transforms[0] = 2 / width;
  transforms[5] = -2 / height;
  transforms[8] = -1;
  transforms[9] = 1;
  transforms[10] = 1;
  transforms[12] = width;
  transforms[13] = height;
  transforms[14] = 1;
  device.queue.writeBuffer(viewport, 0, transforms);
  const textures: GPUTexture[] = [];
  const passes: CompositionPass[] = [];
  const queries = device.createQuerySet({ type: "occlusion", count: 1 });
  const queryResult = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  const occlusionWitness = [0, 0];
  const witnessTarget = device.createTexture({
    size: [width, height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  let referenceModules = 0;
  const referenceDevice = new Proxy(device, {
    get(target, property) {
      if (property === "createShaderModule") {
        return (descriptor: GPUShaderModuleDescriptor) => {
          let code = descriptor.code;
          for (const condition of [
            "if (rgbPulse == 0.0)",
            "if (field.rgbPulse == 0.0 || contacts.header.y == 0.0)",
            "if (alphaOnly || all(split == vec2f(0.0)))",
          ]) {
            const start = code.indexOf(condition);
            if (start < 0) throw new Error(`Missing overlap reference branch: ${condition}`);
            const open = code.indexOf("{", start);
            let depth = 1;
            let end = open + 1;
            while (depth > 0 && end < code.length) {
              if (code[end] === "{") depth++;
              if (code[end] === "}") depth--;
              end++;
            }
            if (depth !== 0) throw new Error("Malformed overlap reference branch");
            code = code.slice(0, start) + code.slice(end);
          }
          referenceModules++;
          return target.createShaderModule({ ...descriptor, code });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  device.pushErrorScope("validation");
  let scopeOpen = true;
  try {
    passes.push(
      new CompositionPass({ device, format: "rgba8unorm", viewportUniformBuffer: viewport }),
    );
    passes.push(
      new CompositionPass({
        device: referenceDevice,
        format: "rgba8unorm",
        viewportUniformBuffer: viewport,
      }),
    );
    if (referenceModules !== 3)
      throw new Error("Overlap reference did not cover every shader module");
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i]!;
      entity.shaderParams = { ...entity.shaderParams, showOriginal: true };
      entity.position = { x: 55 + (i % 3) * 28, y: 45 + (i % 4) * 18 };
      entity.size = { width: 240, height: 180 };
      entity.rotation = [0, 35, -45, 87][i % 4]!;
      const pixels = new Uint8Array(64 * 64 * 4);
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const offset = (y * 64 + x) * 4;
          pixels[offset] = (x * 11 + i * 37) % 256;
          pixels[offset + 1] = (y * 7 + i * 53) % 256;
          pixels[offset + 2] = (x * 3 + y * 5 + i * 17) % 256;
          // Holes, feathered rims, and near-zero alpha, including alpha = 1/255.
          pixels[offset + 3] =
            i % 2 === 0
              ? 255
              : x > 23 && x < 40 && y > 23 && y < 40
                ? 0
                : Math.min(255, Math.min(x, y, 63 - x, 63 - y) * 23 + 1);
        }
      const texture = device.createTexture({
        size: [64, 64],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      textures.push(texture);
      device.queue.writeTexture({ texture }, pixels, { bytesPerRow: 256 }, [64, 64]);
    }
    const selected = new Set(entities.slice(0, 2).map((entity) => entity.id));
    const action: ActionLayerRenderState = {
      active: true,
      entityIds: selected,
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    };
    let comparisons = 0;
    let changedChannels = 0;
    let maximumChannelError = 0;
    for (const time of [
      0, 25, 75, 125, 175, 200, 250, 350, 450, 650, 675, 725, 775, 850, 950, 1150, 1450,
    ]) {
      action.returning = time >= 650;
      for (const pass of passes) pass.crossing.update(entities, action, time, 1, 1);
      for (const layer of [
        "all",
        "scene",
        "action",
      ] as const satisfies readonly CompositionLayer[]) {
        const outputs: Uint8Array[] = [];
        for (const pass of passes) {
          pass.beginFrame(entities.length * entities.length);
          const items = entities.map((entity, index) =>
            pass.prepareDrawItem({
              entity,
              source: { kind: "texture", texture: textures[index]! },
              isSelected: selected.has(entity.id),
              debugMode: false,
              positionOffsetX: 0,
              positionOffsetY: 0,
              visualScale: 1,
            }),
          );
          const output = device.createTexture({
            size: [width, height],
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
          const readback = device.createBuffer({
            size: width * height * 4 + 8,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          try {
            const encoder = device.createCommandEncoder();
            const depth =
              pass === passes[0] && layer !== "action"
                ? pass.prepareOcclusion(encoder, items, width, height, 1)
                : undefined;
            const render = encoder.beginRenderPass({
              ...(depth ? { depthStencilAttachment: depth } : {}),
              colorAttachments: [
                {
                  view: output.createView(),
                  clearValue: [0, 0, 0, 0],
                  loadOp: "clear",
                  storeOp: "store",
                },
              ],
            });
            pass.drawItems(render, items, layer);
            render.end();
            if (time === 0 && layer === "all") {
              // WebGPU queries only guarantee zero/nonzero, not precise sample
              // counts. Probe a known hidden opaque card under another opaque card.
              const witness = encoder.beginRenderPass({
                occlusionQuerySet: queries,
                ...(depth ? { depthStencilAttachment: depth } : {}),
                colorAttachments: [
                  { view: witnessTarget.createView(), loadOp: "clear", storeOp: "store" },
                ],
              });
              witness.setScissorRect(200, 171, 1, 1);
              witness.beginOcclusionQuery(0);
              pass.drawItems(witness, [items[2]!]);
              witness.endOcclusionQuery();
              witness.end();
              encoder.resolveQuerySet(queries, 0, 1, queryResult, 0);
              encoder.copyBufferToBuffer(queryResult, 0, readback, width * height * 4, 8);
            }
            encoder.copyTextureToBuffer(
              { texture: output },
              { buffer: readback, bytesPerRow: width * 4 },
              [width, height],
            );
            device.queue.submit([encoder.finish()]);
            pass.endFrame();
            await readback.mapAsync(GPUMapMode.READ);
            const mapped = readback.getMappedRange();
            outputs.push(new Uint8Array(mapped, 0, width * height * 4).slice());
            if (time === 0 && layer === "all")
              occlusionWitness[pass === passes[0] ? 0 : 1] = Number(
                new BigUint64Array(mapped, width * height * 4, 1)[0],
              );
            readback.unmap();
          } finally {
            output.destroy();
            readback.destroy();
          }
        }
        for (let i = 0; i < outputs[0]!.length; i++) {
          const error = Math.abs(outputs[0]![i]! - outputs[1]![i]!);
          if (error > 0) changedChannels++;
          maximumChannelError = Math.max(maximumChannelError, error);
        }
        comparisons++;
      }
    }
    const sharpChecks = await validateSharpCrossing(
      device,
      passes[0]!,
      entities.slice(0, 2),
      textures.slice(0, 2),
      width,
      height,
    );
    const error = await device.popErrorScope();
    scopeOpen = false;
    if (error) throw new Error(error.message);
    if (maximumChannelError > 1)
      throw new Error(`Overlap fast paths changed pixels by ${maximumChannelError}/255`);
    if (occlusionWitness[0] !== 0 || occlusionWitness[1] === 0)
      throw new Error(
        `Opaque overlap guard failed zero/nonzero query witness: ${occlusionWitness.join("/")}`,
      );
    return {
      comparisons,
      changedChannels,
      maximumChannelError,
      width,
      height,
      entityCount: entities.length,
      occlusionWitness,
      sharpChecks,
    };
  } finally {
    if (scopeOpen) await device.popErrorScope();
    for (const pass of passes) pass.destroy();
    for (const texture of textures) texture.destroy();
    viewport.destroy();
    queries.destroy();
    queryResult.destroy();
    witnessTarget.destroy();
  }
}

/** High-frequency active detail must survive below translucent covers. */
async function validateSharpCrossing(
  device: GPUDevice,
  pass: CompositionPass,
  entities: ShaderCanvasEntity[],
  textures: GPUTexture[],
  width: number,
  height: number,
) {
  const active = entities[0]!;
  const cover = entities[1]!;
  for (const entity of entities) {
    pass.crossing.forget(entity.id);
    entity.rotation = 0;
    entity.size = { width: 240, height: 180 };
  }
  active.position = { x: 55, y: 45 };
  cover.position = { x: 90, y: 45 };
  const stripes = new Uint8Array(64 * 64 * 4);
  const veil = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) {
    stripes.fill(i % 2 === 0 ? 0 : 255, i * 4, i * 4 + 3);
    stripes[i * 4 + 3] = 255;
    veil.fill(128, i * 4, i * 4 + 4);
  }
  device.queue.writeTexture({ texture: textures[0]! }, stripes, { bytesPerRow: 256 }, [64, 64]);
  device.queue.writeTexture({ texture: textures[1]! }, veil, { bytesPerRow: 256 }, [64, 64]);
  const output = device.createTexture({
    size: [width, height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const action: ActionLayerRenderState = {
    active: false,
    entityIds: new Set([active.id]),
    entityOffset: { x: 0, y: 0 },
    blurIntensity: 1,
  };
  pass.crossing.update(entities, action, 2000, 1, 1);
  action.active = true;
  const checks: { time: number; exposedContrast: number; coveredContrast: number }[] = [];
  try {
    for (const time of [2000, 2025, 2075, 2125, 2175, 2250, 2275, 2325, 2375, 2425, 2500]) {
      action.returning = time >= 2250;
      pass.crossing.update(entities, action, time, 1, 1);
      pass.beginFrame(32);
      const items = entities.map((entity, i) =>
        pass.prepareDrawItem({
          entity,
          source: { kind: "texture", texture: textures[i]! },
          isSelected: i === 0,
          debugMode: false,
          positionOffsetX: 0,
          positionOffsetY: 0,
          visualScale: 1,
        }),
      );
      const encoder = device.createCommandEncoder();
      const view = output.createView();
      // An already blurred constant-gray backdrop isolates reconstruction from
      // the blur implementation. Active detail must not inherit its flat color.
      const backdrop = encoder.beginRenderPass({
        colorAttachments: [
          { view, loadOp: "clear", storeOp: "store", clearValue: [0.5, 0.5, 0.5, 1] },
        ],
      });
      backdrop.end();
      pass.restoreSharpScene(encoder, output, view, items);
      const foreground = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
      });
      pass.drawItems(foreground, [items[0]!], "action");
      foreground.end();
      encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: readback, bytesPerRow: width * 4 },
        [width, height],
      );
      device.queue.submit([encoder.finish()]);
      pass.endFrame();
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(readback.getMappedRange());
      const contrast = (start: number, end: number) => {
        let minimum = 255,
          maximum = 0;
        for (let x = start; x < end; x++) {
          const value = pixels[(100 * width + x) * 4]!;
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
        return maximum - minimum;
      };
      const exposedContrast = contrast(60, 85);
      const coveredContrast = contrast(115, 150);
      readback.unmap();
      if (exposedContrast < 180 || coveredContrast < 80)
        throw new Error(
          `Active detail lost sharpness at ${time}: ${exposedContrast}/${coveredContrast}`,
        );
      checks.push({ time, exposedContrast, coveredContrast });
    }
    return checks;
  } finally {
    output.destroy();
    readback.destroy();
  }
}
