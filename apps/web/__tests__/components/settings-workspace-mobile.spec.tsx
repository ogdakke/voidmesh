import type { WorkspaceSummary } from "@voidmesh/api-contract";
import { WorkspaceLifecycle, WorkspaceRole } from "@voidmesh/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HostedWorkspaceSettings from "#components/settings/settings.workspace.mobile.tsx";
import type { useHostedWorkspaceRuntime } from "#context/hosted-workspace-runtime.tsx";
import type { HostedApiClient } from "#lib/hosted-api-client.ts";
import { Drawer } from "#ui/drawer/index.tsx";

type Runtime = NonNullable<ReturnType<typeof useHostedWorkspaceRuntime>>;

function workspace(role: WorkspaceSummary["role"]): WorkspaceSummary {
  return {
    createdAt: 1,
    deletedAt: null,
    id: "workspace_mobile_settings" as WorkspaceSummary["id"],
    lifecycle: WorkspaceLifecycle.active,
    overQuota: false,
    purgeAfter: null,
    role,
    storageLimitBytes: 1024 ** 3,
    title: "Mobile workspace",
    updatedAt: 1,
    usedBytes: 2048,
  };
}

function runtime(role: WorkspaceSummary["role"]): Runtime {
  const api = {
    listInvitations: vi.fn<HostedApiClient["listInvitations"]>(async () => ({ invitations: [] })),
    listMembers: vi.fn<HostedApiClient["listMembers"]>(async () => ({
      members: [
        {
          acceptedAt: 1,
          email: "Owner@Example.com",
          name: "Workspace Owner",
          role: WorkspaceRole.owner,
          userId: "owner_mobile_settings",
        },
      ],
    })),
  } as unknown as HostedApiClient;
  return {
    api,
    connectionStatus: "connected",
    downloadOriginal: vi.fn<Runtime["downloadOriginal"]>(),
    peers: [],
    publishCursor: vi.fn<Runtime["publishCursor"]>(),
    workspace: workspace(role),
  };
}

describe("Hosted mobile workspace settings", () => {
  it("shows owners every management page and a permission-first invitation flow", async () => {
    render(
      <Drawer.Provider>
        <HostedWorkspaceSettings runtime={runtime(WorkspaceRole.owner)} />
      </Drawer.Provider>,
    );

    expect(screen.getByRole("button", { name: "Save name" })).toHaveAttribute("data-size", "md");
    expect(screen.getByRole("button", { name: "Open full workspace settings" })).toHaveAttribute(
      "data-size",
      "md",
    );
    expect(screen.getByRole("button", { name: "Download .vdmsh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete workspace…" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Members" })).toBeVisible());
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();

    const createInvitationButton = screen.getByRole("button", {
      name: "Create invitation link",
    });
    expect(createInvitationButton).toHaveAttribute("data-size", "md");
    fireEvent.click(createInvitationButton);
    expect(screen.getByRole("group", { name: "Link permissions" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Can view" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Can edit" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
  });

  it("keeps owner-only and export actions out of a viewer workspace", async () => {
    render(
      <Drawer.Provider>
        <HostedWorkspaceSettings runtime={runtime(WorkspaceRole.viewer)} />
      </Drawer.Provider>,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Members" })).toBeVisible());
    expect(
      screen.queryByRole("button", { name: "Create invitation link" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download .vdmsh" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete workspace…" })).not.toBeInTheDocument();
  });
});
