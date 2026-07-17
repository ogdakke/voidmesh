import { createEnum } from "./enum.ts";

export type AccountId = string;
export type AssetId = string;
export type ExportId = string;
export type InvitationId = string;
export type UserId = string;
export type WorkspaceId = string;

export const WorkspaceRole = createEnum({
  owner: "owner",
  editor: "editor",
  viewer: "viewer",
});
export type WorkspaceRole = typeof WorkspaceRole.infer;

export const WorkspaceLifecycle = createEnum({
  active: "active",
  deleted: "deleted",
});
export type WorkspaceLifecycle = typeof WorkspaceLifecycle.infer;

export const WorkspaceExportState = createEnum({
  queued: "queued",
  processing: "processing",
  completed: "completed",
  failed: "failed",
});
export type WorkspaceExportState = typeof WorkspaceExportState.infer;

export const PlanFeature = createEnum({
  editCollaboration: "edit-collaboration",
  viewSharing: "view-sharing",
});
export type PlanFeature = typeof PlanFeature.infer;

export const PlanKey = createEnum({
  cloudFree: "cloud-free",
  pro: "pro",
});
export type PlanKey = typeof PlanKey.infer;

export interface AccountEntitlements {
  accountStorageBytes: number;
  features: ReadonlySet<PlanFeature>;
  hardAssetBytes: number;
  hostedWorkspaceCount: number;
  workspaceStorageBytes: number;
}

export const GIBIBYTE = 1024 ** 3;

export const CLOUD_FREE_ENTITLEMENTS: AccountEntitlements = Object.freeze({
  accountStorageBytes: GIBIBYTE,
  features: new Set<PlanFeature>([PlanFeature.viewSharing]),
  hardAssetBytes: GIBIBYTE,
  hostedWorkspaceCount: 1,
  workspaceStorageBytes: GIBIBYTE,
});

export function canInviteRole(
  entitlements: AccountEntitlements,
  role: Exclude<WorkspaceRole, "owner">,
): boolean {
  return role === WorkspaceRole.viewer
    ? entitlements.features.has(PlanFeature.viewSharing)
    : entitlements.features.has(PlanFeature.editCollaboration);
}

export function canEditWorkspace(role: WorkspaceRole): boolean {
  return role === WorkspaceRole.owner || role === WorkspaceRole.editor;
}

export function effectiveWorkspaceRole(
  role: WorkspaceRole,
  canEditCollaborate: boolean,
): WorkspaceRole {
  return role === WorkspaceRole.editor && !canEditCollaborate ? WorkspaceRole.viewer : role;
}

export function canViewWorkspace(role: WorkspaceRole): boolean {
  return (
    role === WorkspaceRole.owner || role === WorkspaceRole.editor || role === WorkspaceRole.viewer
  );
}
