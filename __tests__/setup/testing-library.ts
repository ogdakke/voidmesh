/**
 * React Testing Library setup for Vitest
 * Extends Vitest's expect with jest-dom matchers and handles cleanup
 */
import { afterEach } from "vite-plus/test";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Cleanup after each test to prevent memory leaks and state pollution
afterEach(() => {
  cleanup();
});
