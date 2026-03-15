import { resolve } from "path";
import { defineConfig, loadEnv } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import imagePlugin from "./plugins/vite-plugin-image.ts";
import wgslMinifyPlugin from "./plugins/vite-plugin-wgsl-minify.ts";
import babel from "@rolldown/plugin-babel";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    publicDir: resolve(__dirname, "public"),
    appType: "spa",
    server: {
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
    ],

    build: {
      emptyOutDir: true,
      sourcemap: process.env.NODE_ENV !== "production",
      rolldownOptions: {
        external: ["opensrc/", ".vendor/"],
      },
    },
    optimizeDeps: {
      entries: ["index.html"],
      include: ["mediabunny", "gifenc"],
    },
  };
});
