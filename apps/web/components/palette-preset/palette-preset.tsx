import type { RGBA } from "#types/canvas.ts";

import "./palette-preset.css";
import "../ui/form/form.css";

/**
 * Convert RGBA array to CSS color string
 */
function rgbaToCss(rgba: RGBA): string {
  return `rgba(${Math.round(rgba[0] * 255)}, ${Math.round(rgba[1] * 255)}, ${Math.round(rgba[2] * 255)}, ${rgba[3]})`;
}

/**
 * Renders color swatches inline (compact version for select items)
 */
export function PaletteSwatches({ colors }: { colors: RGBA[] }) {
  return (
    <div className="palette-swatches--inline">
      {colors.map((color, i) => (
        <div key={i} className="palette-swatch--inline" style={{ background: rgbaToCss(color) }} />
      ))}
    </div>
  );
}
