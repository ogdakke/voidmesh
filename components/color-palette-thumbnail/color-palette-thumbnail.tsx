import type { ColorPalette } from "#types/canvas.ts";
import "./color-palette-thumbnail.css";

interface ColorPaletteThumbnailProps {
  palette: ColorPalette;
  className?: string;
}

const MAX_COLUMNS = 4;

/**
 * Renders a uniform grid of colors from a palette, fitting into whatever container size.
 * Uses CSS Grid. For ≤4 colors, distributes evenly. For >4 colors, uses 4 columns
 * with the last swatch spanning to fill remaining space.
 */
export function ColorPaletteThumbnail({ palette, className }: ColorPaletteThumbnailProps) {
  const colors = palette.colors;
  const count = colors.length;

  // For small palettes, use equal columns. For larger ones, use 4 columns.
  const gridColumns = count <= MAX_COLUMNS ? count : MAX_COLUMNS;

  // Calculate how many columns the last swatch should span (only for >4 colors)
  const itemsInLastRow = count % MAX_COLUMNS || MAX_COLUMNS;
  const lastItemSpan = count > MAX_COLUMNS ? MAX_COLUMNS - itemsInLastRow + 1 : 1;

  return (
    <div
      className={className ? `color-palette-thumbnail ${className}` : "color-palette-thumbnail"}
      style={{ gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }}
    >
      {colors.map((rgba, i) => {
        const isLast = i === count - 1;
        return (
          <div
            key={i}
            className="color-palette-thumbnail__swatch"
            style={{
              backgroundColor: `rgba(${Math.round(rgba[0] * 255)}, ${Math.round(rgba[1] * 255)}, ${Math.round(rgba[2] * 255)}, ${rgba[3]})`,
              ...(isLast && lastItemSpan > 1 ? { gridColumn: `span ${lastItemSpan}` } : {}),
            }}
          />
        );
      })}
    </div>
  );
}
