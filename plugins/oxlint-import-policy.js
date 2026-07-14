import fs from "node:fs";
import path from "node:path";

const LAYERS = new Set([
  "types",
  "lib",
  "engine",
  "application",
  "renderer",
  "context",
  "hooks",
  "components",
]);

const importMappingsByRoot = new Map();

const ALLOWED_DEPENDENCIES = new Map([
  ["types", new Set(["types"])],
  ["lib", new Set(["types", "lib"])],
  ["engine", new Set(["types", "lib", "engine"])],
  ["application", new Set(["types", "lib", "engine", "application"])],
  ["renderer", new Set(["types", "lib", "renderer"])],
  ["context", new Set(["types", "lib", "engine", "application", "renderer", "context", "hooks"])],
  ["hooks", new Set(["types", "lib", "application", "renderer", "context", "hooks"])],
  [
    "components",
    new Set(["types", "lib", "application", "renderer", "context", "hooks", "components"]),
  ],
]);

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function stripImportSuffix(value) {
  return value.split("?")[0];
}

function getImportSuffix(value) {
  return value.slice(stripImportSuffix(value).length);
}

function normalizePackageTarget(target) {
  return normalizePath(target).replace(/^\.[/]/, "");
}

export function getPackageImportMappings(rootDirectory = process.cwd()) {
  const normalizedRoot = path.resolve(rootDirectory);
  const cached = importMappingsByRoot.get(normalizedRoot);
  if (cached) return cached;

  const packageJsonPath = path.join(normalizedRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const mappings = Object.entries(packageJson.imports ?? {})
    .filter(([, target]) => typeof target === "string")
    .map(([alias, rawTarget]) => {
      const target = normalizePackageTarget(rawTarget);
      const wildcard = alias.includes("*") && target.includes("*");
      const targetBase = wildcard
        ? target.slice(0, target.indexOf("*"))
        : path.posix.dirname(target);
      return {
        alias,
        target,
        targetBase: targetBase.replace(/[/]$/, ""),
        wildcard,
      };
    })
    .sort((a, b) => b.targetBase.length - a.targetBase.length);

  importMappingsByRoot.set(normalizedRoot, mappings);
  return mappings;
}

function getLayerForAlias(source, rootDirectory) {
  const cleanSource = stripImportSuffix(source);
  for (const mapping of getPackageImportMappings(rootDirectory)) {
    if (mapping.wildcard) {
      const [aliasPrefix, aliasSuffix] = mapping.alias.split("*");
      if (!cleanSource.startsWith(aliasPrefix) || !cleanSource.endsWith(aliasSuffix)) continue;
    } else if (cleanSource !== mapping.alias) {
      continue;
    }

    const [topLevelDirectory] = mapping.targetBase.split("/");
    return LAYERS.has(topLevelDirectory) ? topLevelDirectory : null;
  }
  return null;
}

export function getLayerForFile(filename, rootDirectory = process.cwd()) {
  const relative = normalizePath(path.relative(rootDirectory, filename));
  if (relative.startsWith("../")) return null;

  const [topLevelDirectory] = relative.split("/");
  return LAYERS.has(topLevelDirectory) ? topLevelDirectory : null;
}

export function getLayerForImport(source, importerFilename, rootDirectory = process.cwd()) {
  const cleanSource = stripImportSuffix(source);

  if (cleanSource.startsWith(".")) {
    const resolved = path.resolve(path.dirname(importerFilename), cleanSource);
    return getLayerForFile(resolved, rootDirectory);
  }

  return getLayerForAlias(cleanSource, rootDirectory);
}

export function isTypeOnlyImport(node) {
  if (node.importKind === "type") return true;
  return (
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type",
    )
  );
}

export function isTypeOnlyExport(node) {
  if (node.exportKind === "type") return true;
  return (
    node.specifiers?.length > 0 &&
    node.specifiers.every((specifier) => specifier.exportKind === "type")
  );
}

export function getImportPolicyViolation({
  filename,
  source,
  typeOnly = false,
  rootDirectory = process.cwd(),
}) {
  const importerLayer = getLayerForFile(filename, rootDirectory);
  const importedLayer = getLayerForImport(source, filename, rootDirectory);
  if (!importerLayer || !importedLayer || importerLayer === importedLayer) return null;

  // Renderer consumes engine-owned render contracts, never engine runtime values.
  if (importerLayer === "renderer" && importedLayer === "engine" && typeOnly) return null;

  const allowed = ALLOWED_DEPENDENCIES.get(importerLayer);
  if (allowed?.has(importedLayer)) return null;

  return {
    importerLayer,
    importedLayer,
    message: `${importerLayer}/ cannot import ${importedLayer}/. Depend on a public, narrow interface in an allowed lower layer instead.`,
  };
}

