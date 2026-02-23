type Listener = () => void;
type Unsubscribe = () => void;

/**
 * Base store class for React useSyncExternalStore integration.
 * Provides subscription management, snapshot caching, and computed value caching.
 *
 * @example
 * class MyStore extends Store<MyState> {
 *   readonly getSnapshot: () => MyState;
 *
 *   constructor() {
 *     super({ count: 0, version: 0 });
 *     this.getSnapshot = this.createSnapshot("version", (s) => ({ ...s }));
 *   }
 *
 *   increment() {
 *     this.state.count++;
 *     this.state.version++;
 *     this.notify();
 *   }
 * }
 */
export abstract class Store<TState> {
  protected state: TState;
  #listeners = new Set<Listener>();
  #computedCache = new Map<string, { value: unknown; version: number }>();

  /** Stable subscribe function for useSyncExternalStore */
  subscribe = (listener: Listener): Unsubscribe => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  constructor(initialState: TState) {
    this.state = initialState;
  }

  /** Notify all listeners. Call after state mutations. */
  protected notify(): void {
    this.#listeners.forEach((l) => l());
  }

  /**
   * Create a version-cached snapshot getter.
   * Returns a stable function that only creates new snapshot objects when version changes.
   *
   * @param versionKey - State property to use as version (must be a number)
   * @param create - Function to create snapshot from current state
   */
  protected createSnapshot<T>(versionKey: keyof TState, create: (state: TState) => T): () => T {
    let cached: T | null = null;
    let cachedVersion = -1;

    return (): T => {
      const version = this.state[versionKey] as number;
      if (cachedVersion !== version) {
        cached = create(this.state);
        cachedVersion = version;
      }
      return cached!;
    };
  }

  /**
   * Get computed value with version-based caching and structural sharing.
   * Reuses previous object reference if shallowEqual, preventing unnecessary re-renders.
   *
   * @param key - Unique cache key for this computation
   * @param versionKey - State property to use as version (must be a number)
   * @param compute - Function to compute the value
   */
  protected getComputed<T>(key: string, versionKey: keyof TState, compute: () => T): T {
    const version = this.state[versionKey] as number;
    const cached = this.#computedCache.get(key);

    if (cached?.version === version) {
      return cached.value as T;
    }

    const fresh = compute();

    // Structural sharing: keep old reference if values match
    if (cached && shallowEqual(cached.value as T, fresh)) {
      cached.version = version;
      return cached.value as T;
    }

    this.#computedCache.set(key, { value: fresh, version });
    return fresh;
  }

  /** Clear all computed cache entries, or those matching a prefix */
  protected clearComputedCache(prefix?: string): void {
    if (!prefix) {
      this.#computedCache.clear();
      return;
    }
    for (const key of this.#computedCache.keys()) {
      if (key.startsWith(prefix)) {
        this.#computedCache.delete(key);
      }
    }
  }
}

/** Shallow equality for structural sharing */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}
