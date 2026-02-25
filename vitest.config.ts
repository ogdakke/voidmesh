import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // @ts-expect-error TODO: vite-rolldown has some issues here
  plugins: [react({ babel: { plugins: ["babel-plugin-react-compiler"] } })],
  test: {
    environment: "happy-dom",
    setupFiles: ["./__tests__/setup/happydom.ts", "./__tests__/setup/testing-library.ts"],
    include: ["**/*.spec.{ts,tsx}"],
  },
});
