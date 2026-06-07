# Components

React UI layer. Feature-specific panels, the canvas viewport, and layout shells.

## Key Files

- `infinite-canvas/` — Main canvas viewport. `infinite-canvas.tsx` (~35KB) renders `<canvas>`, wires `GameLoop` + `InfiniteCanvasRenderer`, handles drop events, space+drag panning, keyboard shortcuts. `canvas-context-menu.tsx` (~25KB) is the right-click context menu.
- `desktop-layout.tsx` — Desktop resizable panel layout (lazy-loaded from `app.tsx`).
- `mobile-layout.tsx` — Mobile drawer-based layout (lazy-loaded from `app.tsx`).
- `sidebar-right-controls.tsx` (~21KB) — Decides which knob panel to show based on selection state.
- `sidebar-left.tsx` — Entity list panel.
- `export-knobs/` Export format/quality/resolution controls, separated into `export-knobs.desktop.tsx`, `export-knobs.mobile.tsx`, `export-knobs.shared.tsx` (shared components) and `export-knobs.lib.ts` (non-tsx shared code).
- `*-knobs.tsx` — Per-shader parameter panels.
- `knobs/` — Shared knob sub-components: `style-knobs.tsx`, `params-knobs.tsx`, `post-process-knobs.tsx`.
- `action-layer/` — Mobile radial context menu with spring physics and copy/paste drawer.
- `delete-drop-zone/` — Mobile drag-to-delete drop zone (appears during entity drag).
- `about/` — About dialog with desktop/mobile variants and updates section.
- `settings-drawer/` — Settings panel. `desktop-settings.tsx` for sidebar, `settings-drawer.tsx` for mobile. `share.ts` for URL sharing.
- `palette-preset/` — Color palette presets and user palette management. `palette-presets.ts` defines built-ins.
- `mobile-bottom/` — Mobile bottom bar layout. `bar-items.ts` defines the bottom bar items.
- `mobile-controls.tsx` — Mobile controls container.
- `upscale-queue-panel.tsx` — Shows queued upscale jobs with progress bars, cancel buttons. Uses `Collapsible` UI primitive. Wired into `sidebar-right-controls.tsx`.
- `keyboard-shortcuts/` — Keyboard shortcut display.
- `icons/` — Custom SVG icon components.
- `ui/` — Reusable primitives (see child `ui/AGENTS.md`).

## Knob Pattern

All knob components follow the same structure:

```typescript
const param = useParamValue("path.to.param", defaultValue);
// Read: param.value, param.isSupported, param.isMixed
// Write: updateSelectedEntityParams({ path: { to: { param: newValue } } })
```

## Patterns

- CSS co-located with components (`.css` alongside `.tsx`).
- Components consume canvas state via narrow hooks from `context/use-canvas.ts`, NOT by importing `canvasStore` directly. Use selector hooks for reads, `useCanvasCommands()` for writes, and `useCanvasRendererService()` for renderer/color-space access.
- Mobile vs desktop: use `useIsMobile()` hook. Desktop uses `react-resizable-panels`; mobile uses bottom drawer. Separate mobile and desktop to `.mobile.tsx` and `.desktop.tsx` respectively, with a `.shared.tsx` for shared components, `.lib.ts` for shared non-tsx code (to preserve HMR)
- Prefer composition. Use `React Composition Patterns` skill.

## React Compiler Constraints

This project uses `@rolldown/plugin-react` and react compiler with strict oxlint rules (`react-hooks-js/*`). Three rules cause the most mistakes:

### 1. No ref access during render (`react-hooks-js/refs`)

Reading or writing `.current` in the component body (outside effects/callbacks) breaks React Compiler's ability to reason about render purity.

```tsx
// ❌ WRONG — ref read during render
const prevActiveRef = useRef(false);
if (!active && prevActiveRef.current) {
  // lint error
  setHoveredIndex(null);
}
prevActiveRef.current = active; // lint error
```

### 2. No setState in useEffect body (`react-hooks-js/set-state-in-effect`)

Calling setState synchronously inside an effect body causes cascading renders.

```tsx
// ❌ WRONG — setState in effect body
useEffect(() => {
  if (active) {
    setHoveredIndex(null); // lint error
  }
}, [active]);
```

### 3. No setState during render (`react-hooks-js/set-state-in-render`)

The "adjust state during render" pattern from React docs is not allowed under React Compiler.

### Alternatives

**Derive at render time** — gate stale state with a condition instead of resetting it:

```tsx
// ✅ Derived value — no state reset needed
const effectiveHoveredIndex = active ? hoveredIndex : null;
```

**Reset in effect cleanup** — cleanup runs when deps change, before the next effect:

```tsx
// ✅ setState in cleanup (not the effect body) is allowed
useEffect(() => {
  if (!active) return;
  // ... setup ...
  return () => {
    removeEventListeners();
    setHoveredIndex(null); // runs when `active` becomes false
  };
}, [active]);
```

**Lift state to a provider** — when state needs to be shared or reset across component boundaries, move it into a provider. See `vercel-composition-patterns` skill.

> **Note:** Existing `oxlint-disable` suppressions for these rules in the codebase are tech debt, not precedent. Do not add new suppressions — find an alternative that satisfies the lint rules.

## Anti-Patterns

- Do not import `canvasStore` directly for state reads. Use selector hooks or existing performance hooks.
- Do not put business logic in components. Param mutation logic belongs in commands/context, not JSX.
- Do not add new top-level knob files without wiring into `sidebar-right-controls.tsx`.
- Do not forget to ensure consistency between the 3 surfaces, mobile, desktop sidebar and desktop context menu.
- Do not use `useCallback` or `useMemo` — React Compiler handles memoization automatically.
