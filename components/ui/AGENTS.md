# UI Primitives

Reusable, domain-free React primitives.

## Invariants

- Build on `@base-ui/react` where an appropriate primitive exists.
- Keep each primitive self-contained with co-located component and CSS files.
- Compose APIs instead of adding boolean-prop combinations.
- Use shared toast and hint managers rather than feature-specific providers.
- Keep GPU-assisted primitives such as the color picker generic and independent of canvas entities or shader configuration.

## Boundaries

- Do not import canvas, engine, renderer, or shader domain types.
- Do not use inline styles.
- Follow the existing folder/export convention for new primitives.
