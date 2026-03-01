import { thumbHashToDataURL } from "thumbhash";

const cache = new Map<string, string>();

/** Decode a compact base64 thumbhash into a data URL. Results are cached. */
export function decodeThumbhash(base64: string): string {
  let url = cache.get(base64);
  if (url) return url;

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  url = thumbHashToDataURL(bytes);
  cache.set(base64, url);
  return url;
}
