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

export function isSafari() {
  const ua = navigator.userAgent;
  return ua.includes("Safari") && !ua.includes("Chrome") && !ua.includes("Chromium");
}
