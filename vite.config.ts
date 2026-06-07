import { resolve } from "path";
import { defineConfig, loadEnv } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import babel from "@rolldown/plugin-babel";
import wgslMinifyPlugin from "./plugins/vite-plugin-wgsl-minify.ts";
import imagePlugin from "./plugins/vite-plugin-image.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    publicDir: resolve(__dirname, "public"),
    appType: "spa",
    server: {
      allowedHosts: true,
      watch: {
        ignored: ["**/opensrc/**", ".vendor/**", ".claude/**"],
      },
      proxy: {
        "/m/": {
          target: env.ASSET_URL,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/m\//, "/media/"),
        },
      },
    },
    preview: {
      proxy: {
        "/m/": {
          target: env.ASSET_URL,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/m\//, "/media/"),
        },
      },
    },
    plugins: [
      !!env.HTTPS && basicSsl(),
      wgslMinifyPlugin(),
      imagePlugin({ widths: [768, 1152] }),
      react(),
      babel({
        presets: [reactCompilerPreset()],
      }),
      VitePWA({
        strategies: "generateSW",
        registerType: "prompt",
        injectRegister: false,
        manifest: false,
        includeManifestIcons: false,
        includeAssets: [
          "manifest.webmanifest",
          "favicon.ico",
          "favicon-16x16.png",
          "favicon-32x32.png",
          "favicon-64x64.png",
          "favicon.png",
          "favicon.webp",
          "apple-touch-icon.png",
          "rect_192.png",
          "rect_512.png",
          "assets/manifest-icon-192.maskable.png",
          "assets/manifest-icon-512.maskable.png",
          "media/ascii-atlas.png",
          "media/ascii-atlas.json",
        ],
        workbox: {
          cleanupOutdatedCaches: true,
          navigateFallback: "index.html",
          skipWaiting: false,
          clientsClaim: false,
          runtimeCaching: [
            {
              urlPattern: ({ request, sameOrigin }) => sameOrigin && request.mode === "navigate",
              handler: "NetworkFirst",
              options: {
                cacheName: "voidmesh-pages",
                networkTimeoutSeconds: 3,
                cacheableResponse: {
                  statuses: [200],
                },
              },
            },
            {
              urlPattern: ({ request, sameOrigin, url }) =>
                sameOrigin &&
                request.method === "GET" &&
                request.destination === "video" &&
                /^\/(?:m|media)\//.test(url.pathname),
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "voidmesh-media-videos",
                cacheableResponse: {
                  statuses: [200],
                },
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 7,
                },
              },
            },
            {
              urlPattern: ({ request, sameOrigin, url }) =>
                sameOrigin &&
                request.method === "GET" &&
                request.destination === "image" &&
                /^\/(?:m|media)\//.test(url.pathname),
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "voidmesh-media-images",
                cacheableResponse: {
                  statuses: [200],
                },
                expiration: {
                  maxEntries: 60,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
              },
            },
            {
              urlPattern: ({ request, sameOrigin, url }) =>
                sameOrigin && request.method === "GET" && /^\/(?:m|media)\//.test(url.pathname),
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "voidmesh-media",
                cacheableResponse: {
                  statuses: [200],
                },
                expiration: {
                  maxEntries: 60,
                  maxAgeSeconds: 60 * 60 * 24 * 7,
                },
              },
            },
            {
              urlPattern: ({ request, sameOrigin }) =>
                sameOrigin && request.method === "GET" && request.destination === "image",
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "voidmesh-images",
                cacheableResponse: {
                  statuses: [200],
                },
                expiration: {
                  maxEntries: 80,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
              },
            },
          ],
        },
      }),
    ],

    build: {
      emptyOutDir: true,
      sourcemap: true,
      target: ["ios26"],
      rolldownOptions: {
        external: [".vendor/"],
      },
    },
    optimizeDeps: {
      entries: ["index.html"],
      include: ["mediabunny", "gifenc"],
    },
  };
});
