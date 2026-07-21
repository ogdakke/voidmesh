import { flushSync } from "react-dom";
import { getHintDismissed, setHintDismissed } from "#lib/hint-storage.ts";

export interface HintContent {
  id?: string;
  title: string;
  description?: string;
  action?: { label: string; onPress: () => void };
  onDismiss?: () => void;
}

export interface HintOptions {
  timeout?: number;
  dismissOn?: (dismiss: () => void) => void;
}

interface HintState {
  content: HintContent | null;
  options: HintOptions;
  key: string;
}

class HintManager {
  #state: HintState = { content: null, options: {}, key: "" };
  #listeners = new Set<() => void>();
  #timeoutId: number | null = null;

  show(content: HintContent, options: HintOptions = {}) {
    if (content.id && getHintDismissed(content.id)) return;
    if (this.#timeoutId !== null) clearTimeout(this.#timeoutId);
    if (options.dismissOn) options.dismissOn(() => this.dismiss());
    this.#update({ content, options, key: `hint-${Date.now()}` });
    if (options.timeout && options.timeout > 0) {
      this.#timeoutId = window.setTimeout(() => this.dismiss(), options.timeout);
    }
  }

  dismiss() {
    const { content } = this.#state;
    if (content?.id) setHintDismissed(content.id);
    content?.onDismiss?.();
    if (this.#timeoutId !== null) clearTimeout(this.#timeoutId);
    this.#timeoutId = null;
    this.#update({ content: null, options: {}, key: "" });
  }

  getState = () => this.#state;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #update(state: HintState) {
    const commit = () => {
      this.#state = state;
      this.#listeners.forEach((listener) => listener());
    };
    if ("startViewTransition" in document) document.startViewTransition(() => flushSync(commit));
    else commit();
  }
}

export const hints = new HintManager();
