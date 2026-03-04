import { logger } from "#lib/client.logger.ts";
import { Store } from "#lib/store.ts";
import { isMacOS, isWindows } from "#lib/util.ts";
import { createContext, use, useEffect, useRef, useSyncExternalStore } from "react";

type BaseBindProperties = {
  /** @default "all" */
  platform?: "macos" | "other" | "all";
  /** @default "global" */
  group?: string;
  label: string;
  description?: string;
  action: ((e: KeyboardEvent) => void) | ((e: KeyboardEvent) => Promise<void>);
  /** id you can query the store with */
  id?: string;
};

export type Keybind<T extends string = string> = BaseBindProperties & {
  bind: BindBuilder<T>;
};

type InitialBind<T extends string> = BaseBindProperties & {
  bind: T | ((bp: BindBuilder<T>) => Bind<T>);
};

type KeybindUnion<T extends string = ""> = InitialBind<T> | Keybind<T>;

export const ContextName = ["global", "canvas", "selection"] as const;
export type ContextName = (typeof ContextName)[number];

// Define parent relationships for context hierarchy
const CONTEXT_HIERARCHY: Record<ContextName, ContextName | null> = {
  global: null,
  canvas: "global",
  selection: "canvas",
};

// Contexts that require canvas focus to fire
const CANVAS_FOCUS_REQUIRED_CONTEXTS: Set<ContextName> = new Set(["canvas", "selection"]);

// CSS selector for the canvas region
const CANVAS_REGION_SELECTOR = ".infinite-canvas";

interface Bind<T = ""> {
  bind: T;
  keys: string[];
  sensitive: boolean;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

class BindBuilder<TString extends string = ""> {
  bind: TString;
  keys: string[] = [];
  sensitive: boolean;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;

  constructor(bind?: Partial<Omit<Bind<TString>, "keys">>) {
    this.bind = (bind?.bind ?? "") as TString;
    this.sensitive = bind?.sensitive ?? true;
    this.meta = bind?.meta ?? false;
    this.ctrl = bind?.ctrl ?? false;
    this.shift = bind?.shift ?? false;
    this.alt = bind?.alt ?? false;
  }

  toString() {
    return this.bind;
  }

  toSymbols() {
    const isMac = isMacOS();
    const isWin = isWindows();
    const symbols = this.keys.map((key) => {
      switch (key) {
        case "Meta":
          return isMac ? "⌘" : isWin ? "Win" : "Meta";
        case "Shift":
          return "⇧";
        case "Alt":
          return isMac ? "⌥" : isWin ? "Alt" : "Alt";
        case "Ctrl":
          return isMac ? "⌃" : isWin ? "Ctrl" : "Ctrl";
        case "ArrowDown":
          return "↓";
        case "ArrowUp":
          return "↑";
        case "ArrowLeft":
          return "←";
        case "ArrowRight":
          return "→";
        case "Enter":
          return "⏎";
        case "Backspace":
          return "⌫";
        case "Delete":
          return "⌦";
        case "Escape":
          return "⎋";
        case "Tab":
          return "⇥";
        case " ":
          return "Space";
        default:
          return key;
      }
    });

    return symbols;
  }

  key<T extends string>(key: T) {
    const separator = this.#needsSeparator() ? "+" : "";
    return new BindBuilder({
      bind: this.bind + separator + key,
      sensitive: this.sensitive,
      meta: this.meta,
      ctrl: this.ctrl,
      shift: this.shift,
      alt: this.alt,
    }) as BindBuilder<`${TString}${T}`>;
  }

  withSensitive(sensitive: boolean) {
    return new BindBuilder({
      bind: this.bind,
      sensitive,
      meta: this.meta,
      ctrl: this.ctrl,
      shift: this.shift,
      alt: this.alt,
    }) as BindBuilder<TString>;
  }

  withBind(bind: string) {
    return new BindBuilder({
      bind: this.bind + bind,
      sensitive: this.sensitive,
      meta: this.meta,
      ctrl: this.ctrl,
      shift: this.shift,
      alt: this.alt,
    }) as BindBuilder<TString>;
  }

  withMeta() {
    this.meta = true;
    const separator = this.#needsSeparator() ? "+" : "";
    return new BindBuilder({
      bind: this.bind + separator + "Meta",
      sensitive: this.sensitive,
      meta: true,
      ctrl: this.ctrl,
      shift: this.shift,
      alt: this.alt,
    }) as BindBuilder<`${TString}Meta`>;
  }

