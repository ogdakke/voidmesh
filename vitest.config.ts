import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "virtual:pwa-register/react": resolve(
        __dirname,
        "./__tests__/mocks/virtual-pwa-register-react.ts",
      ),
    },
  },
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset()],
    }),
  ],
  test: {
    environment: "happy-dom",
    setupFiles: ["./__tests__/setup/happydom.ts", "./__tests__/setup/testing-library.ts"],
    include: ["**/*.spec.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.git/**", ".claude/**"],
  },
});
