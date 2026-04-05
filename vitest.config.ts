import { defineConfig } from "vitest/config";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

export default defineConfig({
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
    exclude: ["**/node_modules/**", "**/.git/**", "opensrc/**"],
  },
});
