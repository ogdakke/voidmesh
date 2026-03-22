// ---------------------------------------------------------------------------
// react-reconciler Host Config for Canvas UI
// ---------------------------------------------------------------------------
//
// Maps React lifecycle operations to SceneNode mutations.
// Reference: react-three-fiber packages/fiber/src/core/reconciler.tsx
//

import * as React from "react";
import {
  ContinuousEventPriority,
  DiscreteEventPriority,
  DefaultEventPriority,
} from "react-reconciler/constants.js";
import { SceneNode } from "./scene-node.ts";
import type { ReactIconComponent } from "./elements.ts";
import { iconSvgFrom } from "./icon-from-react.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanvasUIInstance = SceneNode;
export type CanvasUITextInstance = never; // We throw on text instances
export type CanvasUIContainer = SceneNode; // Root SceneNode
export type CanvasUIHostContext = Record<string, never>;

// ---------------------------------------------------------------------------
// Icon SVG cache (moved from jsx-runtime.ts)
// ---------------------------------------------------------------------------

const iconSvgCache = new WeakMap<object, string>();

// ---------------------------------------------------------------------------
// Prop normalization (moved from jsx-runtime.ts)
// ---------------------------------------------------------------------------

/** Strip the `ui-` prefix: 'ui-box' → 'box' */
export function stripPrefix(type: string): string {
  return type.startsWith("ui-") ? type.slice(3) : type;
}

/**
 * Normalize props for a SceneNode:
 * - Convert `icon` React component → `svg` string
 * - Extract `children` string as `content` for text elements
 * - Strip React-internal props (ref, key)
 */
