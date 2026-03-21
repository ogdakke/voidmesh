// Dev-mode JSX runtime — re-exports from jsx-runtime.
// In development, TypeScript/Vite imports from jsx-dev-runtime instead of jsx-runtime.

export { jsx as jsxDEV, Fragment } from "./jsx-runtime.ts";
export type { JSX } from "./jsx-runtime.ts";
