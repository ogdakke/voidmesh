export interface AnalyticsProvider {
  track(event: string, properties?: Record<string, unknown>): void;
}

export interface AnalyticsEventMap {
  "action_layer.opened": { entity_count: number };
  "action_layer.button_selected": { button: string };
  "entity.deleted": {
    method: "drop_zone" | "keyboard" | "context_menu";
    entity_count: number;
  };
  "shader.changed": { from: string; to: string; entity_count: number };
  "entity.added": { media_type: string };
  "entity.duplicated": { entity_count: number };
}

class Analytics {
  #providers: AnalyticsProvider[] = [];
  #enabled = true;

  addProvider(provider: AnalyticsProvider): void {
    this.#providers.push(provider);
  }

  removeProvider(provider: AnalyticsProvider): void {
    this.#providers = this.#providers.filter((p) => p !== provider);
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  track<K extends keyof AnalyticsEventMap>(event: K, properties: AnalyticsEventMap[K]): void {
    if (!this.#enabled) return;
    for (const provider of this.#providers) {
      provider.track(event, properties as Record<string, unknown>);
    }
  }
}

export const analytics = new Analytics();

// -- Test utilities --

export interface MockAnalyticsProvider extends AnalyticsProvider {
  calls: Array<{ event: string; properties?: Record<string, unknown> }>;
  clear(): void;
}

export function createMockAnalytics(): MockAnalyticsProvider {
  const calls: MockAnalyticsProvider["calls"] = [];
  return {
    calls,
    track(event: string, properties?: Record<string, unknown>) {
      calls.push({ event, properties });
    },
    clear() {
      calls.length = 0;
    },
  };
}

export function provideMockAnalytics(): {
  mock: MockAnalyticsProvider;
  cleanup: () => void;
} {
  const mock = createMockAnalytics();
  analytics.addProvider(mock);
  return {
    mock,
    cleanup: () => analytics.removeProvider(mock),
  };
}