export function normalizeProps(
  type: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const key in props) {
    // Skip React-internal props
    if (key === "ref" || key === "key") continue;
    normalized[key] = props[key];
  }

  // For icon elements: convert React component → SVG string
  if (type === "ui-icon" && normalized["icon"] && !normalized["svg"]) {
    const component = normalized["icon"] as ReactIconComponent;
    let svg = iconSvgCache.get(component);
    if (!svg) {
      // Render white so the GPU tint (multiply) can recolor freely.
      svg = iconSvgFrom(component, { color: "#ffffff" });
      iconSvgCache.set(component, svg);
    }
    normalized["svg"] = svg;
    delete normalized["icon"];
  }

  // For text elements: extract string children as content
  if (type === "ui-text" && typeof normalized["children"] === "string") {
    normalized["content"] = normalized["children"];
    delete normalized["children"];
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Priority tracking
// ---------------------------------------------------------------------------

let currentUpdatePriority = 0;

// ---------------------------------------------------------------------------
// No-op constants
// ---------------------------------------------------------------------------

const NO_CONTEXT: CanvasUIHostContext = {};
const noop = () => {};

// ---------------------------------------------------------------------------
// Host Config
// ---------------------------------------------------------------------------

function appendChild(parent: CanvasUIInstance, child: CanvasUIInstance): void {
  child.parent = parent;
  parent.children.push(child);
  parent.bumpRenderVersion();
}

function insertBefore(
  parent: CanvasUIInstance,
  child: CanvasUIInstance,
  beforeChild: CanvasUIInstance,
): void {
  child.parent = parent;
  // Find beforeChild, skipping exiting nodes
  let index = -1;
  for (let i = 0; i < parent.children.length; i++) {
    if (parent.children[i] === beforeChild) {
      index = i;
      break;
    }
  }
  if (index >= 0) {
    parent.children.splice(index, 0, child);
  } else {
    parent.children.push(child);
  }
  parent.bumpRenderVersion();
}

function removeChild(parent: CanvasUIInstance, child: CanvasUIInstance): void {
  // Ghost node: mark for exit animation but do NOT splice from children.
  // The node stays in the tree for layout/render until pruneExitedNodes removes it.
  child.beginExit();
  parent.bumpRenderVersion();
}

// @ts-expect-error we need to provide the type args here!
export const hostConfig: HostConfig = {
  // ── Modes ──────────────────────────────────────────────────────────
  isPrimaryRenderer: false,
  warnsIfNotActing: false,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,

  // ── Core Methods ───────────────────────────────────────────────────

  createInstance(
    type: string,
    props: Record<string, unknown>,
    _rootContainer: CanvasUIContainer,
    _hostContext: CanvasUIHostContext,
    _internalHandle: unknown,
  ): CanvasUIInstance {
    const normalized = normalizeProps(type, props);
    const key = (props.key as string | number | null) ?? null;
    const node = new SceneNode(stripPrefix(type), key, normalized);
    node.phase = "entering";
    return node;
  },

  createTextInstance(
    text: string,
    _rootContainer: CanvasUIContainer,
    _hostContext: CanvasUIHostContext,
    _internalHandle: unknown,
  ): CanvasUITextInstance {
    throw new Error(
      `Canvas UI: Text strings must be wrapped in <Text>. Got: "${text.slice(0, 50)}"`,
    );
  },

  appendInitialChild: appendChild,

  finalizeInitialChildren(): boolean {
    return false;
  },

  shouldSetTextContent(type: string, _props: Record<string, unknown>): boolean {
    return type === "ui-text";
  },

  getRootHostContext(): CanvasUIHostContext {
    return NO_CONTEXT;
  },

  getChildHostContext(): CanvasUIHostContext {
    return NO_CONTEXT;
  },

  getPublicInstance(instance: CanvasUIInstance): CanvasUIInstance {
    return instance;
  },

  prepareForCommit(): null {
    return null;
  },

  resetAfterCommit: noop,
  preparePortalMount: noop,

  scheduleTimeout: (typeof setTimeout === "function" ? setTimeout : undefined) as unknown as (
    fn: (...args: unknown[]) => unknown,
    delay?: number,
  ) => number,

  cancelTimeout: (typeof clearTimeout === "function" ? clearTimeout : undefined) as unknown as (
    id: number,
  ) => void,

  noTimeout: -1 as const,

  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,

  // ── Mutation Methods ───────────────────────────────────────────────

  appendChild,

  appendChildToContainer(container: CanvasUIContainer, child: CanvasUIInstance): void {
    appendChild(container, child);
  },

  insertBefore,

  insertInContainerBefore(
    container: CanvasUIContainer,
    child: CanvasUIInstance,
    beforeChild: CanvasUIInstance,
  ): void {
    insertBefore(container, child, beforeChild);
  },

  removeChild,

  removeChildFromContainer(container: CanvasUIContainer, child: CanvasUIInstance): void {
    removeChild(container, child);
  },

  resetTextContent(_instance: CanvasUIInstance): void {
    // Called when shouldSetTextContent flips from true to false.
    // For our case this means a ui-text element lost its text children.
    // Nothing to do — commitUpdate will set the new props.
  },

  commitTextUpdate: noop as (textInstance: never, oldText: string, newText: string) => void,

  commitMount: noop,

  commitUpdate(
    instance: CanvasUIInstance,
    type: string,
    _prevProps: Record<string, unknown>,
    nextProps: Record<string, unknown>,
    _internalHandle: unknown,
  ): void {
    instance.props = normalizeProps(type, nextProps);

    // Phase management
    if (instance.phase === "entering") {
      instance.phase = "active";
    }
    if (instance.phase === "exiting") {
      // Re-entering — the element reappeared
      instance.phase = "active";
    }

    instance.bumpRenderVersion();
  },

  hideInstance(instance: CanvasUIInstance): void {
    instance.props = { ...instance.props, _hidden: true };
    instance.bumpRenderVersion();
  },

  hideTextInstance: noop as (textInstance: never) => void,

  unhideInstance(instance: CanvasUIInstance, _props: Record<string, unknown>): void {
    const { _hidden: _, ...rest } = instance.props;
    instance.props = rest;
    instance.bumpRenderVersion();
  },

  unhideTextInstance: noop as (textInstance: never, text: string) => void,

  clearContainer(container: CanvasUIContainer): void {
    container.children = [];
    container.bumpRenderVersion();
  },

  // ── Lifecycle / Scheduling ─────────────────────────────────────────

  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: noop,
  afterActiveInstanceBlur: noop,
  prepareScopeUpdate: noop,
  getInstanceFromScope: () => null,
  detachDeletedInstance: noop,

  // ── Priority ───────────────────────────────────────────────────────

  setCurrentUpdatePriority(newPriority: number) {
    currentUpdatePriority = newPriority;
  },

  getCurrentUpdatePriority() {
    return currentUpdatePriority;
  },

  resolveUpdatePriority() {
    if (currentUpdatePriority !== 0) return currentUpdatePriority;

    const eventType = typeof window !== "undefined" ? window.event?.type : undefined;
    switch (eventType) {
      case "click":
      case "contextmenu":
      case "dblclick":
      case "pointercancel":
      case "pointerdown":
      case "pointerup":
        return DiscreteEventPriority;
      case "pointermove":
      case "pointerout":
      case "pointerover":
      case "pointerenter":
      case "pointerleave":
      case "wheel":
        return ContinuousEventPriority;
      default:
        return DefaultEventPriority;
    }
  },

  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: noop,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  requestPostPaintCallback: noop,

  // ── Suspense ───────────────────────────────────────────────────────

  maySuspendCommit: () => false,
  preloadInstance: () => true,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  startSuspendingCommit: () => null,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  getSuspendedCommitReason: () => null,

  // ── Transitions ────────────────────────────────────────────────────

  NotPendingTransition: null,
  HostTransitionContext: React.createContext(null),
  resetFormInstance: noop,

  // ── View Transitions (React 19 — all no-ops) ──────────────────────

  applyViewTransitionName: noop,
  restoreViewTransitionName: noop,
  cancelViewTransitionName: noop,
  cancelRootViewTransitionName: noop,
  restoreRootViewTransitionName: noop,
  suspendOnActiveViewTransition: noop,
  startGestureTransition: () => null,
  startViewTransition: () => null,
  stopViewTransition: noop,
  createViewTransitionInstance: () => null,

  getCurrentGestureOffset(): number {
    throw new Error("Gesture transitions are not supported in canvas UI renderer.");
  },

  // ── Instance measurement (View Transitions) ───────────────────────

  InstanceMeasurement: null,
  measureInstance: () => null,
  measureClonedInstance: () => null,
  wasInstanceInViewport: () => true,
  hasInstanceChanged: () => false,
  hasInstanceAffectedParent: () => false,

  // ── Clone (React 19) ──────────────────────────────────────────────

  cloneMutableInstance(instance: CanvasUIInstance): CanvasUIInstance {
    return instance;
  },

  cloneMutableTextInstance(textInstance: unknown): unknown {
    return textInstance;
  },

  cloneRootViewTransitionContainer(): never {
    throw new Error("Not supported.");
  },

  removeRootViewTransitionClone: noop,

  // ── Fragment instances (React 19) ─────────────────────────────────

  createFragmentInstance: () => null,
  updateFragmentInstanceFiber: noop,
  commitNewChildToFragmentInstance: noop,
  deleteChildFromFragmentInstance: noop,

  // ── Renderer identity ─────────────────────────────────────────────

  rendererPackageName: "voidmesh-canvas-ui",
  rendererVersion: "0.1.0",
} as const;
