import type { WorkspaceAssetSummary, WorkspaceSummary } from "@voidmesh/api-contract";
import { useQueryClient } from "@tanstack/react-query";
import { canEditWorkspace } from "@voidmesh/domain";
import {
  HostedCollaborationProvider,
  createPersistedHostedDocument,
  type CollaborationConnectionStatus,
} from "@voidmesh/collaboration/provider";
import type { PresencePoint, ServerPresenceMessage } from "@voidmesh/collaboration";
import { createContext, use, useEffect, useRef, useState, type PropsWithChildren } from "react";
import { R2HostedAssetRegistry } from "#application/canvas/hosted-asset-registry.ts";
import { createHostedAssetThumbnail } from "#application/canvas/hosted-asset-thumbnail.ts";
import { HostedCanvasProjectionService } from "#application/canvas/hosted-canvas-projection.ts";
import { HostedCanvasSync } from "#application/canvas/hosted-canvas-sync.ts";
import { HostedViewportSync } from "#application/canvas/hosted-viewport-sync.ts";
import { canvasStore } from "#engine";
import { HostedApiClient } from "#lib/hosted-api-client.ts";
import { HostedWorkspaceDocument } from "#lib/hosted-workspace-document.ts";
import { BrowserHostedAssetCache } from "#lib/hosted-asset-cache.ts";
import { logger } from "#lib/client.logger.ts";
import { undo } from "#lib/undo.ts";
import { toastManager } from "#application/notifications.ts";
import { useCanvasRendererService } from "./use-canvas.ts";

interface HostedWorkspaceRuntimeValue {
  api: HostedApiClient;
  connectionStatus: CollaborationConnectionStatus;
  downloadOriginal(entityId: string): Promise<void>;
  getCanvasAssetIds(): ReadonlySet<string>;
  getCanvasVideoPreviews(): Promise<ReadonlyMap<string, Blob>>;
  loadAsset(asset: WorkspaceAssetSummary): Promise<File>;
  peers: readonly ServerPresenceMessage[];
  publishCursor(cursor: PresencePoint | null): void;
  workspace: WorkspaceSummary;
}

const HostedWorkspaceRuntimeContext = createContext<HostedWorkspaceRuntimeValue | null>(null);

export interface HostedWorkspaceRuntimeProps extends PropsWithChildren {
  api: HostedApiClient;
  onRoleChange(role: WorkspaceSummary["role"]): void;
  workspace: WorkspaceSummary;
}

