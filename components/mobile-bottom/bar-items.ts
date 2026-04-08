export const items = [
  "style",
  "colors",
  "parameters",
  "adjustments and post-processing",
  "export",
] as const;

export type BarItem = (typeof items)[number];

export const debugBarItem = "canvas debug" as const;
export type DebugBarItem = typeof debugBarItem;
