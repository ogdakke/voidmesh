import type { AccountResponse } from "@voidmesh/api-contract";
import { NavArrowRight, ProfileCircle } from "iconoir-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "#ui/button/index.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { authClient } from "#lib/auth-client.ts";
import { HostedApiClient, HostedApiError } from "#lib/hosted-api-client.ts";
import "./mobile-account-drawer.css";

const api = new HostedApiClient();

export function MobileAccountDrawer() {
  const billingKeysRef = useRef<{ checkout: string; portal: string } | null>(null);
  const session = authClient.useSession();
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [billingAction, setBillingAction] = useState<"checkout" | "portal" | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);

  useEffect(() => {
    if (!session.data) return;
    let active = true;
    void api
      .getAccount()
      .then((response) => {
        if (active) setAccount(response);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [session.data]);

  const openBilling = async (action: "checkout" | "portal") => {
    setBillingAction(action);
    setError(null);
    billingKeysRef.current ??= {
      checkout: crypto.randomUUID(),
      portal: crypto.randomUUID(),
    };
    try {
      const result =
        action === "checkout"
          ? await api.createCheckoutSession(billingKeysRef.current.checkout)
          : await api.createBillingPortalSession(billingKeysRef.current.portal);
      location.assign(result.url);
    } catch (reason) {
      setError(errorMessage(reason));
      setBillingAction(null);
    }
  };

  const signOutEverywhere = async () => {
    setError(null);
    const result = await authClient.revokeSessions();
    if (result.error) setError(result.error.message ?? "Could not sign out all devices");
    else location.assign("/cloud");
  };

  const editProfile = () => {
    if (!session.data) return;
    setProfileName(session.data.user.name);
    setEditingProfile(true);
    setError(null);
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = profileName.trim();
    if (!name || !session.data) return;
    if (name === session.data.user.name) {
      setEditingProfile(false);
      return;
    }

    setSavingProfile(true);
    setError(null);
    const result = await authClient.updateUser({ name });
    if (result.error) {
      setError(result.error.message ?? "Could not update your profile");
      setSavingProfile(false);
      return;
    }
    await session.refetch();
    setSavingProfile(false);
    setEditingProfile(false);
  };

  const deleteAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDeleting(true);
    setError(null);
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    const result = await authClient.deleteUser({ password });
    if (result.error) {
      setError(result.error.message ?? "Account deletion failed");
      setDeleting(false);
      return;
    }
    location.assign("/");
  };

  const planName = account?.account.planKey === "pro" ? "Pro" : "Cloud Free";

  return (
    <Drawer.Root>
      <Drawer.Trigger
        render={(props) => (
          <button {...props} className="mobile-account-trigger" type="button">
            <ProfileCircle />
            <span>{session.data ? session.data.user.name : "Profile"}</span>
            {session.data && <small>{planName}</small>}
            <NavArrowRight />
          </button>
        )}
      />
      <Drawer.Popup>
        <Drawer.Content className="mobile-account-drawer">
          <Drawer.Title>{session.data ? "Your profile" : "Voidmesh Cloud"}</Drawer.Title>
          {session.isPending ? (
            <p className="mobile-account-muted">Checking your account…</p>
          ) : session.error ? (
            <section className="mobile-account-section mobile-account-signed-out">
              <p className="mobile-account-error" role="alert">
                Couldn’t check your account. Please try again.
              </p>
              <Button variant="secondary" type="button" onClick={() => void session.refetch()}>
                Retry
              </Button>
            </section>
          ) : !session.data ? (
            <section className="mobile-account-section mobile-account-signed-out">
              <ProfileCircle />
              <div>
                <h3>Hosted workspaces</h3>
                <p>
                  Sign in to open cloud workspaces, share canvases, and manage a Pro subscription.
                  The local canvas stays free without an account.
                </p>
              </div>
              <Button variant="primary" type="button" onClick={() => location.assign("/cloud")}>
                Sign in or create account
              </Button>
            </section>
          ) : (
            <div className="mobile-account-content">
              <header className="mobile-account-identity">
                <span aria-hidden="true">{initials(session.data.user.name)}</span>
                <div>
                  <h3>{session.data.user.name}</h3>
                  <p>{session.data.user.email}</p>
                </div>
                {!editingProfile && (
                  <button className="mobile-account-edit" type="button" onClick={editProfile}>
                    Edit
                  </button>
                )}
              </header>

              {editingProfile && (
                <form className="mobile-account-profile-form" onSubmit={saveProfile}>
                  <label htmlFor="mobile-profile-name">Display name</label>
                  <input
                    id="mobile-profile-name"
                    autoComplete="name"
                    maxLength={80}
                    required
                    value={profileName}
                    onChange={(event) => setProfileName(event.currentTarget.value)}
                  />
                  <p>Your email address is managed separately for account security.</p>
                  <div>
                    <Button
                      variant="quiet"
                      type="button"
                      disabled={savingProfile}
                      onClick={() => setEditingProfile(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={!profileName.trim() || savingProfile}
                      isPending={savingProfile}
                    >
                      {savingProfile ? "Saving…" : "Save name"}
                    </Button>
                  </div>
                </form>
              )}

              {account && (
                <section className="mobile-account-section">
                  <div className="mobile-account-plan-heading">
                    <div>
                      <small>Current plan</small>
                      <strong>{planName}</strong>
                    </div>
                    <span>
                      {account.account.canEditCollaborate
                        ? "Invite people to view or edit"
                        : "Invite people to view"}
                    </span>
                  </div>
                  <progress
                    aria-label="Cloud storage used"
                    max={account.account.storageLimitBytes}
                    value={account.account.ownedStorageBytes}
                  />
                  <p className="mobile-account-muted">
                    {formatBytes(account.account.ownedStorageBytes)} of{" "}
                    {formatBytes(account.account.storageLimitBytes)} ·{" "}
                    {account.account.ownedWorkspaceCount} of {account.account.workspaceLimit}{" "}
                    workspaces
                  </p>
                  {account.subscription ? (
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={!account.billingAvailable || billingAction !== null}
                      isPending={billingAction === "portal"}
                      onClick={() => void openBilling("portal")}
                    >
                      {billingAction === "portal" ? "Opening…" : "Manage billing"}
                    </Button>
                  ) : account.billingAvailable ? (
                    <Button
                      variant="primary"
                      type="button"
                      disabled={billingAction !== null}
                      isPending={billingAction === "checkout"}
                      onClick={() => void openBilling("checkout")}
                    >
                      {billingAction === "checkout" ? "Opening…" : "Upgrade to Pro"}
                    </Button>
                  ) : (
                    <p className="mobile-account-muted">
                      Pro upgrades aren’t available in this local build.
                    </p>
                  )}
                </section>
              )}

              {error && (
                <p className="mobile-account-error" role="alert">
                  {error}
                </p>
              )}

              <section className="mobile-account-section mobile-account-actions">
                <Button variant="primary" type="button" onClick={() => location.assign("/cloud")}>
                  Cloud workspaces
                </Button>
                <Button variant="secondary" type="button" onClick={() => void authClient.signOut()}>
                  Sign out this device
                </Button>
                <Button variant="quiet" type="button" onClick={() => void signOutEverywhere()}>
                  Sign out all devices
                </Button>
              </section>

              <section className="mobile-account-section mobile-account-danger">
                <div>
                  <h3>Delete account</h3>
                  <p>
                    Cancels Pro and schedules owned workspaces for deletion after the 30-day
                    recovery window.
                  </p>
                </div>
                {confirmingDeletion ? (
                  <form onSubmit={deleteAccount}>
                    <label>
                      Confirm your password
                      <input
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                      />
                    </label>
                    <div>
                      <Button
                        variant="quiet"
                        type="button"
                        disabled={deleting}
                        onClick={() => setConfirmingDeletion(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        type="submit"
                        disabled={deleting}
                        isPending={deleting}
                      >
                        {deleting ? "Deleting…" : "Delete account"}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <Button
                    variant="destructive"
                    type="button"
                    onClick={() => setConfirmingDeletion(true)}
                  >
                    Delete account…
                  </Button>
                )}
              </section>
            </div>
          )}
        </Drawer.Content>
      </Drawer.Popup>
    </Drawer.Root>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase() ?? "")
      .join("") || "V"
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof HostedApiError || reason instanceof Error) return reason.message;
  return "Something went wrong";
}
