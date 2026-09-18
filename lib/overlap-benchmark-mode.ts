const MODE_PARAM = "benchmark";
const MODE_VALUE = "overlap";
const MODE_CHANGE_EVENT = "voidmesh:overlap-benchmark-mode-change";

export function isOverlapBenchmarkModeOpen(): boolean {
  return new URLSearchParams(window.location.search).get(MODE_PARAM) === MODE_VALUE;
}

export function subscribeOverlapBenchmarkMode(listener: () => void): () => void {
  window.addEventListener(MODE_CHANGE_EVENT, listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener(MODE_CHANGE_EVENT, listener);
    window.removeEventListener("popstate", listener);
  };
}

export function openOverlapBenchmarkMode(): void {
  const url = new URL(window.location.href);
  url.searchParams.set(MODE_PARAM, MODE_VALUE);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(MODE_CHANGE_EVENT));
}

export function closeOverlapBenchmarkMode(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(MODE_PARAM);
  url.searchParams.delete("benchLabel");
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(MODE_CHANGE_EVENT));
}
