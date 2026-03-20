# UI Primitives

Reusable, domain-agnostic UI components. No canvas/shader/entity knowledge.

## Contents

~25 domain-agnostic primitives: inputs, selectors, sliders, popovers, modals, drawers, toasts, and overlays.

### Notable Implementations

- `color-picker/` — GPU-accelerated OKLCH picker. WebGPU 2D lightness×chroma area, hue/alpha sliders, format selector, eyedropper. Zero-render scrubbing via imperative DOM.
- `image.tsx` — Responsive `<picture>` component consuming `?img` Vite plugin output.
- `video.tsx` — Lazy-loading video with intersection observer.

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