export function HostedWorkspaceRuntime({
  api,
  children,
  onRoleChange,
  workspace,
}: HostedWorkspaceRuntimeProps) {
  const renderer = useCanvasRendererService();
  const queryClient = useQueryClient();
  const activeRendererRef = useRef(renderer.renderer);
  const [connectionStatus, setConnectionStatus] =
    useState<CollaborationConnectionStatus>("offline");
  const [peers, setPeers] = useState<readonly ServerPresenceMessage[]>([]);
  const providerRef = useRef<HostedCollaborationProvider | null>(null);
  const assetsRef = useRef<R2HostedAssetRegistry | null>(null);
  const pendingCursorRef = useRef<PresencePoint | null>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    activeRendererRef.current = renderer.renderer;
  }, [renderer.renderer]);

  useEffect(() => {
    let disposed = false;
    const persisted = createPersistedHostedDocument(workspace.id);
    const document = new HostedWorkspaceDocument({
      document: persisted.document,
      now: () => providerRef.current?.serverNow() ?? Date.now(),
    });
    const releaseUndoDelegate = undo.setDelegate(document.undo);
    const cache = new BrowserHostedAssetCache(workspace.id);
    const assets = new R2HostedAssetRegistry(
      api,
      workspace.id,
      cache,
      reportCacheError,
      () => {
        setTimeout(() => providerRef.current?.resynchronize(), 0);
      },
      () => {
        void queryClient.invalidateQueries({ queryKey: ["workspace-assets", workspace.id] });
        void queryClient.invalidateQueries({ queryKey: ["workspace", workspace.id] });
        void queryClient.invalidateQueries({ queryKey: ["account"] });
      },
    );
    let sync: HostedCanvasSync | null = null;
    const viewportSync = new HostedViewportSync({
      onError: reportError,
      remote: {
        load: () => api.getWorkspaceViewState(workspace.id),
        save: (state, keepalive) => api.updateWorkspaceViewState(workspace.id, state, keepalive),
      },
      store: canvasStore,
    });
    const flushViewport = () => viewportSync.flush(true);
    window.addEventListener("pagehide", flushViewport);
    const provider = new HostedCollaborationProvider({
      beforeSync: () => assets.flushPending(document),
      document: persisted.document,
      onClockSample: () => sync?.refreshPlayback(),
      onSynchronizationError: reportError,
      persistenceReady: persisted.whenSynced,
      socketFactory: () => api.createWorkspaceSocket(workspace.id),
    });
    providerRef.current = provider;
    assetsRef.current = assets;
    const projection = new HostedCanvasProjectionService({
      api,
      assets,
      cache,
      beforeRemoveEntity: (entityId) => activeRendererRef.current?.removeEntityTexture(entityId),
      onAutoplayBlocked: (entity) =>
        toastManager.add({
          description: `${entity.name} was started by a collaborator, but the browser blocked unmuted autoplay.`,
          title: "Playback needs a click",
        }),
      onError: reportError,
      requestRender: (entityId) => {
        requestAnimationFrame(() => {
          if (entityId) canvasStore.markEntityTextureDirty(entityId);
          else canvasStore.setContainerDirty();
        });
      },
      store: canvasStore,
      workspaceId: workspace.id,
    });
    sync = new HostedCanvasSync({
      assets,
      document,
      onError: reportError,
      projection,
      source: {
        getEntities: () => [...canvasStore.getState().entities.values()],
        getEntity: (id) => canvasStore.getState().entities.get(id),
        subscribeMutations: (listener) => canvasStore.subscribeEntityMutations(listener),
      },
      writable: canEditWorkspace(workspace.role),
    });
    const presenceByConnection = new Map<string, ServerPresenceMessage>();
    const unsubscribePresence = provider.onPresence((presence) => {
      if (!presence.name) presenceByConnection.delete(presence.connectionId);
      else {
        const previous = presenceByConnection.get(presence.connectionId);
        presenceByConnection.set(presence.connectionId, {
          ...previous,
          ...presence,
          cursor: presence.cursor === undefined ? previous?.cursor : presence.cursor,
          selectedEntityIds:
            presence.selectedEntityIds === undefined
              ? previous?.selectedEntityIds
              : presence.selectedEntityIds,
        });
      }
      setPeers([...presenceByConnection.values()]);
    });
    const publishSelection = () => {
      provider.publishPresence({
        selectedEntityIds: [...canvasStore.getState().selectedEntityIds],
      });
    };
    const unsubscribeSelection = canvasStore.subscribeSelector(
      (state) => state.selectedEntityIds,
      publishSelection,
    );
    const unsubscribeStatus = provider.onStatus((status) => {
      setConnectionStatus(status);
      if (status === "connected") publishSelection();
      if (status === "revoked" || status === "unavailable") {
        location.replace(`/cloud?access=${status}`);
      }
    });
    const unsubscribeRole = provider.onRole(onRoleChange);
    void Promise.all([persisted.whenSynced, viewportSync.start()]).then(() => {
      if (disposed) return;
      sync.start();
      provider.connect();
    });

    return () => {
      disposed = true;
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
      providerRef.current = null;
      assetsRef.current = null;
      unsubscribePresence();
      unsubscribeSelection();
      unsubscribeStatus();
      unsubscribeRole();
      window.removeEventListener("pagehide", flushViewport);
      viewportSync.destroy();
      sync?.destroy();
      provider.destroy();
      releaseUndoDelegate();
      document.destroy();
      void persisted.destroy();
    };
  }, [api, onRoleChange, queryClient, workspace.id, workspace.role]);

  const publishCursor = (cursor: PresencePoint | null) => {
    pendingCursorRef.current = cursor;
    if (cursorTimerRef.current) return;
    cursorTimerRef.current = setTimeout(() => {
      cursorTimerRef.current = null;
      providerRef.current?.publishPresence({
        cursor: pendingCursorRef.current,
      });
    }, 16);
  };

  useEffect(() => {
    const clearCursor = () => {
      if (!document.hidden && document.visibilityState !== "hidden") return;
      pendingCursorRef.current = null;
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
      providerRef.current?.publishPresence({ cursor: null });
    };
    document.addEventListener("visibilitychange", clearCursor);
    window.addEventListener("pagehide", clearCursor);
    return () => {
      document.removeEventListener("visibilitychange", clearCursor);
      window.removeEventListener("pagehide", clearCursor);
    };
  }, []);

  const downloadOriginal = async (entityId: string) => {
    const download = await assetsRef.current?.createOriginalDownload(entityId);
    if (!download) throw new Error("Hosted assets are not ready");
    const link = document.createElement("a");
    link.href = download.url;
    link.download = download.filename;
    link.rel = "noopener";
    link.click();
  };

  const loadAsset = async (asset: WorkspaceAssetSummary): Promise<File> => {
    const registry = assetsRef.current;
    if (!registry) throw new Error("Hosted assets are not ready");
    const grant = await api.createAssetContent(workspace.id, asset.id);
    const response = await fetch(grant.downloadUrl, { credentials: "include" });
    if (!response.ok) throw new Error(`Stored media could not be loaded (${response.status})`);
    const file = new File([await response.blob()], asset.originalFilename, {
      type: asset.contentType,
    });
    registry.adoptBlob(asset, file);
    return file;
  };

  const getCanvasAssetIds = (): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const entity of canvasStore.getState().entities.values()) {
      const reference = assetsRef.current?.getReference(entity.id);
      if (reference) ids.add(reference.id);
    }
    return ids;
  };

  const getCanvasVideoPreviews = async (): Promise<ReadonlyMap<string, Blob>> => {
    const previews = new Map<string, Blob>();
    for (const entity of canvasStore.getState().entities.values()) {
      if (entity.mediaSource.type !== "video") continue;
      const reference = assetsRef.current?.getReference(entity.id);
      if (!reference) continue;
      const preview = await createHostedAssetThumbnail(entity);
      if (preview) previews.set(reference.id, preview);
    }
    return previews;
  };

  return (
    <HostedWorkspaceRuntimeContext
      value={{
        api,
        connectionStatus,
        downloadOriginal,
        getCanvasAssetIds,
        getCanvasVideoPreviews,
        loadAsset,
        peers,
        publishCursor,
        workspace,
      }}
    >
      {children}
    </HostedWorkspaceRuntimeContext>
  );
}

export function useHostedWorkspaceRuntime(): HostedWorkspaceRuntimeValue | null {
  return use(HostedWorkspaceRuntimeContext);
}

function reportError(error: unknown): void {
  logger.error("Hosted workspace error", error);
  toastManager.add({
    description: error instanceof Error ? error.message : "Unexpected hosted workspace error",
    title: "Cloud sync failed",
    type: "destructive",
  });
}

function reportCacheError(error: unknown): void {
  logger.warn("Hosted workspace cache error", error);
}
