import { IconoirProvider } from "iconoir-react";
import { NuqsAdapter } from "nuqs/adapters/react";
import React, { lazy, Suspense, useState } from "react";
import ReactDOM from "react-dom/client";
import { logger } from "#lib/client.logger.ts";
import { ToastProvider } from "#ui/toast/toast.tsx";
import { CanvasProvider } from "./context/canvas-context.tsx";
import { ExportQueueProvider } from "./context/export-queue-context.tsx";
import { KeybindProvider } from "./context/keybind-provider.tsx";
import { LayoutProvider } from "./context/layout-context.tsx";
import { VideoExportProvider } from "./context/video-export-context.tsx";
import { useIsMobile, useIsTouch } from "./hooks/use-is-mobile.ts";
import useMediaQuery from "./hooks/use-media-query";
import "./styles/app.css";

const DesktopLayout = lazy(() => import("./components/desktop-layout.tsx"));
const MobileLayout = lazy(() => import("./components/mobile-layout.tsx"));

export default function App() {
  const isTouch = useIsTouch();
  const isMobile = useIsMobile();
  const isPrettyLargeScreen = useMediaQuery("(min-width: 830px)");
  const isSmallScreen = useMediaQuery("(max-width: 1100px)");

  const isMostProbablyTablet = isTouch && isPrettyLargeScreen;

  // small(ish) screen + not touch = desktop layout
  // probably tablet or mobile = mobile layout
  const showMobileLayout = (isSmallScreen && !isTouch) || isMostProbablyTablet || isMobile;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = () => setIsFullscreen((prev) => !prev);
  const setFullscreen = (value: boolean) => setIsFullscreen(value);

  return (
    <IconoirProvider
      iconProps={{ color: "currentColor", strokeWidth: 1.5, width: "1em", height: "1em" }}
    >
      <ToastProvider>
        <CanvasProvider>
          <VideoExportProvider>
            <ExportQueueProvider>
              <LayoutProvider value={{ isFullscreen, toggleFullscreen, setFullscreen }}>
                <Suspense fallback={null}>
                  {showMobileLayout ? <MobileLayout /> : <DesktopLayout />}
                </Suspense>
              </LayoutProvider>
            </ExportQueueProvider>
          </VideoExportProvider>
        </CanvasProvider>
      </ToastProvider>
    </IconoirProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!, {
  onCaughtError(error, errorInfo) {
    logger.error("[ErrorBoundary]", error, errorInfo.componentStack);
  },
  onUncaughtError(error, errorInfo) {
    logger.error("[Uncaught]", error, errorInfo.componentStack);
  },
}).render(
  <React.StrictMode>
    <NuqsAdapter>
      <KeybindProvider>
        <App />
      </KeybindProvider>
    </NuqsAdapter>
  </React.StrictMode>,
);
