import type { PostHog } from "posthog-js";
import type { AnalyticsProvider } from "#lib/analytics.ts";

export class PostHogAnalyticsProvider implements AnalyticsProvider {
  #client: PostHog;

  constructor(client: PostHog) {
    this.#client = client;
  }

  track(event: string, properties?: Record<string, unknown>): void {
    this.#client.capture(event, properties);
  }
}
