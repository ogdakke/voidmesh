const MANUAL_MEMOIZATION_APIS = new Set(["memo", "useCallback", "useMemo"]);

const MESSAGE =
  "Avoid manual React memoization. React Compiler should own memoization unless there is a documented escape hatch.";

function isReactImport(node) {
  return node.source?.value === "react";
}

function propertyName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  return undefined;
}

function isNamespaceCall(callee, reactNamespaces) {
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const object = callee.object;
  const name = propertyName(callee.property);
  return (
    object.type === "Identifier" &&
    reactNamespaces.has(object.name) &&
    MANUAL_MEMOIZATION_APIS.has(name)
  );
}

function createManualMemoizationVisitors(context) {
  let importedManualMemoization = new Set();
  let reactNamespaces = new Set();

  return {
    Program() {
      importedManualMemoization = new Set();
      reactNamespaces = new Set();
    },

    ImportDeclaration(node) {
      if (!isReactImport(node)) return;

      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          reactNamespaces.add(specifier.local.name);
          continue;
        }

        if (specifier.type === "ImportDefaultSpecifier") {
          reactNamespaces.add(specifier.local.name);
          continue;
        }

        if (specifier.type !== "ImportSpecifier") continue;

        const importedName = propertyName(specifier.imported);
        if (MANUAL_MEMOIZATION_APIS.has(importedName)) {
          importedManualMemoization.add(specifier.local.name);
        }
      }
    },

    CallExpression(node) {
      const { callee } = node;
      const isImportedCall =
        callee.type === "Identifier" && importedManualMemoization.has(callee.name);

      if (!isImportedCall && !isNamespaceCall(callee, reactNamespaces)) return;

      context.report({
        node: callee,
        message: MESSAGE,
      });
    },
  };
}

const noManualMemoization = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow manual React memoization APIs covered by React Compiler.",
    },
  },
  createOnce: createManualMemoizationVisitors,
  create: createManualMemoizationVisitors,
};

export default {
  meta: {
    name: "voidmesh-react-compiler",
  },
  rules: {
    "no-manual-memoization": noManualMemoization,
  },
};
