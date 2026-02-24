import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import imagePlugin from "./plugins/vite-plugin-image.ts";

export default defineConfig({
  publicDir: resolve(__dirname, "public"),
  appType: "spa",
  plugins: [
    imagePlugin({ widths: [768, 1152], quality: 80 }),
    react({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
  ],

  build: {
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: ["opensrc/"],
    },
  },
  // @ts-expect-error idk
  oxc: {
    pure: process.env.NODE_ENV === "production" ? ["console.log", "console.debug"] : [],
  },

  optimizeDeps: {
    include: ["mediabunny", "gifenc"],
  },
});