  withCtrl() {
    this.ctrl = true;
    const separator = this.#needsSeparator() ? "+" : "";
    return new BindBuilder({
      bind: this.bind + separator + "Ctrl",
      sensitive: this.sensitive,
      meta: this.meta,
      ctrl: true,
      shift: this.shift,
      alt: this.alt,
    }) as BindBuilder<`${TString}Ctrl`>;
  }

  withShift() {
    this.shift = true;
    const separator = this.#needsSeparator() ? "+" : "";
    return new BindBuilder({
      bind: this.bind + separator + "Shift",
      sensitive: this.sensitive,
      meta: this.meta,
      ctrl: this.ctrl,
      shift: true,
      alt: this.alt,
    }) as BindBuilder<`${TString}Shift`>;
  }

  withAlt() {
    this.alt = true;
    const separator = this.#needsSeparator() ? "+" : "";
    return new BindBuilder({
      bind: this.bind + separator + "Alt",
      sensitive: this.sensitive,
      meta: this.meta,
      ctrl: this.ctrl,
      shift: this.shift,
      alt: true,
    }) as BindBuilder<`${TString}Alt`>;
  }

  get and() {
    return new BindBuilder({
      bind: this.bind + "+",
      sensitive: this.sensitive,
      meta: this.meta,
      ctrl: this.ctrl,
      shift: this.shift,
      alt: this.alt,
    }) as BindBuilder<`${TString}+`>;
  }

  parse<T extends string>(kb: T) {
    const parts = kb.split("+");
    // const lastKey = parts[parts.length - 1]!;

    if (parts.length === 0) {
      return new BindBuilder().withBind(kb).#withKeys(parts);
    }

    const builder = new BindBuilder({ bind: kb });
    for (const key of parts) {
      if (key === "Meta") {
        builder.withMeta();
      } else if (key === "Ctrl") {
        builder.withCtrl();
      } else if (key === "Shift") {
        builder.withShift();
      } else if (key === "Alt") {
        builder.withAlt();
      }
    }

    return builder.#withKeys(parts);
  }

  build(): Bind<TString> {
    return {
      bind: this.bind,
      keys: this.keys,
      sensitive: this.sensitive,
      meta: this.meta,
      ctrl: this.ctrl,
      shift: this.shift,
      alt: this.alt,
    };
  }

  #withKeys(keys: string[]) {
    this.keys = keys;
    return this;
  }

  #needsSeparator() {
    return this.bind.length > 0 && !this.bind.endsWith("+");
  }
}

type KeybindStoreState = { version: number };

export class KeybindStore extends Store<KeybindStoreState> {
  #contexts: Map<ContextName, Map<string, Keybind<string>>>;
  #activeContext: ContextName = "global";
  #globalListener: ((e: KeyboardEvent) => void) | null = null;

  readonly getEntriesByGroup: () => Map<string, Keybind<string>[]>;

  constructor() {
    super({ version: 0 });
    this.getEntriesByGroup = this.createSnapshot("version", () => this.#buildEntriesByGroup());
    this.#contexts = new Map();
    // Initialize all contexts
    for (const name of Object.keys(CONTEXT_HIERARCHY)) {
      this.#contexts.set(name as ContextName, new Map());
    }
    this.#setupGlobalListener();
  }

  /**
   * Check if focus is currently in the canvas region.
   * Returns true if:
   * - No element is focused (body/document has focus)
   * - Focused element is inside the canvas container
   * Returns false if focus is on a form control outside the canvas.
   */
  #isFocusInCanvasRegion(): boolean {
    const activeElement = document.activeElement;

    // If nothing specific is focused, canvas keybinds should work
    if (!activeElement || activeElement === document.body) {
      return true;
    }

    // If focus is inside the canvas region, canvas keybinds should work
    if (activeElement.closest(CANVAS_REGION_SELECTOR)) {
      return true;
    }

    // Focus is outside the canvas region - check if it's a form control
    // that should capture keyboard input
    if (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement ||
      activeElement instanceof HTMLButtonElement ||
      activeElement.hasAttribute("contenteditable")
    ) {
      return false;
    }

    // For other elements outside canvas, allow canvas keybinds
    return true;
  }

