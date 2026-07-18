import { createEnum } from "@voidmesh/domain/enum";
import type {
  ExportId,
  InvitationId,
  PlanKey,
  UserId,
  WorkspaceId,
  WorkspaceLifecycle,
  WorkspaceRole,
  WorkspaceExportState,
} from "@voidmesh/domain";

export const API_VERSION = "v1";

export const ApiErrorCode = createEnum({
  forbidden: "forbidden",
  internal: "internal",
  invalidRequest: "invalid-request",
  notFound: "not-found",
  quotaExceeded: "quota-exceeded",
  rateLimited: "rate-limited",
  unauthorized: "unauthorized",
});
export type ApiErrorCode = typeof ApiErrorCode.infer;

export interface ApiErrorResponse {
  code: ApiErrorCode;
  message: string;
  requestId: string;
}

export interface HealthResponse {
  environment: string;
  ok: true;
  service: "voidmesh-api";
}

export interface WorkspaceSocketTicketResponse {
  protocol: string;
  socketUrl: string;
}

export interface CreateWorkspaceRequest {
  title: string;
}

export interface UpdateWorkspaceRequest {
  title: string;
}

export interface WorkspaceSummary {
  createdAt: number;
  deletedAt: number | null;
  id: WorkspaceId;
  lifecycle: WorkspaceLifecycle;
  purgeAfter: number | null;
  role: WorkspaceRole;
  title: string;
  updatedAt: number;
  usedBytes: number;
  storageLimitBytes: number;
  overQuota: boolean;
}

export interface WorkspaceResponse {
  workspace: WorkspaceSummary;
}

export interface WorkspaceExportSummary {
  byteLength: number | null;
  completedAt: number | null;
  createdAt: number;
  filename: string;
  id: ExportId;
  roomSequence: number;
  state: WorkspaceExportState;
  workspaceId: WorkspaceId;
}

export interface WorkspaceExportResponse {
  export: WorkspaceExportSummary;
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[];
}

export interface WorkspaceViewState {
  offset: { x: number; y: number };
  updatedAt: number;
  zoom: number;
}

export interface WorkspaceViewStateResponse {
  viewState: WorkspaceViewState | null;
}

export interface UpdateWorkspaceViewStateRequest {
  offset: { x: number; y: number };
  zoom: number;
}

export interface CreateInvitationRequest {
  role: Exclude<WorkspaceRole, "owner">;
}

export interface InvitationLinkSummary {
  createdAt: number;
  id: InvitationId;
  revokedAt: number | null;
  role: Exclude<WorkspaceRole, "owner">;
  useCount: number;
  workspaceId: WorkspaceId;
}

export interface CreatedInvitationResponse {
  invitation: InvitationLinkSummary & { token: string };
}

export interface InvitationListResponse {
  invitations: InvitationLinkSummary[];
}

export interface RedeemInvitationResponse {
  membership: WorkspaceMember;
  workspace: WorkspaceSummary;
}

export interface UpdateMemberRequest {
  role: Exclude<WorkspaceRole, "owner">;
}

export interface WorkspaceMember {
  acceptedAt: number;
  email: string;
  name: string;
  role: WorkspaceRole;
  userId: UserId;
}

export interface WorkspaceMemberListResponse {
  members: WorkspaceMember[];
}

export interface AccountResponse {
  account: {
    canEditCollaborate: boolean;
    canViewShare: boolean;
    hardAssetLimitBytes: number;
    ownedStorageBytes: number;
    ownedWorkspaceCount: number;
    planKey: PlanKey;
    storageLimitBytes: number;
    workspaceLimit: number;
    workspaceStorageLimitBytes: number;
  };
  subscription: {
    cancelAtPeriodEnd: boolean;
    currentPeriodEndsAt: number | null;
    status: string;
  } | null;
  billingAvailable: boolean;
}

export interface BillingSessionResponse {
  url: string;
}

export interface ReserveAssetUploadRequest {
  byteLength: number;
  contentHash?: string;
  contentType: string;
  mediaType: string;
  originalFilename: string;
  thumbnail?: {
    byteLength: number;
    contentHash: string;
    contentType: "image/webp";
    data: string;
  };
}

export interface AssetUploadGrantResponse {
  assetId: string;
  expiresAt: number;
  headers: Record<string, string>;
  reservationId: string;
  uploadUrl: string;
}

export interface AssetDownloadGrantResponse {
  downloadUrl: string;
  expiresAt: number;
  grantId: string;
}

export interface AssetResponse {
  asset: {
    byteLength: number;
    contentHash: string | null;
    contentType: string;
    id: string;
    mediaType: string;
    originalFilename: string;
    workspaceId: WorkspaceId;
  };
}

export type WorkspaceAssetUsage = "active" | "unused";

export interface WorkspaceAssetSummary {
  byteLength: number;
  contentHash: string | null;
  contentType: string;
  createdAt: number;
  id: string;
  mediaType: string;
  originalFilename: string;
  thumbnailUrl: string | null;
  unreferencedAt: number | null;
  usage: WorkspaceAssetUsage;
  workspaceId: WorkspaceId;
}

export interface WorkspaceAssetListResponse {
  assets: WorkspaceAssetSummary[];
  nextCursor: string | null;
  storage: {
    activeBytes: number;
    reservedBytes: number;
    totalUsedBytes: number;
    unusedBytes: number;
  };
}

export function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
