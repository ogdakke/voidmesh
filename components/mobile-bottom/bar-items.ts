export const items = [
  "style",
  "colors",
  "parameters",
  "adjustments and post-processing",
  "export",
] as const;

export type BarItem = (typeof items)[number];
