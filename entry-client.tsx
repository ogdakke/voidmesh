import React from "react";
import ReactDOM from "react-dom/client";
import { Boot } from "./boot.tsx";
import { logger } from "#lib/client.logger.ts";
import "./styles/app.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

const rootOptions = {
  onCaughtError(error: unknown, errorInfo: React.ErrorInfo) {
    logger.error("[ErrorBoundary]", error, errorInfo.componentStack);
  },
  onUncaughtError(error: unknown, errorInfo: React.ErrorInfo) {
    logger.error("[Uncaught]", error, errorInfo.componentStack);
  },
};

const app = (
  <React.StrictMode>
    <Boot />
  </React.StrictMode>
);

if (root.dataset.prerendered === "true") {
  ReactDOM.hydrateRoot(root, app, rootOptions);
} else {
  ReactDOM.createRoot(root, rootOptions).render(app);
}
