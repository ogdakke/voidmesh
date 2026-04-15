type CssColorScope = HTMLElement | SVGElement | null | undefined;

/**
 * Resolve a CSS color expression to a computed color string.
 * Pass a scope element when the expression depends on component-local custom properties.
 */
export function resolveCssColor(value: string, scope?: CssColorScope): string | null {
  if (typeof document === "undefined") return null;

  const parent = scope ?? document.documentElement;
  const probe = document.createElement("span");
  probe.style.color = value;
  parent.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || null;
}

export function resolveCssVarColor(varName: string, scope?: CssColorScope): string | null {
  return resolveCssColor(`var(${varName})`, scope);
}
