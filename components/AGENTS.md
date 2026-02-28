# Components

React UI layer. Feature-specific panels, the canvas viewport, and layout shells.

## Key Files

- `infinite-canvas/` — Main canvas viewport. `infinite-canvas.tsx` (~35KB) renders `<canvas>`, wires `GameLoop` + `InfiniteCanvasRenderer`, handles drop events, space+drag panning, keyboard shortcuts. `canvas-context-menu.tsx` (~25KB) is the right-click context menu.
- `desktop-layout.tsx` — Desktop resizable panel layout (lazy-loaded from `app.tsx`).
- `mobile-layout.tsx` — Mobile drawer-based layout (lazy-loaded from `app.tsx`).
- `sidebar-right-controls.tsx` (~21KB) — Decides which knob panel to show based on selection state.
- `sidebar-left.tsx` — Entity list panel.
- `export-knobs.tsx` (~22KB) — Export format/quality/resolution controls.
- `*-knobs.tsx` — Per-shader parameter panels (dithering, ascii, glass, shape, adjustments, post-processing).
- `knobs/` — Shared knob sub-components: `style-knobs.tsx`, `params-knobs.tsx`, `post-process-knobs.tsx`.
- `delete-drop-zone/` — Mobile drag-to-delete drop zone (appears during entity drag).
- `about/` — About dialog with desktop/mobile variants and updates section.
- `settings-drawer/` — Settings panel. `desktop-settings.tsx` for sidebar, `settings-drawer.tsx` for mobile. `share.ts` for URL sharing.
- `palette-preset/` — Color palette presets and user palette management. `palette-presets.ts` defines built-ins.
- `mobile-bottom/` — Mobile bottom bar layout. `bar-items.ts` defines the bottom bar items.
- `mobile-controls.tsx` — Mobile controls container.
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
- Components consume canvas state via `useCanvas()` from context, NOT by importing `canvasStore` directly. Exception: `useViewport()` and `useSelectionSnapshot()` use `useSyncExternalStore` directly for performance.
- Mobile vs desktop: use `useIsMobile()` hook. Desktop uses `react-resizable-panels`; mobile uses bottom drawer.
- Prefer composition. Use `React Composition Patterns` skill.

## Anti-Patterns

- Do not import `canvasStore` directly for state reads. Use `useCanvas()` or performance hooks.
- Do not put business logic in components. Param mutation logic belongs in `hooks/use-canvas-actions.ts` or `context/canvas-context.tsx`.
- Do not add new top-level knob files without wiring into `sidebar-right-controls.tsx`.
- Do not forget to ensure consistency between the 3 surfaces, mobile, desktop sidebar and desktop context menu.
