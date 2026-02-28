export function Swatch({ color, className }: { color: string; className?: string }) {
  return (
    <span className={`color-picker__swatch ${className ?? ""}`} style={{ background: color }} />
  );
}
