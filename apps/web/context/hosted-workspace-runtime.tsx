import type { WorkspaceAssetSummary, WorkspaceSummary } from "@voidmesh/api-contract";
import { useQueryClient } from "@tanstack/react-query";
import { canEditWorkspace } from "@voidmesh/domain";
import {
  HostedCollaborationProvider,
  createPersistedHostedDocument,
  type CollaborationConnectionStatus,
} from "@voidmesh/collaboration/provider";
import type { PresencePoint, ServerPresenceMessage } from "@voidmesh/collaboration";
import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import { R2HostedAssetRegistry } from "#application/canvas/hosted-asset-registry.ts";
import { createHostedAssetThumbnail } from "#application/canvas/hosted-asset-thumbnail.ts";
import { HostedCanvasProjectionService } from "#application/canvas/hosted-canvas-projection.ts";
import { HostedCanvasSync } from "#application/canvas/hosted-canvas-sync.ts";
import { HostedViewportSync } from "#application/canvas/hosted-viewport-sync.ts";
import { canvasStore } from "#engine";
import { HostedApiClient } from "#lib/hosted-api-client.ts";
import { HostedWorkspaceDocument } from "#lib/hosted-workspace-document.ts";
import { BrowserHostedAssetCache } from "#lib/hosted-asset-cache.ts";
import { mapSettledWithConcurrency } from "#lib/async-concurrency.ts";
import { cssColorToRGBA } from "#lib/color-utils.ts";
import { logger } from "#lib/client.logger.ts";
import { undo } from "#lib/undo.ts";
import { toastManager } from "#application/notifications.ts";
import type { RGBA } from "#types/canvas.ts";
import { useCanvasRendererService } from "./use-canvas.ts";
import { HostedWorkspaceRuntimeContext } from "./use-hosted-workspace-runtime.ts";

const MAX_CONCURRENT_THUMBNAIL_BACKFILLS = 4;

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
  const [peerCount, setPeerCount] = useState(0);
  const providerRef = useRef<HostedCollaborationProvider | null>(null);
  const assetsRef = useRef<R2HostedAssetRegistry | null>(null);

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
      onCacheError: reportCacheError,
      onError: reportMediaError,
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
    const presenceColors = new Map<string, RGBA>();
    const unsubscribePresence = provider.onPresence((presence) => {
      if (!presence.name) {
        if (presenceByConnection.delete(presence.connectionId)) {
          presenceColors.delete(presence.connectionId);
          canvasStore.removeRemotePeerPresence(presence.connectionId);
          setPeerCount(presenceByConnection.size);
        }
      } else {
        const previous = presenceByConnection.get(presence.connectionId);
        const merged = {
          ...previous,
          ...presence,
          cursor: presence.cursor === undefined ? previous?.cursor : presence.cursor,
          selectedEntityIds:
            presence.selectedEntityIds === undefined
              ? previous?.selectedEntityIds
              : presence.selectedEntityIds,
        };
        presenceByConnection.set(presence.connectionId, merged);
        let color = presenceColors.get(presence.connectionId);
        if (!color || previous?.color !== merged.color) {
          color = cssColorToRGBA(merged.color);
          presenceColors.set(presence.connectionId, color);
        }
        canvasStore.setRemotePeerPresence({
          peerId: merged.connectionId,
          name: merged.name,
          color,
          cursor: merged.cursor ?? null,
          selectedEntityIds: merged.selectedEntityIds ?? [],
        });
        if (!previous) setPeerCount(presenceByConnection.size);
      }
    });
    let presenceTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingPresence: {
      cursor?: PresencePoint | null;
      selectedEntityIds?: string[];
    } | null = null;
    let localCursor: PresencePoint | null = null;
    let localSelection: ReadonlySet<string> | null = null;
    let localSelectedEntityIds: string[] = [];
    const flushPresence = () => {
      if (provider.status !== "connected" || !pendingPresence) return;
      const presence = pendingPresence;
      pendingPresence = null;
      provider.publishPresence(presence);
    };
    const schedulePresence = () => {
      if (presenceTimer) return;
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        flushPresence();
      }, 16);
    };
    const unsubscribeLocalPresence = canvasStore.subscribeLocalPresence(
      (cursor, selectedEntityIds) => {
        if (
          localCursor?.x !== cursor?.x ||
          localCursor?.y !== cursor?.y ||
          (localCursor === null) !== (cursor === null)
        ) {
          localCursor = cursor ? { ...cursor } : null;
          pendingPresence = { ...pendingPresence, cursor: localCursor };
        }
        if (localSelection !== selectedEntityIds) {
          localSelection = selectedEntityIds;
          localSelectedEntityIds = [...selectedEntityIds];
          pendingPresence = {
            ...pendingPresence,
            selectedEntityIds: localSelectedEntityIds,
          };
        }
        if (pendingPresence) schedulePresence();
      },
    );
    const unsubscribeStatus = provider.onStatus((status) => {
      setConnectionStatus(status);
      if (status === "connected") {
        pendingPresence = {
          cursor: localCursor,
          selectedEntityIds: localSelectedEntityIds,
        };
        flushPresence();
      }
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
      if (presenceTimer) clearTimeout(presenceTimer);
      providerRef.current = null;
      assetsRef.current = null;
      canvasStore.clearRemotePeerPresences();
      unsubscribePresence();
      unsubscribeLocalPresence();
      unsubscribeStatus();
      unsubscribeRole();
      window.removeEventListener("pagehide", flushViewport);
      viewportSync.destroy();
      sync?.destroy();
      projection.destroy();
      provider.destroy();
      releaseUndoDelegate();
      document.destroy();
      void persisted.destroy();
    };
  }, [api, onRoleChange, queryClient, workspace.id, workspace.role]);

  useEffect(() => {
    const clearCursor = () => {
      if (!document.hidden && document.visibilityState !== "hidden") return;
      canvasStore.setLocalCursor(null);
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
    registry.adoptBlob(asset, file, asset.thumbnailUrl === null);
    return file;
  };

  const backfillCanvasAssetThumbnails = async (assetIds: ReadonlySet<string>): Promise<void> => {
    const registry = assetsRef.current;
    if (!registry || assetIds.size === 0) return;
    const pending: Array<() => Promise<void>> = [];
    const scheduled = new Set<string>();
    for (const entity of canvasStore.getState().entities.values()) {
      const reference = registry.getReference(entity.id);
      if (!reference || !assetIds.has(reference.id) || scheduled.has(reference.id)) continue;
      scheduled.add(reference.id);
      pending.push(() => registry.backfillThumbnail(entity, reference));
    }
    const results = await mapSettledWithConcurrency(
      pending,
      MAX_CONCURRENT_THUMBNAIL_BACKFILLS,
      (backfill) => backfill(),
    );
    reportBatchErrors(results, "asset thumbnails could not be prepared");
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
        backfillCanvasAssetThumbnails,
        connectionStatus,
        downloadOriginal,
        getCanvasAssetIds,
        getCanvasVideoPreviews,
        loadAsset,
        peerCount,
        workspace,
      }}
    >
      {children}
    </HostedWorkspaceRuntimeContext>
  );
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

function reportMediaError(error: unknown): void {
  logger.error("Hosted workspace media error", error);
  toastManager.add({
    description: error instanceof Error ? error.message : "Unexpected hosted media error",
    title: "Media could not be loaded",
    type: "destructive",
  });
}

function reportBatchErrors(
  results: readonly PromiseSettledResult<unknown>[],
  description: string,
): void {
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) reportError(errors[0]);
  else if (errors.length > 1) {
    reportError(new AggregateError(errors, `${errors.length} ${description}`));
  }
}
