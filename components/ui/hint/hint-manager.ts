import { flushSync } from "react-dom";
import { useSyncExternalStore } from "react";
import { getHintDismissed, setHintDismissed } from "#lib/hint-storage.ts";

export interface HintContent {
  id?: string;
  title: string;
  description?: string;
  action?: {
    label: string;
    onPress: () => void;
  };
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
  private state: HintState = {
    content: null,
    options: {},
    key: "",
  };
  private listeners = new Set<() => void>();
  private timeoutId: number | null = null;

  show(content: HintContent, options: HintOptions = {}) {
    if (content.id && getHintDismissed(content.id)) {
      return;
    }

    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    const dismissThis = () => {
      this.dismiss();
    };

    if (options.dismissOn) {
      options.dismissOn(dismissThis);
    }

    if ("startViewTransition" in document) {
      document.startViewTransition(() => {
        flushSync(() => {
          this.state = {
            content,
            options,
            key: `hint-${Date.now()}`,
          };
          this.notifyListeners();
        });
      });
    } else {
      this.state = {
        content,
        options,
        key: `hint-${Date.now()}`,
      };
      this.notifyListeners();
    }

    if (options.timeout && options.timeout > 0) {
      this.timeoutId = window.setTimeout(() => {
        this.dismiss();
      }, options.timeout);
    }
  }

  dismiss() {
    const { content } = this.state;
    if (content?.id) {
      setHintDismissed(content.id);
    }

    if (content?.onDismiss) {
      content.onDismiss();
    }

    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    if ("startViewTransition" in document) {
      document.startViewTransition(() => {
        flushSync(() => {
          this.state = {
            content: null,
            options: {},
            key: "",
          };
          this.notifyListeners();
        });
      });
    } else {
      this.state = {
        content: null,
        options: {},
        key: "",
      };
      this.notifyListeners();
    }
  }

  getState() {
    return this.state;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener());
  }
}

export const hints = new HintManager();

export function useHint() {
  const state = useSyncExternalStore(
    (callback) => hints.subscribe(callback),
    () => hints.getState(),
    () => hints.getState(),
  );

  return state;
}
