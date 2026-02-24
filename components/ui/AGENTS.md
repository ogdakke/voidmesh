# UI Primitives

Reusable, domain-agnostic UI components. No canvas/shader/entity knowledge.

## Contents

`button`, `checkbox`, `collapsible`, `color-palette`, `color-picker`, `drawer`, `dropzone`, `form`, `hint`, `infinite-slider`, `menu`, `modal`, `native-select`, `number-field`, `resizable` (file-level), `select`, `slider`, `slider-picker`, `tick-slider`, `time-slider`, `toast`.

Also: `ui-util.ts` — shared UI utility helpers.

## Patterns

- Built on `@base-ui/react` (unstyled primitives). Use base-ui wrappers instead of raw HTML `<select>`, `<input>` etc.
- Each primitive is self-contained: own folder, own CSS, own exports.
- Toast: `toast-manager.ts` singleton + `toast.tsx` provider. Push via `toastManager.show()`.
- Hint: `hint-manager.ts` singleton + `hint.tsx` provider. Similar pattern to toast.
- Prefer composition. Use `React Composition Patterns` skill.

## Anti-Patterns

- Do not import canvas types, engine state, or shader concepts here.
- Do not use inline styles. Use CSS files.
- Do not add new primitives without following the folder convention (folder name = component name, with `.tsx` + `.css`).
