import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Drawer } from "#ui/drawer/index.tsx";

const mocks = vi.hoisted(() => ({
  deleteUser: vi.fn(),
  getAccount: vi.fn(),
  revokeSessions: vi.fn(),
  session: {
    data: null as null | {
      user: { email: string; emailVerified: boolean; id: string; name: string };
    },
    error: null as Error | null,
    isPending: false,
    refetch: vi.fn(),
  },
  signOut: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("#lib/auth-client.ts", () => ({
  authClient: {
    deleteUser: mocks.deleteUser,
    revokeSessions: mocks.revokeSessions,
    signOut: mocks.signOut,
    updateUser: mocks.updateUser,
    useSession: () => mocks.session,
  },
}));

vi.mock("#lib/hosted-api-client.ts", () => ({
  HostedApiClient: class {
    createBillingPortalSession = vi.fn();
    createCheckoutSession = vi.fn();
    getAccount = mocks.getAccount;
  },
  HostedApiError: class extends Error {},
}));

import { MobileAccountDrawer } from "#components/hosted/mobile-account-drawer.tsx";

describe("MobileAccountDrawer", () => {
  beforeEach(() => {
    mocks.session.data = null;
    mocks.session.error = null;
    mocks.session.refetch.mockReset();
    mocks.deleteUser.mockReset();
    mocks.getAccount.mockReset();
    mocks.revokeSessions.mockReset();
    mocks.signOut.mockReset();
    mocks.updateUser.mockReset();
  });

  it("offers cloud sign-in without making the local canvas require an account", async () => {
    render(
      <Drawer.Provider>
        <MobileAccountDrawer />
      </Drawer.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByRole("heading", { name: "Voidmesh Cloud" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in or create account" })).toBeInTheDocument();
    expect(screen.getByText(/local canvas stays free without an account/i)).toBeInTheDocument();
  });

  it("lets the user retry when the account check fails", async () => {
    mocks.session.error = new Error("API unavailable");
    render(
      <Drawer.Provider>
        <MobileAccountDrawer />
      </Drawer.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t check your account/i);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.session.refetch).toHaveBeenCalledOnce();
  });

  it("shows plan, security, and password-gated account deletion controls", async () => {
    mocks.session.data = {
      user: {
        email: "Viewer@Example.com",
        emailVerified: true,
        id: "user_viewer",
        name: "Voidmesh Viewer",
      },
    };
    mocks.getAccount.mockResolvedValue({
      account: {
        canEditCollaborate: false,
        canViewShare: true,
        hardAssetLimitBytes: 1024 ** 3,
        ownedStorageBytes: 17 * 1024,
        ownedWorkspaceCount: 1,
        planKey: "cloud-free",
        storageLimitBytes: 1024 ** 3,
        workspaceLimit: 1,
        workspaceStorageLimitBytes: 1024 ** 3,
      },
      billingAvailable: false,
      subscription: null,
    });
    render(
      <Drawer.Provider>
        <MobileAccountDrawer />
      </Drawer.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Voidmesh Viewer Cloud Free" }));
    expect(await screen.findByRole("heading", { name: "Your profile" })).toBeInTheDocument();
    await waitFor(() => expect(mocks.getAccount).toHaveBeenCalledOnce());
    expect(screen.getByText("viewer@example.com")).toBeInTheDocument();
    expect(screen.getByText("17 KiB of 1.0 GiB · 1 of 1 workspaces")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out all devices" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete account…" }));
    expect(screen.getByLabelText("Confirm your password")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Delete account?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permanently delete account" })).toBeInTheDocument();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it("lets a signed-in user update their display name", async () => {
    mocks.session.data = {
      user: {
        email: "viewer@example.com",
        emailVerified: true,
        id: "user_viewer",
        name: "Voidmesh Viewer",
      },
    };
    mocks.getAccount.mockResolvedValue({
      account: {
        canEditCollaborate: false,
        canViewShare: true,
        hardAssetLimitBytes: 1024 ** 3,
        ownedStorageBytes: 0,
        ownedWorkspaceCount: 1,
        planKey: "cloud-free",
        storageLimitBytes: 1024 ** 3,
        workspaceLimit: 1,
        workspaceStorageLimitBytes: 1024 ** 3,
      },
      billingAvailable: false,
      subscription: null,
    });
    mocks.updateUser.mockResolvedValue({ data: {}, error: null });
    mocks.session.refetch.mockResolvedValue(undefined);
    render(
      <Drawer.Provider>
        <MobileAccountDrawer />
      </Drawer.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Voidmesh Viewer Cloud Free" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const nameInput = screen.getByLabelText("Display name");
    fireEvent.change(nameInput, { target: { value: "Updated Viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(mocks.updateUser).toHaveBeenCalledWith({ name: "Updated Viewer" }));
    expect(mocks.session.refetch).toHaveBeenCalledOnce();
  });
});
