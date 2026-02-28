# UI Primitives

Reusable, domain-agnostic UI components. No canvas/shader/entity knowledge.

## Contents

`button`, `checkbox`, `collapsible`, `color-palette`, `color-picker`, `drawer`, `dropzone`, `field`, `form`, `hint`, `image`, `infinite-slider`, `menu`, `modal`, `native-select`, `number-field`, `resizable` (file-level), `select`, `slider`, `slider-picker`, `tick-slider`, `time-slider`, `toast`, `video`.

Also: `ui-util.ts` — shared UI utility helpers.

### Notable Implementations

- `color-picker/` — Split into desktop/mobile variants (`color-picker.desktop.tsx`, `color-picker.mobile.tsx`) with shared context (`color-picker-context.tsx`) and hook (`use-color-picker.ts`). `swatch.tsx` is the clickable color swatch trigger.
- `field/` — Labeled form field wrapper with CSS. Used for settings and knob panels.
- `image.tsx` — Responsive `<picture>` component consuming `?img` Vite plugin output (srcset, thumbhash blur-up).
- `video.tsx` — Lazy-loading video component with intersection observer.

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
