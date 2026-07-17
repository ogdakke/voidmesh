import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getImportPolicyViolation,
  getLayerForFile,
  getLayerForImport,
  getPackageImportMappings,
  getPreferredPackageImport,
} from "../../../../plugins/oxlint-import-policy.js";

const rootDirectory = process.cwd();
const file = (relativePath: string) => path.join(rootDirectory, relativePath);

describe("Voidmesh import policy", () => {
  it("classifies project files and aliases", () => {
    expect(getLayerForFile(file("components/example.tsx"), rootDirectory)).toBe("components");
    expect(
      getLayerForImport(
        "#application/canvas/viewport-actions.ts",
        file("context/example.ts"),
        rootDirectory,
      ),
    ).toBe("application");
    expect(
      getLayerForImport("../engine/canvas-store.ts", file("lib/example.ts"), rootDirectory),
    ).toBe("engine");
  });

  it("loads exact and wildcard aliases from package.json", () => {
    const mappings = getPackageImportMappings(rootDirectory);
    expect(mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alias: "#engine", target: "engine/index.ts" }),
        expect.objectContaining({ alias: "#lib/*", target: "lib/*", wildcard: true }),
      ]),
    );
  });

  it("rejects components that reach into the engine", () => {
    expect(
      getImportPolicyViolation({
        filename: file("components/example.tsx"),
        source: "#engine",
        rootDirectory,
      }),
    ).toMatchObject({ importerLayer: "components", importedLayer: "engine" });
  });

  it("rejects relative imports that invert lib dependencies", () => {
    expect(
      getImportPolicyViolation({
        filename: file("lib/entity-placement.ts"),
        source: "../engine/game-loop.ts",
        rootDirectory,
      }),
    ).not.toBeNull();
  });

  it("allows application actions to depend on the public engine module", () => {
    expect(
      getImportPolicyViolation({
        filename: file("application/canvas/viewport-actions.ts"),
        source: "#engine",
        rootDirectory,
      }),
    ).toBeNull();
  });

  it("allows renderer type contracts from engine but rejects runtime values", () => {
    const input = {
      filename: file("renderer/canvas-renderer.ts"),
      source: "#engine",
      rootDirectory,
    };
    expect(getImportPolicyViolation({ ...input, typeOnly: true })).toBeNull();
    expect(getImportPolicyViolation(input)).not.toBeNull();
  });

  it("requires aliases for relative imports across known module boundaries", () => {
    expect(
      getPreferredPackageImport(
        "../../engine/canvas-store.ts",
        file("components/example/component.tsx"),
        rootDirectory,
      ),
    ).toBe("#engine");
    expect(
      getPreferredPackageImport(
        "../lib/canvas-math.ts",
        file("hooks/use-example.ts"),
        rootDirectory,
      ),
    ).toBe("#lib/canvas-math.ts");
  });

  it("keeps imports within a module relative", () => {
    expect(
      getPreferredPackageImport(
        "./button.tsx",
        file("components/ui/button/index.tsx"),
        rootDirectory,
      ),
    ).toBeNull();
  });

  it("enforces package aliases for mapped asset roots", () => {
    expect(
      getPreferredPackageImport(
        "../media/example.webp",
        file("components/example.tsx"),
        rootDirectory,
      ),
    ).toBe("#media/example.webp");
  });
});
