import { useHostedWorkspaceRuntime } from "#context/use-hosted-workspace-runtime.ts";
import { useCanvasSelector, useViewport } from "#context/use-canvas.ts";
import "./hosted-presence-overlay.css";

export function HostedPresenceOverlay() {
  const runtime = useHostedWorkspaceRuntime();
  const viewport = useViewport();
  useCanvasSelector((state) => state.entityVersion);
  const entities = useCanvasSelector((state) => state.entities);
  if (!runtime) return null;
  const scale = viewport.zoom / window.devicePixelRatio;

  return (
    <div className="hosted-presence" aria-hidden="true">
      {runtime.peers.flatMap((peer) =>
        (peer.selectedEntityIds ?? []).map((entityId) => {
          const entity = entities.get(entityId);
          if (!entity) return null;
          return (
            <div
              className="hosted-presence__selection"
              key={`${peer.connectionId}:${entityId}`}
              style={{
                borderColor: peer.color,
                height: entity.size.height * scale,
                left: (entity.position.x - viewport.offset.x) * scale,
                top: (entity.position.y - viewport.offset.y) * scale,
                transform: `rotate(${entity.rotation}deg)`,
                width: entity.size.width * scale,
              }}
            />
          );
        }),
      )}
      {runtime.peers.map((peer) =>
        peer.cursor ? (
          <div
            className="hosted-presence__cursor"
            key={peer.connectionId}
            style={{
              color: peer.color,
              left: (peer.cursor.x - viewport.offset.x) * scale,
              top: (peer.cursor.y - viewport.offset.y) * scale,
            }}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="M3 2 20 13l-7 1.5L9.5 21z"
                fill="currentColor"
                stroke="white"
                strokeWidth="1.5"
              />
            </svg>
            <span style={{ background: peer.color }}>{peer.name}</span>
          </div>
        ) : null,
      )}
    </div>
  );
}
