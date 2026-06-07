import { ErrorBoundary } from "#ui/error-boundary.tsx";
import { InfiniteCanvas } from "./infinite-canvas";
import { Button } from "#ui/button/button.tsx";

function CanvasErrorFallback({ error }: { error: Error }) {
  return (
    <div className="infinite-canvas-error">
      <p>Something blew up.</p>
      <p className="error-message">{error.message}</p>
      <Button
        type="button"
        className="infinite-canvas-error__reload"
        onClick={() => window.location.reload()}
      >
        Reload
      </Button>
    </div>
  );
}

export function Canvas() {
  return (
    <div className="canvas">
      <ErrorBoundary fallback={({ error }) => <CanvasErrorFallback error={error} />}>
        <InfiniteCanvas />
      </ErrorBoundary>
    </div>
  );
}
