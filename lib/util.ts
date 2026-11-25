export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isMacOS() {
  return navigator.userAgent.includes("Mac");
}

export function isWindows() {
  return navigator.userAgent.includes("Windows");
}

export function isLinux() {
  return navigator.userAgent.includes("Linux");
}

// source https://evilmartians.com/chronicles/how-to-detect-safari-and-ios-versions-with-ease

//  Desktop Safari and all mobile WebKit browsers on iOS and webview iOS
export function isWebkit() {
  return "GestureEvent" in window;
}

//  all mobile webkit browsers and webview iOS
export function isMobileWebKit() {
  return "ongesturechange" in window;
}

//  Desktop Safari
export function isDesktopWebKit() {
  return (
    typeof window !== "undefined" &&
    "safari" in window &&
    "pushNotification" in (window as any).safari
  );
}

/** Drops keys whose value is `undefined`, so the result satisfies exact optional property types. */
export function omitUndefined<T extends object>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
