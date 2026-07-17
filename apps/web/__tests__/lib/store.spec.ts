import { describe, test, expect, vi } from "vitest";
import { Store, shallowEqual } from "#lib/store.ts";

// Concrete implementation for testing
interface TestState {
  count: number;
  name: string;
  version: number;
}

class TestStore extends Store<TestState> {
  readonly getSnapshot: () => TestState;

  constructor() {
    super({ count: 0, name: "test", version: 0 });
    this.getSnapshot = this.createSnapshot("version", (s) => ({ ...s }));
  }

  increment() {
    this.state.count++;
    this.state.version++;
    this.notify();
  }

  setName(name: string) {
    this.state.name = name;
    this.state.version++;
    this.notify();
  }

  // Expose for testing
  getCount() {
    return this.state.count;
  }

  // Test computed values
  getDoubleCount() {
    return this.getComputed("doubleCount", "version", () => ({
      double: this.state.count * 2,
      label: `Count: ${this.state.count}`,
    }));
  }
}

describe("Store", () => {
  describe("subscribe", () => {
    test("adds listener that gets called on notify", () => {
      const store = new TestStore();
      const listener = vi.fn<() => void>();

      store.subscribe(listener);
      store.increment();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    test("unsubscribe removes listener", () => {
      const store = new TestStore();
      const listener = vi.fn<() => void>();

      const unsubscribe = store.subscribe(listener);
      unsubscribe();
      store.increment();

      expect(listener).not.toHaveBeenCalled();
    });

    test("multiple listeners all get called", () => {
      const store = new TestStore();
      const listener1 = vi.fn<() => void>();
      const listener2 = vi.fn<() => void>();

      store.subscribe(listener1);
      store.subscribe(listener2);
      store.increment();

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe("createSnapshot", () => {
    test("returns current state snapshot", () => {
      const store = new TestStore();
      const snapshot = store.getSnapshot();

      expect(snapshot.count).toBe(0);
      expect(snapshot.name).toBe("test");
    });

    test("returns same reference when version unchanged", () => {
      const store = new TestStore();
      const snapshot1 = store.getSnapshot();
      const snapshot2 = store.getSnapshot();

      expect(snapshot1).toBe(snapshot2); // Same reference
    });

    test("returns new reference when version changes", () => {
      const store = new TestStore();
      const snapshot1 = store.getSnapshot();
      store.increment();
      const snapshot2 = store.getSnapshot();

      expect(snapshot1).not.toBe(snapshot2); // Different reference
      expect(snapshot2.count).toBe(1);
    });
  });

  describe("getComputed", () => {
    test("returns computed value", () => {
      const store = new TestStore();
      store.increment();
      store.increment();

      const result = store.getDoubleCount();
      expect(result.double).toBe(4);
      expect(result.label).toBe("Count: 2");
    });

    test("caches result - same reference when version unchanged", () => {
      const store = new TestStore();
      const result1 = store.getDoubleCount();
      const result2 = store.getDoubleCount();

      expect(result1).toBe(result2); // Same reference (cached)
    });

    test("recomputes when version changes", () => {
      const store = new TestStore();
      const result1 = store.getDoubleCount();
      store.increment();
      const result2 = store.getDoubleCount();

      expect(result1).not.toBe(result2);
      expect(result2.double).toBe(2);
    });

    test("structural sharing - reuses reference when values equal", () => {
      const store = new TestStore();

      // Get initial computed value
      const result1 = store.getDoubleCount();

      // Change name (bumps version) but count stays same
      store.setName("different");

      // Should reuse old object since values are shallowEqual
      const result2 = store.getDoubleCount();

      expect(result1).toBe(result2); // Same reference due to structural sharing
    });
  });
});

describe("shallowEqual", () => {
  test("returns true for identical primitives", () => {
    expect(shallowEqual(1, 1)).toBe(true);
    expect(shallowEqual("a", "a")).toBe(true);
    expect(shallowEqual(true, true)).toBe(true);
    expect(shallowEqual(null, null)).toBe(true);
    expect(shallowEqual(undefined, undefined)).toBe(true);
  });

  test("returns false for different primitives", () => {
    expect(shallowEqual(1, 2)).toBe(false);
    expect(shallowEqual("a", "b")).toBe(false);
    expect(shallowEqual(true, false)).toBe(false);
  });

  test("returns true for objects with same properties", () => {
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  });

  test("returns false for objects with different properties", () => {
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  test("returns false for nested object differences (shallow only)", () => {
    const nested1 = { a: { b: 1 } };
    const nested2 = { a: { b: 1 } };
    // Different nested object references, so shallow compare returns false
    expect(shallowEqual(nested1, nested2)).toBe(false);
  });

  test("returns true for same nested object reference", () => {
    const inner = { b: 1 };
    expect(shallowEqual({ a: inner }, { a: inner })).toBe(true);
  });

  test("handles null and undefined edge cases", () => {
    expect(shallowEqual(null, {})).toBe(false);
    expect(shallowEqual({}, null)).toBe(false);
    expect(shallowEqual(null, undefined)).toBe(false);
  });
});
