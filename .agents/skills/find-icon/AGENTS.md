## How to Search

Icons are PascalCase `.mjs` files in `node_modules/iconoir-react/dist/esm/regular/` (1385 icons)
and `node_modules/iconoir-react/dist/esm/solid/` (290 solid variants).

Run a case-insensitive filename search:

```bash
# Search regular icons (default style)
ls node_modules/iconoir-react/dist/esm/regular/ | sed 's/\.mjs$//' | grep -i "<keyword>"

# Search solid icons
ls node_modules/iconoir-react/dist/esm/solid/ | sed 's/\.mjs$//' | grep -i "<keyword>"
```

If the keyword is too specific and returns no results, try broader synonyms. For example:

- "cog" or "settings" or "gear" for settings icons
- "play" or "media" for playback icons
- "arrow" or "nav" for navigation icons
- "trash" or "bin" or "delete" for delete icons

## Import Convention

This project imports icons directly from `"iconoir-react"`:

```tsx
import { IconName } from "iconoir-react";
// Solid variants use the "Solid" suffix:
import { PlaySolid } from "iconoir-react";
```

## Output

Return the matching icon names as a list, noting which are regular vs solid. Recommend
the best match for the user's intent. If multiple matches exist, briefly describe what
each icon looks like based on its name to help the user choose.
