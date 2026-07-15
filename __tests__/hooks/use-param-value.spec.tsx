/**
 * Tests for use-param-value hook
 * Tests the useParamValue hook with multi-select support
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { waitFor } from "@testing-library/react";
import React, { useEffect, useState } from "react";
import { useParamValue, type ParamResult } from "#hooks/use-param-value.ts";
import { canvasStore } from "#engine";
import { createTestEntity } from "../helpers/test-entity.ts";
import { renderWithProviders } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { ShaderType, DitheringKind, GlassKind } from "#types/canvas.ts";
import { config } from "#config";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
});

afterEach(() => {
  cleanup();
});

// Skip providers we don't need for these tests
const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

describe("useParamValue", () => {
  test("returns default when no selection", () => {
    let result: ParamResult<number> | null = null;

    function TestComponent() {
      result = useParamValue("size", 15);
      return <div data-testid="test">Value: {result.value}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    expect(result).not.toBeNull();
    expect(result!.value).toBe(15);
    expect(result!.isMixed).toBe(false);
    expect(result!.isSupported).toBe(true);
  });

  test("returns entity value when single selected", async () => {
    let result: ParamResult<number> | null = null;
    const entityCellSize = 42;

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Create entity directly in store to bypass URL param override
          const entity = createTestEntity({ shaderParams: { size: entityCellSize } });
          canvasStore.addEntity(entity);
          canvasStore.replaceSelection([entity.id]);
          setReady(true);
        }
      }, [ready]);

      result = useParamValue("size", 10);
      return <div data-testid="test">Value: {result.value}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.value === entityCellSize);

    expect(result!.value).toBe(entityCellSize);
    expect(result!.isMixed).toBe(false);
  });

  test("returns first value with isMixed=true when values differ", async () => {
    let result: ParamResult<number> | null = null;
    const entityIds: string[] = [];

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Create entities directly in store to bypass URL param override
          const entity1 = createTestEntity({ shaderParams: { size: 10 } });
          const entity2 = createTestEntity({ shaderParams: { size: 20 } });
          const entity3 = createTestEntity({ shaderParams: { size: 30 } });
          canvasStore.addEntity(entity1);
          canvasStore.addEntity(entity2);
          canvasStore.addEntity(entity3);
          entityIds.push(entity1.id, entity2.id, entity3.id);
          canvasStore.replaceSelection(entityIds);
          setReady(true);
        }
      }, [ready]);

      result = useParamValue("size", 5);
      return <div data-testid="test">Mixed: {String(result.isMixed)}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.isMixed === true);

    expect(result!.isMixed).toBe(true);
    // First entity's value should be returned
    expect(result!.value).toBe(10);
    // All distinct values should be in the values set
    expect(result!.values.size).toBe(3);
    expect(result!.values.has(10)).toBe(true);
    expect(result!.values.has(20)).toBe(true);
    expect(result!.values.has(30)).toBe(true);
  });

  test("returns isMixed=false when all values are same", async () => {
    let result: ParamResult<number> | null = null;
    const entityIds: string[] = [];
    const uniformValue = 25;

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Create entities directly in store to bypass URL param override
          const entity1 = createTestEntity({ shaderParams: { size: uniformValue } });
          const entity2 = createTestEntity({ shaderParams: { size: uniformValue } });
          canvasStore.addEntity(entity1);
          canvasStore.addEntity(entity2);
          entityIds.push(entity1.id, entity2.id);
          canvasStore.replaceSelection(entityIds);
          setReady(true);
        }
      }, [ready]);

      result = useParamValue("size", 5);
      return <div data-testid="test">Mixed: {String(result.isMixed)}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.value === uniformValue);

    expect(result!.isMixed).toBe(false);
    expect(result!.value).toBe(uniformValue);
    expect(result!.values.size).toBe(1);
  });

  test("returns isSupported=false for unsupported params", async () => {
    let result: ParamResult<number> | null = null;

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          const entity = createTestEntity({ shaderType: ShaderType.dithering });
          canvasStore.addEntity(entity);
          canvasStore.replaceSelection([entity.id]);
          setReady(true);
        }
      }, [ready]);

      // blobs param is only supported by blobs shader
      result = useParamValue("blobs.eagerness", 0.5);
      return <div data-testid="test">Supported: {String(result.isSupported)}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.isSupported === false);

    expect(result!.isSupported).toBe(false);
  });

  test("stops aggregating values as soon as a parameter is unsupported", () => {
    const first = createTestEntity({
      id: "unsupported-fast-first",
      shaderType: ShaderType.dithering,
    });
    const second = createTestEntity({
      id: "unsupported-fast-second",
      shaderType: ShaderType.dithering,
    });
    Object.defineProperty(second, "shaderParams", {
      get: () => {
        throw new Error("unsupported selections must not inspect later parameter values");
      },
    });
    canvasStore.addEntities([first, second]);
    canvasStore.replaceSelection([first.id, second.id]);

    expect(canvasStore.getParamResult("blobs.eagerness", 0.5).isSupported).toBe(false);
  });

  test("returns isSupported=true for supported params", async () => {
    let result: ParamResult<number> | null = null;

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Create a blobs entity directly in store to bypass URL param override
          const entity = createTestEntity({ shaderType: ShaderType.blobs });
          canvasStore.addEntity(entity);
          canvasStore.replaceSelection([entity.id]);
          setReady(true);
        }
      }, [ready]);

      result = useParamValue("blobs.eagerness", 0.5);
      return <div data-testid="test">Supported: {String(result.isSupported)}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.isSupported === true);

    expect(result!.isSupported).toBe(true);
  });

  test("handles nested paths like 'adjustments.brightness'", async () => {
    let result: ParamResult<number> | null = null;
    const brightnessValue = 0.75;

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Create entity directly in store to bypass URL param override
          const entity = createTestEntity({
            shaderParams: {
              adjustments: {
                brightness: brightnessValue,
                contrast: 0.5,
                saturation: 0.5,
                blur: 0,
              },
            },
          });
          canvasStore.addEntity(entity);
          canvasStore.replaceSelection([entity.id]);
          setReady(true);
        }
      }, [ready]);

      result = useParamValue("adjustments.brightness", 0.5);
      return <div data-testid="test">Brightness: {result.value}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.value === brightnessValue);

    expect(result!.value).toBe(brightnessValue);
    expect(result!.isMixed).toBe(false);
  });

  test("handles deeply nested paths like 'postProcess.grain.intensity'", async () => {
    let result: ParamResult<number> | null = null;
    const grainIntensity = 0.3;

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Create entity directly in store to bypass URL param override
          const entity = createTestEntity({
            shaderParams: {
              postProcess: {
                enabled: true,
                grain: {
                  enabled: true,
                  size: 1,
                  intensity: grainIntensity,
                },
              },
            },
          });
          canvasStore.addEntity(entity);
          canvasStore.replaceSelection([entity.id]);
          setReady(true);
        }
      }, [ready]);

      result = useParamValue("postProcess.grain.intensity", 0.15);
      return <div data-testid="test">Intensity: {result.value}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.value === grainIntensity);

    expect(result!.value).toBe(grainIntensity);
  });

  test("handles boolean params correctly", async () => {
    let result: ParamResult<boolean> | null = null;
    const entityIds: string[] = [];

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Create entities directly in store to bypass URL param override
          const entity1 = createTestEntity({ shaderParams: { showOriginal: true } });
          const entity2 = createTestEntity({ shaderParams: { showOriginal: false } });
          canvasStore.addEntity(entity1);
          canvasStore.addEntity(entity2);
          entityIds.push(entity1.id, entity2.id);
          canvasStore.replaceSelection(entityIds);
          setReady(true);
        }
      }, [ready]);

      result = useParamValue("showOriginal", false);
      return <div data-testid="test">Mixed: {String(result.isMixed)}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.isMixed === true);

    expect(result!.isMixed).toBe(true);
    expect(result!.values.has(true)).toBe(true);
    expect(result!.values.has(false)).toBe(true);
  });

  test("handles object params like palette", async () => {
    let result: ParamResult<unknown> | null = null;
    const entityIds: string[] = [];

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Create entities directly in store to bypass URL param override
          const entity1 = createTestEntity({ shaderParams: { palette: config.palettes.gameboy } });
          const entity2 = createTestEntity({ shaderParams: { palette: config.palettes.cga } });
          canvasStore.addEntity(entity1);
          canvasStore.addEntity(entity2);
          entityIds.push(entity1.id, entity2.id);
          canvasStore.replaceSelection(entityIds);
          setReady(true);
        }
      }, [ready]);

      result = useParamValue("palette", null);
      return <div data-testid="test">Mixed: {String(result.isMixed)}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.isMixed === true);

    expect(result!.isMixed).toBe(true);
    // First entity's palette should be the value
    expect((result!.value as typeof config.palettes.gameboy)?.id).toBe(config.palettes.gameboy.id);
  });

  test("handles enum params like dithering.kind", async () => {
    let result: ParamResult<DitheringKind> | null = null;
    const entityIds: string[] = [];

    function TestComponent() {
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Create entities directly in store to bypass URL param override
          const entity1 = createTestEntity({
            shaderType: ShaderType.dithering,
            shaderParams: { dithering: { kind: DitheringKind.bayer4x4 } },
          });
          const entity2 = createTestEntity({
            shaderType: ShaderType.dithering,
            shaderParams: { dithering: { kind: DitheringKind.floydSteinberg } },
          });
          canvasStore.addEntity(entity1);
          canvasStore.addEntity(entity2);
          entityIds.push(entity1.id, entity2.id);
          canvasStore.replaceSelection(entityIds);
          setReady(true);
        }
      }, [ready]);

      result = useParamValue("dithering.kind", DitheringKind.bayer2x2);
      return <div data-testid="test">Mixed: {String(result.isMixed)}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => result?.isMixed === true);

    expect(result!.isMixed).toBe(true);
    expect(result!.value).toBe(DitheringKind.bayer4x4); // First entity's value
    expect(result!.values.has(DitheringKind.bayer4x4)).toBe(true);
    expect(result!.values.has(DitheringKind.floydSteinberg)).toBe(true);
  });

  test("updates when selection changes", async () => {
    // Test that getParamResult (underlying store method) returns different values
    // when selection changes - the hook is just a thin wrapper around this

    // Create entities directly in store
    const entity1 = createTestEntity({ shaderParams: { size: 10 } });
    const entity2 = createTestEntity({ shaderParams: { size: 30 } });
    canvasStore.addEntity(entity1);
    canvasStore.addEntity(entity2);

    // Select first entity
    canvasStore.replaceSelection([entity1.id]);
    let result = canvasStore.getParamResult("size", 5);
    expect(result.value).toBe(10);

    // Change selection to second entity
    canvasStore.replaceSelection([entity2.id]);
    result = canvasStore.getParamResult("size", 5);
    expect(result.value).toBe(30);

    // Select both - should return first entity's value
    canvasStore.replaceSelection([entity1.id, entity2.id]);
    result = canvasStore.getParamResult("size", 5);
    expect(result.value).toBe(10);
    expect(result.isMixed).toBe(true);
  });
});

describe("paramVisibilityRules", () => {
  describe("dithering scale", () => {
    test("scale is supported for ordered dithering (bayer)", () => {
      const entity = createTestEntity({
        shaderType: ShaderType.dithering,
        shaderParams: { dithering: { kind: DitheringKind.bayer8x8 } },
      });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const result = canvasStore.getParamResult("scale", 1);
      expect(result.isSupported).toBe(true);
    });

    test("scale is not supported for error-diffusion dithering (floyd-steinberg)", () => {
      const entity = createTestEntity({
        shaderType: ShaderType.dithering,
        shaderParams: { dithering: { kind: DitheringKind.floydSteinberg } },
      });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const result = canvasStore.getParamResult("scale", 1);
      expect(result.isSupported).toBe(false);
    });

    test("scale is not supported for error-diffusion dithering (atkinson)", () => {
      const entity = createTestEntity({
        shaderType: ShaderType.dithering,
        shaderParams: { dithering: { kind: DitheringKind.atkinson } },
      });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const result = canvasStore.getParamResult("scale", 1);
      expect(result.isSupported).toBe(false);
    });

    test("scale is supported when dithering kind is not set (defaults to bayer)", () => {
      const entity = createTestEntity({
        shaderType: ShaderType.dithering,
        // No dithering.kind set — defaults apply, which is bayer8x8
      });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const result = canvasStore.getParamResult("scale", 1);
      expect(result.isSupported).toBe(true);
    });

    test("scale is not supported when mixing bayer and error-diffusion", () => {
      const bayer = createTestEntity({
        shaderType: ShaderType.dithering,
        shaderParams: { dithering: { kind: DitheringKind.bayer4x4 } },
      });
      const floyd = createTestEntity({
        shaderType: ShaderType.dithering,
        shaderParams: { dithering: { kind: DitheringKind.floydSteinberg } },
      });
      canvasStore.addEntity(bayer);
      canvasStore.addEntity(floyd);
      canvasStore.replaceSelection([bayer.id, floyd.id]);

      const result = canvasStore.getParamResult("scale", 1);
      // every() semantics: all entities must support it
      expect(result.isSupported).toBe(false);
    });

    test("scale is supported for non-dithering shaders (halftone)", () => {
      const entity = createTestEntity({ shaderType: ShaderType.halftone });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const result = canvasStore.getParamResult("scale", 1);
      expect(result.isSupported).toBe(true);
    });
  });

  describe("glass sub-params", () => {
    test("glass.angle is supported for fluted glass", () => {
      const entity = createTestEntity({
        shaderType: ShaderType.glass,
        shaderParams: {
          glass: {
            kind: GlassKind.fluted,
            angle: 0,
            caustic: 0.1,
            frostiness: 0.8,
            highlight: 0.1,
            dispersion: 0.3,
            flow: 0.5,
          },
        },
      });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const result = canvasStore.getParamResult("glass.angle", 0);
      expect(result.isSupported).toBe(true);
    });

    test("glass.angle is not supported for frostedVoronoi glass", () => {
      const entity = createTestEntity({
        shaderType: ShaderType.glass,
        shaderParams: {
          glass: {
            kind: GlassKind.frostedVoronoi,
            angle: 0,
            caustic: 0.1,
            frostiness: 0.8,
            highlight: 0.1,
            dispersion: 0.3,
            flow: 0.5,
          },
        },
      });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const result = canvasStore.getParamResult("glass.angle", 0);
      expect(result.isSupported).toBe(false);
    });

    test("glass.frostiness is supported for frostedVoronoi glass", () => {
      const entity = createTestEntity({
        shaderType: ShaderType.glass,
        shaderParams: {
          glass: {
            kind: GlassKind.frostedVoronoi,
            angle: 0,
            caustic: 0.1,
            frostiness: 0.8,
            highlight: 0.1,
            dispersion: 0.3,
            flow: 0.5,
          },
        },
      });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const result = canvasStore.getParamResult("glass.frostiness", 0.8);
      expect(result.isSupported).toBe(true);
    });

    test("glass.frostiness is not supported for fluted glass", () => {
      const entity = createTestEntity({
        shaderType: ShaderType.glass,
        shaderParams: {
          glass: {
            kind: GlassKind.fluted,
            angle: 0,
            caustic: 0.1,
            frostiness: 0.8,
            highlight: 0.1,
            dispersion: 0.3,
            flow: 0.5,
          },
        },
      });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      const result = canvasStore.getParamResult("glass.frostiness", 0.8);
      expect(result.isSupported).toBe(false);
    });

    test("glass sub-params not supported for non-glass shaders", () => {
      const entity = createTestEntity({ shaderType: ShaderType.halftone });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);

      expect(canvasStore.getParamResult("glass.angle", 0).isSupported).toBe(false);
      expect(canvasStore.getParamResult("glass.frostiness", 0.8).isSupported).toBe(false);
    });
  });
});
