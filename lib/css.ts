type CssScope = HTMLElement | SVGElement | null | undefined;

/**
 * Resolve a CSS color expression to a computed color string.
 * Pass a scope element when the expression depends on component-local custom properties.
 */
export function resolveCssColor(value: string, scope?: CssScope): string | null {
  if (typeof document === "undefined") return null;

  const parent = scope ?? document.documentElement;
  const probe = document.createElement("span");
  probe.style.color = value;
  parent.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || null;
}

export function resolveCssVarColor(varName: string, scope?: CssScope): string | null {
  return resolveCssColor(`var(${varName})`, scope);
}

export function getCssVarValue(varName: string, scope?: CssScope): string | null {
  if (typeof document === "undefined") return null;
  const target = scope ?? document.documentElement;
  const value = getComputedStyle(target).getPropertyValue(varName).trim();
  return value || null;
}

/** Read a CSS custom property that resolves to px as a number. Returns 0 if unset/unsupported. */
export function getCssVarPx(varName: string, scope?: CssScope): number {
  const value = getCssVarValue(varName, scope);
  return value ? parseFloat(value) || 0 : 0;
}
