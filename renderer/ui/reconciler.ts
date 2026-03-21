// ---------------------------------------------------------------------------
// Canvas UI Reconciler
// ---------------------------------------------------------------------------
//
// Diffs a UIElement tree (produced by JSX) against a retained SceneNode tree.
// Produces an updated SceneNode tree with stable identity for animations
// and interaction.
//
// Algorithm:
// 1. Resolve component functions (call them to get primitive elements)
// 2. Flatten fragments
// 3. Match children by key, then by position+type
// 4. Create new nodes for new elements, begin exit for removed nodes
// 5. Short-circuit when props are referentially equal
//

import type { UIElement, ComponentFn } from "./elements.ts";
import { SceneNode } from "./scene-node.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconcile a UIElement tree against an existing SceneNode tree.
 * Returns the updated (or new) root SceneNode.
 */
export function reconcile(element: UIElement | null, existing: SceneNode | null): SceneNode | null {
  if (element == null) {
    if (existing) existing.beginExit();
    return existing;
  }

  // Resolve the element to primitives (call component functions, flatten fragments)
  const resolved = resolveElement(element);
  if (resolved == null) {
    if (existing) existing.beginExit();
    return existing;
  }

  return reconcileNode(resolved, existing);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Resolve component functions and fragments to primitive elements. */
function resolveElement(element: UIElement): UIElement | null {
  // Component function — call it to get the primitive tree
  if (typeof element.type === "function") {
    const fn = element.type as ComponentFn;
    const result = fn(element.props);
    if (result == null) return null;
    return resolveElement(result);
  }

  // Fragment — if it has exactly one child, unwrap it.
  // Multiple children at the root aren't supported; the caller should wrap in a box.
  if (element.type === "__fragment__") {
    const children = element.props["children"] as UIElement[] | undefined;
    if (!children || children.length === 0) return null;
    if (children.length === 1) return resolveElement(children[0]!);
    // Multiple children: wrap in an implicit box
    return {
      type: "box",
      props: { children },
      key: element.key,
    };
  }

  return element;
}

/** Reconcile a single resolved element against an existing node. */
function reconcileNode(element: UIElement, existing: SceneNode | null): SceneNode {
  // Type or key mismatch — replace entirely
  if (existing && (existing.type !== element.type || existing.key !== element.key)) {
    existing.beginExit();
    existing = null;
  }

  if (!existing) {
    // Create new node
    const node = new SceneNode(element.type as string, element.key, element.props);
    node.phase = "entering";
    reconcileChildren(node, element);
    return node;
  }

  // Update existing node
  updateProps(existing, element.props);

  // Transition from entering to active
  if (existing.phase === "entering") {
    existing.phase = "active";
  }
  // If re-entering (was exiting, now has a matching element again), reactivate
  if (existing.phase === "exiting") {
    existing.phase = "active";
  }

  reconcileChildren(existing, element);
  return existing;
}

/** Update a node's props. */
function updateProps(node: SceneNode, newProps: Record<string, unknown>): void {
  node.props = newProps;
}

/** Reconcile children of a parent node against the element's children. */
function reconcileChildren(parent: SceneNode, element: UIElement): void {
  const elementChildren = getElementChildren(element);
  const oldChildren = parent.children;

  if (elementChildren.length === 0 && oldChildren.length === 0) return;

  // Build keyed index from old children
  const keyedOld = new Map<string | number, SceneNode>();
  const unkeyedOld: (SceneNode | null)[] = [];

  for (const child of oldChildren) {
    if (child.key != null) {
      keyedOld.set(child.key, child);
    } else {
      unkeyedOld.push(child);
    }
  }

  let unkeyedIndex = 0;
  const newChildren: SceneNode[] = [];
  const usedKeys = new Set<string | number>();

  for (const childElement of elementChildren) {
    const resolved = resolveElement(childElement);
    if (resolved == null) continue;

    let match: SceneNode | null = null;

    // Try to match by key
    if (resolved.key != null && keyedOld.has(resolved.key)) {
      match = keyedOld.get(resolved.key)!;
      usedKeys.add(resolved.key);
    }
    // Try to match by position + type (unkeyed)
    else if (resolved.key == null) {
      while (unkeyedIndex < unkeyedOld.length) {
        const candidate = unkeyedOld[unkeyedIndex]!;
        unkeyedIndex++;
        if (candidate && candidate.type === resolved.type) {
          match = candidate;
          break;
        } else if (candidate) {
          // Type mismatch — exit the old node
          candidate.beginExit();
          if (!candidate.canPrune) newChildren.push(candidate);
        }
      }
    }

    const reconciled = reconcileNode(resolved, match);
    reconciled.parent = parent;
    newChildren.push(reconciled);
  }

  // Mark remaining unmatched old children for exit
  for (const [key, child] of keyedOld) {
    if (!usedKeys.has(key)) {
      child.beginExit();
      if (!child.canPrune) {
        child.parent = parent;
        newChildren.push(child);
      }
    }
  }
  while (unkeyedIndex < unkeyedOld.length) {
    const child = unkeyedOld[unkeyedIndex]!;
    unkeyedIndex++;
    if (child) {
      child.beginExit();
      if (!child.canPrune) {
        child.parent = parent;
        newChildren.push(child);
      }
    }
  }

  parent.children = newChildren;
}

/** Extract children from an element, handling fragments. */
function getElementChildren(element: UIElement): UIElement[] {
  const children = element.props["children"];
  if (children == null) return [];
  if (Array.isArray(children)) return children as UIElement[];
  return [children as UIElement];
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Remove exiting nodes whose animations have completed.
 * Call once per frame after animation resolution.
 */
export function pruneExitedNodes(root: SceneNode): void {
  root.children = root.children.filter((child) => {
    pruneExitedNodes(child);
    return !child.canPrune;
  });
}
