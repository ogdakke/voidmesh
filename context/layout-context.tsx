import type { PropsWithChildren } from "react";
import { LayoutContext, type LayoutContextValue } from "./use-layout.ts";

export function LayoutProvider({
  children,
  value,
}: PropsWithChildren<{ value: LayoutContextValue }>) {
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}
