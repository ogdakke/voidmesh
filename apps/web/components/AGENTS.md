# Components

Feature UI, layouts, canvas chrome, controls, and shader knob panels.

## Structure

- `infinite-canvas/` — Canvas shell, overlays, context menu, and media controls.
- `*-knobs.tsx`, `knobs/`, `sidebar-right-controls.tsx` — Effect and selection controls.
- `desktop-layout.tsx`, `mobile-layout.tsx`, `mobile-*` — Platform layouts.
- `action-layer/`, `delete-drop-zone/` — Mobile gesture UI.
- `ui/` — Domain-free primitives; see its child `AGENTS.md`.

## Invariants

- Read canvas state through focused selectors; mutate through commands and application services.
- Keep business logic out of JSX.
- Use `useParamValue()` for shader controls.
- Co-locate component CSS. Use `.mobile.tsx`, `.desktop.tsx`, `.shared.tsx`, and `.lib.ts` when platform separation is substantial.
- Keep desktop sidebar, desktop context menu, and mobile controls behaviorally consistent where they expose the same action.
- Canvas chrome invariant during pan must not subscribe to full viewport state.
- Playing-media progress owns one drawing loop; notifications must not create a second RAF loop.
- Prefer composition. Use the `vercel-composition-patterns` skill for reusable component APIs.

## React Compiler

- Do not read or write `ref.current` during render.
- Do not call state setters during render or synchronously in an effect body.
- Derive values, reset in event handlers/cleanup, or lift state instead of adding lint suppressions.
- Do not add `useMemo` or `useCallback`; React Compiler owns memoization.

## Boundaries

- Do not import `canvasStore` or other engine singletons.
- Do not put domain-specific behavior in `components/ui/`.
- Wire new top-level knob surfaces through `sidebar-right-controls.tsx`.
