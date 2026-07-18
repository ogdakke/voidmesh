import type {
  ApiErrorResponse,
  AccountResponse,
  AssetDownloadGrantResponse,
  AssetResponse,
  AssetUploadGrantResponse,
  BillingSessionResponse,
  CreateInvitationRequest,
  CreateWorkspaceRequest,
  CreatedInvitationResponse,
  InvitationListResponse,
  ReserveAssetUploadRequest,
  RedeemInvitationResponse,
  UpdateWorkspaceViewStateRequest,
  UpdateMemberRequest,
  WorkspaceMemberListResponse,
  WorkspaceExportResponse,
  WorkspaceListResponse,
  WorkspaceResponse,
  WorkspaceViewStateResponse,
  WorkspaceSocketTicketResponse,
} from "@voidmesh/api-contract";
import type { ExportId, InvitationId, UserId, WorkspaceId } from "@voidmesh/domain";

export class HostedApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;

  constructor(response: ApiErrorResponse, status: number) {
    super(response.message);
    this.name = "HostedApiError";
    this.code = response.code;
    this.requestId = response.requestId;
    this.status = status;
  }
}

export class HostedApiClient {
  readonly #baseURL: URL;

  constructor(baseURL = location.origin) {
    this.#baseURL = new URL(baseURL);
  }

  listWorkspaces(): Promise<WorkspaceListResponse> {
    return this.#request("/v1/workspaces");
  }

  listDeletedWorkspaces(): Promise<WorkspaceListResponse> {
    return this.#request("/v1/workspaces?lifecycle=deleted");
  }

  getAccount(): Promise<AccountResponse> {
    return this.#request("/v1/me");
  }

  createCheckoutSession(
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<BillingSessionResponse> {
    return this.#request("/v1/billing/checkout", {
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
    });
  }

  createBillingPortalSession(
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<BillingSessionResponse> {
    return this.#request("/v1/billing/portal", {
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
    });
  }

  createWorkspace(
    input: CreateWorkspaceRequest,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<WorkspaceResponse> {
    return this.#request("/v1/workspaces", {
      body: JSON.stringify(input),
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
    });
  }

  updateWorkspace(workspaceId: WorkspaceId, title: string): Promise<WorkspaceResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
      body: JSON.stringify({ title }),
      method: "PATCH",
    });
  }

  deleteWorkspace(workspaceId: WorkspaceId): Promise<void> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: "DELETE",
    });
  }

  restoreWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/restore`, {
      method: "POST",
    });
  }

  getWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  createWorkspaceExport(
    workspaceId: WorkspaceId,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<WorkspaceExportResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/export`, {
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
    });
  }

  getWorkspaceExport(
    workspaceId: WorkspaceId,
    exportId: ExportId,
  ): Promise<WorkspaceExportResponse> {
    return this.#request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/exports/${encodeURIComponent(exportId)}`,
    );
  }

  downloadWorkspaceExport(workspaceId: WorkspaceId, exportId: ExportId, filename: string): void {
    const link = document.createElement("a");
    link.href = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/exports/${encodeURIComponent(exportId)}/download`,
      this.#baseURL,
    ).toString();
    link.download = filename;
    link.click();
  }

  getWorkspaceViewState(workspaceId: WorkspaceId): Promise<WorkspaceViewStateResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/view-state`);
  }

  updateWorkspaceViewState(
    workspaceId: WorkspaceId,
    input: UpdateWorkspaceViewStateRequest,
    keepalive = false,
  ): Promise<WorkspaceViewStateResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/view-state`, {
      body: JSON.stringify(input),
      keepalive,
      method: "PATCH",
    });
  }

  listInvitations(workspaceId: WorkspaceId): Promise<InvitationListResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`);
  }

  createInvitation(
    workspaceId: WorkspaceId,
    input: CreateInvitationRequest,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<CreatedInvitationResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`, {
      body: JSON.stringify(input),
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
    });
  }

  revokeInvitation(workspaceId: WorkspaceId, invitationId: InvitationId): Promise<void> {
    return this.#request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
  }

  redeemInvitation(token: string): Promise<RedeemInvitationResponse> {
    return this.#request(`/v1/invitations/${encodeURIComponent(token)}/redeem`, {
      method: "POST",
    });
  }

  listMembers(workspaceId: WorkspaceId): Promise<WorkspaceMemberListResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/members`);
  }

  updateMember(
    workspaceId: WorkspaceId,
    userId: UserId,
    input: UpdateMemberRequest,
  ): Promise<void> {
    return this.#request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { body: JSON.stringify(input), method: "PATCH" },
    );
  }

  removeMember(workspaceId: WorkspaceId, userId: UserId): Promise<void> {
    return this.#request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  reserveAssetUpload(
    workspaceId: WorkspaceId,
    input: ReserveAssetUploadRequest,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<AssetUploadGrantResponse> {
    return this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/uploads`, {
      body: JSON.stringify(input),
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
    });
  }

  finalizeAssetUpload(workspaceId: WorkspaceId, reservationId: string): Promise<AssetResponse> {
    return this.#request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/uploads/${encodeURIComponent(reservationId)}/finalize`,
      { method: "POST" },
    );
  }

  createAssetDownload(
    workspaceId: WorkspaceId,
    assetId: string,
  ): Promise<AssetDownloadGrantResponse> {
    return this.#request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/download`,
      { method: "POST" },
    );
  }

  createAssetContent(
    workspaceId: WorkspaceId,
    assetId: string,
  ): Promise<AssetDownloadGrantResponse> {
    return this.#request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}/content`,
      { method: "POST" },
    );
  }

  async createWorkspaceSocket(workspaceId: WorkspaceId): Promise<WebSocket> {
    const ticket = await this.#request<WorkspaceSocketTicketResponse>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/connect-ticket`,
      { method: "POST" },
    );
    const url = new URL(ticket.socketUrl, this.#baseURL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url, ticket.protocol);
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(new URL(path, this.#baseURL), {
      ...init,
      credentials: "include",
      headers,
    });
    if (!response.ok) {
      const body = (await response.json()) as ApiErrorResponse;
      throw new HostedApiError(body, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