  #setupGlobalListener() {
    this.#globalListener = async (e: KeyboardEvent) => {
      if (isUserTypingInInput()) return;

      const keybind = this.#findKeybind(e);

      if (keybind) {
        await keybind.action(e);
      }
    };

    // Use capture phase to handle events before buttons/dropzones can stop propagation
    window.addEventListener("keydown", this.#globalListener, { capture: true });
  }

  #shouldCallCombination(e: KeyboardEvent, bb: BindBuilder<string>): boolean {
    // Check Meta, Ctrl, Alt exactly
    if (bb.meta !== e.metaKey) return false;
    if (bb.ctrl !== e.ctrlKey) return false;
    if (bb.alt !== e.altKey) return false;

    // Find the actual key (non-modifier) in the keybind
    const actualKey = bb.keys.find(
      (key) =>
        key !== "Meta" &&
        key !== "Command" &&
        key !== "Control" &&
        key !== "Ctrl" &&
        key !== "Alt" &&
        key !== "Option" &&
        key !== "Shift",
    );

    // If there's no actual key (only modifiers), don't match
    if (!actualKey) return false;

    // Check if the key is a letter (a-z or A-Z)
    const isLetter = /^[a-zA-Z]$/.test(actualKey);

    if (isLetter) {
      // For letters, Shift changes the case
      if (bb.shift) {
        // Keybind explicitly requires Shift - check it and match case-insensitively
        if (!e.shiftKey) return false;
        return e.key.toLowerCase() === actualKey.toLowerCase();
      } else {
        // No explicit Shift - must not have Shift pressed (prevents Cmd+C matching Cmd+Shift+C)
        if (e.shiftKey) return false;
        // Match based on sensitivity setting
        if (bb.sensitive) {
          return e.key === actualKey;
        }
        return e.key.toLowerCase() === actualKey.toLowerCase();
      }
    }

    // For non-letters (symbols like "?", numbers, special keys):
    // Don't check e.shiftKey - just match the character directly
    // This allows "?" to work when Shift+/ is pressed
    return e.key === actualKey;
  }

  // Walk up the hierarchy to find a matching keybind
  #findKeybind(e: KeyboardEvent): Keybind<string> | undefined {
    let contextName: ContextName | null = this.#activeContext;

    while (contextName !== null) {
      // Skip canvas/selection contexts if focus is on a form control outside the canvas
      // This allows arrow keys, escape, etc. to work in native widgets (selects, inputs, etc.)
      if (CANVAS_FOCUS_REQUIRED_CONTEXTS.has(contextName) && !this.#isFocusInCanvasRegion()) {
        contextName = CONTEXT_HIERARCHY[contextName];
        continue;
      }

      const context = this.#contexts.get(contextName);
      if (context) {
        // Check each keybind in this context
        for (const kb of context.values()) {
          if (this.#shouldCallCombination(e, kb.bind)) {
            return kb;
          }
        }
      }
      contextName = CONTEXT_HIERARCHY[contextName];
    }
    return undefined;
  }

  register(contextName: ContextName, bind: InitialBind<string>) {
    let bb = new BindBuilder();
    if (typeof bind.bind === "function") {
      bb = bb.parse(bind.bind(bb).bind);
    } else if (typeof bind.bind === "string") {
      bb = bb.parse(bind.bind);
    } else {
      throw new Error("Invalid bind type", { cause: bind.bind });
    }

    const context = this.#contexts.get(contextName);
    if (!context) {
      throw new Error(`Context "${contextName}" not found`);
    }

    const newKeyBind: Keybind<string> = { ...bind, bind: bb };

    context.set(bb.toString(), newKeyBind);
    this.state.version++;
    this.notify();

    const cleanup = () => {
      context.delete(bb.toString());
      this.state.version++;
      this.notify();
    };

    return cleanup;
  }

  setActiveContext(name: ContextName) {
    this.#activeContext = name;
    logger.debug(`Active keybind context set to: ${name}`);
  }

  getActiveContext(): ContextName {
    return this.#activeContext;
  }

  entries(): Keybind<string>[] {
    const allKeybinds: Keybind<string>[] = [];
    for (const context of this.#contexts.values()) {
      allKeybinds.push(...context.values());
    }
    return allKeybinds;
  }

  // Get keybind by ID (for UI) - searches all contexts
  getById(id: string): Keybind<string> | undefined {
    // Start from most specific context in hierarchy for platform matching
    for (const contextName of ContextName) {
      const context = this.#contexts.get(contextName);
      if (!context) continue;

      for (const kb of context.values()) {
        if (kb.id === id) {
          // Check platform compatibility
          if (isMacOS()) {
            if (kb.platform === "macos" || kb.platform === "all") return kb;
          } else {
            if (kb.platform === "all" || kb.platform === "other") return kb;
          }
        }
      }
    }
    return undefined;
  }

  // Get all keybinds grouped by context (for keyboard shortcuts panel)
  entriesByContext(): Map<ContextName, Keybind<string>[]> {
    const result = new Map<ContextName, Keybind<string>[]>();
    for (const [name, context] of this.#contexts) {
      result.set(name, [...context.values()]);
    }
    return result;
  }

  #buildEntriesByGroup(): Map<string, Keybind<string>[]> {
    const groups = new Map<string, Keybind<string>[]>();
    for (const kb of this.entries()) {
      const groupName = kb.group ?? "global";
      const existing = groups.get(groupName) ?? [];
      existing.push(kb);
      groups.set(groupName, existing);
    }
    return groups;
  }

  createBind(bind?: Bind) {
    return new BindBuilder(bind);
  }
}

