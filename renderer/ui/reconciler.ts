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
  const propsChanged = updateProps(existing, element.props);

  // Transition from entering to active
  if (existing.phase === "entering") {
    existing.phase = "active";
  }
  // If re-entering (was exiting, now has a matching element again), reactivate
  if (existing.phase === "exiting") {
    existing.phase = "active";
  }

  const childrenChanged = reconcileChildren(existing, element);
  if (propsChanged || childrenChanged) {
    existing.bumpRenderVersion();
  }
  return existing;
}

/** Update a node's props. */
function updateProps(node: SceneNode, newProps: Record<string, unknown>): boolean {
  const changed = !equalRenderableProps(node.props, newProps);
  node.props = newProps;
  return changed;
}

/** Reconcile children of a parent node against the element's children. */
function reconcileChildren(parent: SceneNode, element: UIElement): boolean {
  const elementChildren = getElementChildren(element);
  const oldChildren = parent.children;

  if (elementChildren.length === 0 && oldChildren.length === 0) return false;

  // Build keyed index from old children (reuse scratch Maps to avoid per-frame allocation)
  const keyedOld = parent.scratch.keyedOld;
  const usedKeys = parent.scratch.usedKeys;
  keyedOld.clear();
  usedKeys.clear();
  const newChildren: SceneNode[] = [];

  let unkeyedIndex = 0;
  let unkeyedStart = -1;

  for (let i = 0; i < oldChildren.length; i++) {
    const child = oldChildren[i]!;
    if (child.key != null) {
      keyedOld.set(child.key, child);
    } else if (unkeyedStart === -1) {
      unkeyedStart = i;
    }
  }
  if (unkeyedStart === -1) unkeyedStart = oldChildren.length;

  let changed = false;

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
      while (unkeyedStart + unkeyedIndex < oldChildren.length) {
        const candidate = oldChildren[unkeyedStart + unkeyedIndex]!;
        if (candidate.key != null) {
          unkeyedIndex++;
          continue;
        }
        unkeyedIndex++;
        if (candidate.type === resolved.type) {
          match = candidate;
          break;
        } else {
          // Type mismatch — exit the old node
          candidate.beginExit();
          if (!candidate.canPrune) newChildren.push(candidate);
        }
      }
    }

    const previousVersion = match?.renderVersion ?? -1;
    const reconciled = reconcileNode(resolved, match);
    reconciled.parent = parent;
    newChildren.push(reconciled);
    if (reconciled !== match || reconciled.renderVersion !== previousVersion) {
      changed = true;
    }
  }

  // Mark remaining unmatched old children for exit
  for (const [key, child] of keyedOld) {
    if (!usedKeys.has(key)) {
      child.beginExit();
      changed = true;
      if (!child.canPrune) {
        child.parent = parent;
        newChildren.push(child);
      }
    }
  }
  while (unkeyedStart + unkeyedIndex < oldChildren.length) {
    const child = oldChildren[unkeyedStart + unkeyedIndex]!;
    unkeyedIndex++;
    if (child.key != null) continue;
    child.beginExit();
    changed = true;
    if (!child.canPrune) {
      child.parent = parent;
      newChildren.push(child);
    }
  }

  if (oldChildren.length !== newChildren.length) {
    changed = true;
  } else {
    for (let i = 0; i < newChildren.length; i++) {
      if (newChildren[i] !== oldChildren[i]) {
        changed = true;
        break;
      }
    }
  }

  parent.children = newChildren;
  return changed;
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
export function pruneExitedNodes(root: SceneNode): boolean {
  let changed = false;
  const children = root.children;
  let writeIndex = 0;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (pruneExitedNodes(child)) {
      changed = true;
    }
    if (child.canPrune) {
      changed = true;
    } else {
      children[writeIndex++] = child;
    }
  }
  if (writeIndex < children.length) {
    children.length = writeIndex;
  }
  return changed;
}

function equalRenderableProps(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;

  let aCount = 0;
  for (const key in a) {
    if (!isRenderablePropKey(key)) continue;
    aCount++;
    if (!(key in b)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }

  let bCount = 0;
  for (const key in b) {
    if (!isRenderablePropKey(key)) continue;
    bCount++;
  }

  return aCount === bCount;
}

function isRenderablePropKey(key: string): boolean {
  return key !== "children" && !key.startsWith("on");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a !== "object") return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;

  let aCount = 0;
  for (const key in aObj) {
    aCount++;
    if (!(key in bObj)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }

  let bCount = 0;
  for (const _key in bObj) {
    bCount++;
  }

  return aCount === bCount;
}
