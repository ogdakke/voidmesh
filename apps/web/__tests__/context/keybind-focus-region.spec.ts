/**
 * Tests for focus-region based keybind scoping
 *
 * Ensures that canvas-specific keybinds (arrow keys, Escape, etc.)
 * only fire when focus is NOT on a form control outside the canvas,
 * allowing native widget behavior in sidebar controls.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { KeybindStore } from "#context/keybind-context.ts";

describe("KeybindStore focus region", () => {
  let store: KeybindStore;
  let canvasContainer: HTMLDivElement;

  beforeEach(() => {
    store = new KeybindStore();

    // Create a mock canvas container
    canvasContainer = document.createElement("div");
    canvasContainer.className = "infinite-canvas";
    document.body.appendChild(canvasContainer);
  });

  afterEach(() => {
    // Clean up
    document.body.removeChild(canvasContainer);
    // Reset focus to body
    (document.activeElement as HTMLElement)?.blur?.();
  });

  describe("keybind matching with focus detection", () => {
    test("global context keybinds fire regardless of focus", () => {
      let fired = false;
      store.register("global", {
        bind: "a",
        label: "Test global",
        action: () => {
          fired = true;
        },
      });

      store.setActiveContext("global");

      // Simulate keydown with no specific focus
      const event = new KeyboardEvent("keydown", { key: "a" });
      window.dispatchEvent(event);

      expect(fired).toBe(true);
    });

    test("canvas context keybinds fire when nothing is focused", () => {
      let fired = false;
      store.register("canvas", {
        bind: "ArrowDown",
        label: "Test canvas",
        action: () => {
          fired = true;
        },
      });

      store.setActiveContext("canvas");

      // With no focus (body is active), should fire
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      expect(fired).toBe(true);
    });

    test("canvas context keybinds do NOT fire when select outside canvas has focus", () => {
      let fired = false;
      store.register("canvas", {
        bind: "ArrowDown",
        label: "Test canvas",
        action: () => {
          fired = true;
        },
      });

      store.setActiveContext("canvas");

      // Create a select element outside the canvas
      const select = document.createElement("select");
      document.body.appendChild(select);
      select.focus();

      // With select focused, should NOT fire
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      expect(fired).toBe(false);

      // Cleanup
      document.body.removeChild(select);
    });

    test("canvas context keybinds do NOT fire when input outside canvas has focus", () => {
      let fired = false;
      store.register("canvas", {
        bind: "Escape",
        label: "Clear selection",
        action: () => {
          fired = true;
        },
      });

      store.setActiveContext("canvas");

      // Create an input element outside the canvas
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      // With input focused, should NOT fire
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(fired).toBe(false);

      // Cleanup
      document.body.removeChild(input);
    });

    test("canvas context keybinds fire when element inside canvas has focus", () => {
      let fired = false;
      store.register("canvas", {
        bind: "ArrowDown",
        label: "Test canvas",
        action: () => {
          fired = true;
        },
      });

      store.setActiveContext("canvas");

      // Create a button inside the canvas
      const button = document.createElement("button");
      canvasContainer.appendChild(button);
      button.focus();

      // With button inside canvas focused, SHOULD fire
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      expect(fired).toBe(true);
    });

    test("selection context falls back to global when focus is outside canvas", () => {
      let globalFired = false;

      store.register("global", {
        bind: "z",
        label: "Test global",
        action: () => {
          globalFired = true;
        },
      });

      store.setActiveContext("selection");

      // Create a select element outside the canvas
      const select = document.createElement("select");
      document.body.appendChild(select);
      select.focus();

      // Global keybinds should still work
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
      expect(globalFired).toBe(true);

      // Cleanup
      document.body.removeChild(select);
    });
  });
});