export const keybindStore = new KeybindStore();

export const KeybindContext = createContext<KeybindStore | null>(null);

export function useKeybinds() {
  const store = use(KeybindContext);

  if (!store) {
    throw new Error("KeybindProvider not found");
  }

  return store;
}

export function useKeybindEntries() {
  const store = useKeybinds();
  return useSyncExternalStore(store.subscribe, store.getEntriesByGroup);
}

export function useKeybind<T extends string, kb extends KeybindUnion<T>>(
  contextName: ContextName,
  keybind: kb,
) {
  const store = useKeybinds();
  const actionRef = useRef(keybind.action);

  // Keep the ref updated with the latest action
  actionRef.current = keybind.action;

  const bindString = keybind.bind.toString();

  useEffect(() => {
    const isMac = isMacOS();
    if (isMac && keybind.platform === "other") return;
    if (!isMac && keybind.platform === "macos") return;

    return store.register(contextName, {
      platform: "all",
      ...keybind,
      action: (e: KeyboardEvent) => actionRef.current(e),
    } as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keybind object changes every render; bind key is the meaningful dep, action handled via ref
  }, [store, contextName, bindString]);
}

export function useRegisterKeybinds(contextName: ContextName, keybinds: KeybindUnion<string>[]) {
  const store = useKeybinds();
  const actionsRef = useRef(keybinds.map((kb) => kb.action));

  // Keep the refs updated with the latest actions
  actionsRef.current = keybinds.map((kb) => kb.action);

  // Stable dependency key for the binds
  const bindsKey = keybinds.map((kb) => kb.bind.toString()).join(",");

  useEffect(() => {
    const disposables = keybinds.map((keybind, index) => {
      const isMac = isMacOS();
      if (isMac && keybind.platform === "other") return;
      if (!isMac && keybind.platform === "macos") return;

      return store.register(contextName, {
        platform: "all",
        ...keybind,
        action: (e: KeyboardEvent) => actionsRef.current[index]?.(e),
      } as any);
    });

    return () => {
      disposables.forEach((dispose) => dispose?.());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keybinds array changes every render; bindsKey is the stable proxy, actions handled via ref
  }, [store, contextName, bindsKey]);
}

/**
 * Check if user is currently typing in a text input field.
 * Returns false for non-text inputs (sliders, checkboxes) so shortcuts still work.
 */
export function isUserTypingInInput(): boolean {
  const activeElement = document.activeElement;

  if (!activeElement) return false;

  // Check for textarea
  if (activeElement instanceof HTMLTextAreaElement) {
    return true;
  }

  // Check for input that tend to use keyboard keys
  if (activeElement instanceof HTMLInputElement) {
    const textInputTypes = [
      "text",
      "password",
      "email",
      "search",
      "tel",
      "url",
      "number",
      "range",
      "radio",
    ];
    return textInputTypes.includes(activeElement.type);
  }

  // Check for contentEditable elements
  if (
    activeElement.hasAttribute("contenteditable") &&
    activeElement.getAttribute("contenteditable") !== "false"
  ) {
    return true;
  }

  if (activeElement.role === "slider") {
    return true;
  }

  return false;
}