export function getPreferredPackageImport(source, importerFilename, rootDirectory = process.cwd()) {
  if (!source.startsWith(".")) return null;

  const cleanSource = stripImportSuffix(source);
  const suffix = getImportSuffix(source);
  const resolved = path.resolve(path.dirname(importerFilename), cleanSource);
  const relativeTarget = normalizePath(path.relative(rootDirectory, resolved));
  if (relativeTarget.startsWith("../")) return null;

  const relativeImporter = normalizePath(path.relative(rootDirectory, importerFilename));
  const [importerTopLevel] = relativeImporter.split("/");
  const [targetTopLevel] = relativeTarget.split("/");
  if (importerTopLevel === targetTopLevel) return null;

  for (const mapping of getPackageImportMappings(rootDirectory)) {
    if (mapping.wildcard) {
      const [targetPrefix, targetSuffix] = mapping.target.split("*");
      if (!relativeTarget.startsWith(targetPrefix) || !relativeTarget.endsWith(targetSuffix)) {
        continue;
      }
      const wildcardValue = relativeTarget.slice(
        targetPrefix.length,
        targetSuffix ? -targetSuffix.length : undefined,
      );
      return `${mapping.alias.replace("*", wildcardValue)}${suffix}`;
    }

    const publicTarget = mapping.target;
    const publicDirectory = path.posix.dirname(publicTarget);
    if (
      relativeTarget === publicTarget ||
      relativeTarget === publicDirectory ||
      relativeTarget.startsWith(`${publicDirectory}/`)
    ) {
      return `${mapping.alias}${suffix}`;
    }
  }

  return null;
}

function createVisitors(context) {
  let filename;
  let rootDirectory;

  const checkSource = (node, sourceNode, typeOnly) => {
    const source = sourceNode?.value;
    if (typeof source !== "string") return;

    const violation = getImportPolicyViolation({
      filename,
      source,
      typeOnly,
      rootDirectory,
    });
    if (violation) {
      context.report({
        node: sourceNode ?? node,
        messageId: "layerViolation",
        data: {
          importerLayer: violation.importerLayer,
          importedLayer: violation.importedLayer,
        },
      });
    }
  };

  return {
    before() {
      const options = context.options?.[0] ?? {};
      rootDirectory = path.resolve(options.rootDirectory ?? context.cwd);
      filename = context.filename;
    },
    ImportDeclaration(node) {
      checkSource(node, node.source, isTypeOnlyImport(node));
    },
    ImportExpression(node) {
      checkSource(node, node.source, false);
    },
    ExportNamedDeclaration(node) {
      if (node.source) checkSource(node, node.source, isTypeOnlyExport(node));
    },
    ExportAllDeclaration(node) {
      checkSource(node, node.source, node.exportKind === "type");
    },
  };
}

const enforceLayerBoundaries = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce Voidmesh dependency direction and hide deep-module internals.",
    },
    messages: {
      layerViolation:
        "{{importerLayer}}/ cannot import {{importedLayer}}/. Depend on a public, narrow interface in an allowed lower layer instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          rootDirectory: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
  },
  createOnce: createVisitors,
};

function createPackageImportVisitors(context) {
  let filename;
  let rootDirectory;

  const checkSource = (node, sourceNode) => {
    const source = sourceNode?.value;
    if (typeof source !== "string") return;

    const preferredImport = getPreferredPackageImport(source, filename, rootDirectory);
    if (!preferredImport) return;

    context.report({
      node: sourceNode ?? node,
      messageId: "preferPackageImport",
      data: { preferredImport },
    });
  };

  return {
    before() {
      const options = context.options?.[0] ?? {};
      rootDirectory = path.resolve(options.rootDirectory ?? context.cwd);
      filename = context.filename;
    },
    ImportDeclaration(node) {
      checkSource(node, node.source);
    },
    ImportExpression(node) {
      checkSource(node, node.source);
    },
    ExportNamedDeclaration(node) {
      if (node.source) checkSource(node, node.source);
    },
    ExportAllDeclaration(node) {
      checkSource(node, node.source);
    },
  };
}

const preferPackageImports = {
  meta: {
    type: "problem",
    docs: {
      description: "Require package.json import aliases for cross-module imports.",
    },
    messages: {
      preferPackageImport:
        "Use the package import '{{preferredImport}}' instead of crossing module boundaries with a relative path.",
    },
    schema: enforceLayerBoundaries.meta.schema,
  },
  createOnce: createPackageImportVisitors,
};

export default {
  meta: { name: "voidmesh-import-policy" },
  rules: {
    "enforce-layer-boundaries": enforceLayerBoundaries,
    "prefer-package-imports": preferPackageImports,
  },
};
