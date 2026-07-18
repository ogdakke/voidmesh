import type { WorkspaceAssetSummary, WorkspaceSummary } from "@voidmesh/api-contract";
import type { ServerPresenceMessage } from "@voidmesh/collaboration";
import type { CollaborationConnectionStatus } from "@voidmesh/collaboration/provider";
import { createContext, use } from "react";
import type { HostedApiClient } from "#lib/hosted-api-client.ts";

export interface HostedWorkspaceRuntimeValue {
  api: HostedApiClient;
  backfillCanvasAssetThumbnails(assetIds: ReadonlySet<string>): Promise<void>;
  connectionStatus: CollaborationConnectionStatus;
  downloadOriginal(entityId: string): Promise<void>;
  getCanvasAssetIds(): ReadonlySet<string>;
  getCanvasVideoPreviews(): Promise<ReadonlyMap<string, Blob>>;
  loadAsset(asset: WorkspaceAssetSummary): Promise<File>;
  peers: readonly ServerPresenceMessage[];
  publishCursor(cursor: { x: number; y: number } | null): void;
  workspace: WorkspaceSummary;
}

export const HostedWorkspaceRuntimeContext = createContext<HostedWorkspaceRuntimeValue | null>(
  null,
);

export function useHostedWorkspaceRuntime(): HostedWorkspaceRuntimeValue | null {
  return use(HostedWorkspaceRuntimeContext);
}
