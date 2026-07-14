import { describe, expect, it } from "vitest";
import { createRebasedEntityUpdate } from "#lib/rebased-entity-update.ts";
import type { ColorPalette } from "#types/canvas.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("createRebasedEntityUpdate", () => {
  it("changes only leaves touched by the recorded command", () => {
    const entity = createTestEntity();
    const before = entity.shaderParams;
    const after = { ...before, intensity: before.intensity + 1 };
    const current = { ...entity, shaderParams: { ...after, size: 123 } };

    const update = createRebasedEntityUpdate(
      current,
      { shaderParams: before },
      { shaderParams: after },
      { shaderParams: before },
    );

    expect(update.shaderParams).toMatchObject({ intensity: before.intensity, size: 123 });
  });

  it("retains palette identity when undo restores a palette", () => {
    const entity = createTestEntity();
    const palette: ColorPalette = {
      id: "cstm_original",
      name: "Original",
      shortName: "Original",
      colors: [
        [0, 0, 0, 1],
        [1, 1, 1, 1],
      ],
    };
    const replacement: ColorPalette = {
      ...palette,
      id: "cstm_replacement",
      name: "Replacement",
    };
    const before = { ...entity.shaderParams, palette };
    const after = { ...entity.shaderParams, palette: replacement };

    const update = createRebasedEntityUpdate(
      { ...entity, shaderParams: after },
      { shaderParams: before },
      { shaderParams: after },
      { shaderParams: before },
    );

    expect(update.shaderParams?.palette).toBe(palette);
  });
});
