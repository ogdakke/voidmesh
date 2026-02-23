import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  publicDir: resolve(__dirname, "public"),
  appType: "spa",
  plugins: [
    react({
      babel: {
        plugins: ["babel-plugin-react-compiler"],
      },
    }),
  ],

  build: {
    emptyOutDir: true,
    sourcemap: true,
  },

  // @ts-expect-error idk
  oxc: {
    pure: process.env.NODE_ENV === "production" ? ["console.log", "console.debug"] : [],
  },

  optimizeDeps: {
    include: ["mp4box"],
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@ffmpeg/core"],
  },
});
