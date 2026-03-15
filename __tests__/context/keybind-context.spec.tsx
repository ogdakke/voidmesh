/**
 * Tests for keybind-context
 */
import { describe, test, expect, vi } from "vite-plus/test";
import { screen, fireEvent } from "@testing-library/react";
import React, { useEffect } from "react";
import { useKeybind, useKeybinds, type KeybindStore } from "#context/keybind-context.ts";
import { renderMinimal } from "../helpers/render-with-providers.tsx";

describe("KeybindProvider", () => {
  test("provides keybind store to children", () => {
    let storeValue: KeybindStore | null = null;

    function TestComponent() {
      storeValue = useKeybinds();
      return <div data-testid="test">Rendered</div>;
    }

    renderMinimal(<TestComponent />);

    expect(screen.getByTestId("test")).toBeInTheDocument();
    expect(storeValue).not.toBeNull();
    expect(typeof storeValue!.register).toBe("function");
    expect(typeof storeValue!.entries).toBe("function");
  });
});

describe("useKeybind", () => {
  test("registers a keybind that fires on keypress", async () => {
    const actionMock = vi.fn(() => {});

    function TestComponent() {
      useKeybind("global", {
        label: "Test Action",
        bind: "t",
        action: actionMock,
      });
      return <div data-testid="test">Test</div>;
    }

    renderMinimal(<TestComponent />);

    expect(screen.getByTestId("test")).toBeInTheDocument();

    // Press 't' key
    fireEvent.keyDown(window, { key: "t" });

    expect(actionMock).toHaveBeenCalledTimes(1);
  });

  test("supports modifier keys (meta+s)", async () => {
    const actionMock = vi.fn((e: KeyboardEvent) => {
      e.preventDefault();
    });

    function TestComponent() {
      useKeybind("global", {
        label: "Save",
        bind: "Meta+s",
        action: actionMock,
      });
      return <div data-testid="test">Test</div>;
    }

    renderMinimal(<TestComponent />);

    // Press Cmd+S (Meta+s)
    fireEvent.keyDown(window, { key: "s", metaKey: true });

    expect(actionMock).toHaveBeenCalledTimes(1);
  });

  test("does not fire when modifier requirements are not met", async () => {
    const actionMock = vi.fn(() => {});

    function TestComponent() {
      useKeybind("global", {
        label: "Save",
        bind: "Meta+s",
        action: actionMock,
      });
      return <div data-testid="test">Test</div>;
    }

    renderMinimal(<TestComponent />);

    // Press 's' without Meta
    fireEvent.keyDown(window, { key: "s" });

    expect(actionMock).not.toHaveBeenCalled();
  });

  test("cleans up keybind on unmount", async () => {
    const actionMock = vi.fn(() => {});

    function TestComponent({ show }: { show: boolean }) {
      return show ? <KeybindComponent /> : null;
    }

    function KeybindComponent() {
      useKeybind("global", {
        label: "Test",
        bind: "x",
        action: actionMock,
      });
      return <div>Keybind Active</div>;
    }

    const { rerender } = renderMinimal(<TestComponent show={true} />);

    // Keybind should work initially
    fireEvent.keyDown(window, { key: "x" });
    expect(actionMock).toHaveBeenCalledTimes(1);

    // Unmount the component with the keybind
    rerender(<TestComponent show={false} />);

    // Reset mock call count
    actionMock.mockClear();

    // Keybind should no longer fire
    fireEvent.keyDown(window, { key: "x" });
    expect(actionMock).not.toHaveBeenCalled();
  });

  test("updates action when callback changes", async () => {
    let callCount = 0;

    function TestComponent({ value }: { value: number }) {
      useKeybind("global", {
        label: "Test",
        bind: "z",
        action: () => {
          callCount += value;
        },
      });
      return <div>Value: {value}</div>;
    }

    const { rerender } = renderMinimal(<TestComponent value={1} />);

    // Press 'z' - should add 1
    fireEvent.keyDown(window, { key: "z" });
    expect(callCount).toBe(1);

    // Update the value prop
    rerender(<TestComponent value={10} />);

    // Press 'z' again - should now add 10
    fireEvent.keyDown(window, { key: "z" });
    expect(callCount).toBe(11); // 1 + 10
  });
});

describe("KeybindStore", () => {
  test("entries() returns all registered keybinds", () => {
    let entries: ReturnType<ReturnType<typeof useKeybinds>["entries"]> = [];

    function TestComponent() {
      const store = useKeybinds();

      useKeybind("global", {
        label: "Action A",
        bind: "a",
        action: () => {},
      });

      useKeybind("global", {
        label: "Action B",
        bind: "b",
        action: () => {},
      });

      useEffect(() => {
        entries = store.entries();
      });

      return <div>Test</div>;
    }

    renderMinimal(<TestComponent />);

    // Should have at least our two keybinds
    const labels = entries.map((kb) => kb.label);
    expect(labels).toContain("Action A");
    expect(labels).toContain("Action B");
  });

  test("entriesByGroup() groups keybinds correctly", () => {
    let groups: Map<string, any[]> = new Map();

    function TestComponent() {
      const store = useKeybinds();

      useKeybind("global", {
        label: "Global Action",
        group: "global",
        bind: "g",
        action: () => {},
      });

      useKeybind("canvas", {
        label: "Canvas Action",
        group: "canvas",
        bind: "c",
        action: () => {},
      });

      useEffect(() => {
        groups = store.getEntriesByGroup();
      });

      return <div>Test</div>;
    }

    renderMinimal(<TestComponent />);

    // Check groups exist
    expect(groups.has("global")).toBe(true);
    expect(groups.has("canvas")).toBe(true);

    // Check keybinds are in correct groups
    const globalLabels = groups.get("global")?.map((kb) => kb.label) ?? [];
    const canvasLabels = groups.get("canvas")?.map((kb) => kb.label) ?? [];

    expect(globalLabels).toContain("Global Action");
    expect(canvasLabels).toContain("Canvas Action");
  });
});
