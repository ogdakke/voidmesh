export const items = ["style", "colors", "parameters", "adjustments and post-processing"] as const;

export type BarItem = (typeof items)[number];

export const debugBarItem = "canvas debug" as const;
export type DebugBarItem = typeof debugBarItem;

export const overlapBarItem = "overlap lab" as const;
export type OverlapBarItem = typeof overlapBarItem;
