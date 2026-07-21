import type { PropsWithChildren } from "react";
import { KeybindContext, keybindStore } from "./keybind-context.ts";

export function KeybindProvider({ children }: PropsWithChildren) {
  return <KeybindContext.Provider value={keybindStore}>{children}</KeybindContext.Provider>;
}
