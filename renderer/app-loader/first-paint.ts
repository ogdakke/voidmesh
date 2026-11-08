/**
 * Inlined into index.html as a classic script right after the wordmark SVG
 * (plugins/vite-plugin-app-loader.ts). It runs while the document parses, so the
 * very first paint already shows the wordmark where the PWA splash image has it and
 * where the loader canvas will draw it. app-loader.ts keeps it placed on resize.
 */

import { placeLoaderWordmark } from "./wordmark.ts";

const el = document.getElementById("app-loader");
if (el) placeLoaderWordmark(el);
