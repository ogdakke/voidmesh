import type { AccountResponse, WorkspaceSummary } from "@voidmesh/api-contract";
import type { WorkspaceId } from "@voidmesh/domain";
import { useEffect, useRef, useState, type FormEvent, type PropsWithChildren } from "react";
import { Button } from "#ui/button/index.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { authClient } from "#lib/auth-client.ts";
import { appLoader } from "#lib/app-loader.ts";
import { HostedApiClient, HostedApiError } from "#lib/hosted-api-client.ts";
import { HostedSharing } from "./hosted-sharing.tsx";
import "./hosted-entry.css";

const api = new HostedApiClient();
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
type AuthMode = "check-email" | "forgot-password" | "reset-password" | "sign-in" | "sign-up";

declare global {
  interface Window {
    turnstile?: {
      remove(widgetId: string): void;
      render(
        container: HTMLElement,
        options: {
          action: string;
          callback(token: string): void;
          "error-callback"(): void;
          "expired-callback"(): void;
          sitekey: string;
          theme: "auto";
        },
      ): string;
    };
  }
}

export function HostedEntry({
  children,
}: {
  children(api: HostedApiClient, workspace: WorkspaceSummary): React.ReactNode;
}) {
  useEffect(() => appLoader.dismiss(), []);
  const session = authClient.useSession();
  const invitationToken = parseInvitationToken(location.pathname);
  const workspaceRoute = parseWorkspaceRoute(location.pathname);
  if (session.isPending) return <HostedStatus>Loading your account…</HostedStatus>;
  if (!session.data) return <AuthScreen invitation={invitationToken !== null} />;
  if (invitationToken) return <InvitationRedeemer token={invitationToken} />;
  if (!workspaceRoute) return <WorkspaceDashboard />;
  return (
    <WorkspaceLoader workspaceId={workspaceRoute.workspaceId}>
      {(workspace) =>
        workspaceRoute.settings ? (
          <HostedSharing api={api} workspace={workspace} />
        ) : (
          children(api, workspace)
        )
      }
    </WorkspaceLoader>
  );
}

function AuthScreen({ invitation = false }: { invitation?: boolean }) {
  const resetToken = new URLSearchParams(location.search).get("token");
  const [mode, setMode] = useState<AuthMode>(() =>
    resetToken ? "reset-password" : authModeFromPath(location.pathname),
  );
  const [emailAddress, setEmailAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() => {
    const query = new URLSearchParams(location.search);
    if (query.has("verified")) return "Email verified. Your hosted account is ready.";
    if (query.has("passwordReset")) return "Password updated. Sign in with your new password.";
    if (query.has("error")) return "That account link is invalid or has expired.";
    return null;
  });
  const [submitting, setSubmitting] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileVersion, setTurnstileVersion] = useState(0);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    if (mode === "forgot-password") {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: `${location.origin}/cloud?reset=1`,
      });
      if (result.error) setError(result.error.message ?? "Could not request a reset link");
      else {
        setEmailAddress(email);
        setMode("check-email");
      }
      setSubmitting(false);
      return;
    }
    if (mode === "reset-password") {
      if (!resetToken) {
        setError("That password reset link is invalid or has expired.");
        setSubmitting(false);
        return;
      }
      const confirmation = String(form.get("password-confirmation") ?? "");
      if (password !== confirmation) {
        setError("Passwords do not match.");
        setSubmitting(false);
        return;
      }
      const result = await authClient.resetPassword({
        newPassword: password,
        token: resetToken,
      });
      if (result.error) setError(result.error.message ?? "Could not update your password");
      else {
        history.replaceState(null, "", "/cloud?passwordReset=1");
        setNotice("Password updated. Sign in with your new password.");
        setMode("sign-in");
      }
      setSubmitting(false);
      return;
    }
    if (mode === "sign-up" && TURNSTILE_SITE_KEY && !turnstileToken) {
      setError("Complete the verification before creating your account.");
      setSubmitting(false);
      return;
    }
    const result =
      mode === "sign-in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email(
            {
              callbackURL: `${location.origin}/cloud?verified=1`,
              email,
              name: String(form.get("name") ?? ""),
              password,
            },
            {
              headers: turnstileToken ? { "x-turnstile-token": turnstileToken } : undefined,
            },
          );
    if (result.error) {
      if (mode === "sign-in" && result.error.code === "EMAIL_NOT_VERIFIED") {
        setEmailAddress(email);
        setMode("check-email");
      } else setError(result.error.message ?? "Authentication failed");
      if (mode === "sign-up" && TURNSTILE_SITE_KEY) {
        setTurnstileToken(null);
        setTurnstileVersion((version) => version + 1);
      }
    } else if (mode === "sign-up" && result.data.token === null) {
      setEmailAddress(email);
      setMode("check-email");
    }
    setSubmitting(false);
  };

  const resendVerification = async () => {
    setSubmitting(true);
    setError(null);
    const result = await authClient.sendVerificationEmail({
      callbackURL: `${location.origin}/cloud?verified=1`,
      email: emailAddress,
    });
    if (result.error) setError(result.error.message ?? "Could not resend the verification email");
    else setNotice("A fresh verification link is on its way.");
    setSubmitting(false);
  };

  const title =
    mode === "sign-in"
      ? "Welcome back"
      : mode === "sign-up"
        ? "Create your account"
        : mode === "forgot-password"
          ? "Reset your password"
          : mode === "reset-password"
            ? "Choose a new password"
            : "Check your email";

  return (
    <main className="hosted-shell">
      <section className="hosted-card hosted-auth-card">
        <div className="hosted-brandline">
          <a className="hosted-wordmark" href="/">
            Voidmesh
          </a>
        </div>
        <h1>{title}</h1>
        <p className="hosted-muted">
          {mode === "check-email"
            ? "Follow the secure link we sent you. You can close this page after opening the email."
            : mode === "forgot-password"
              ? "Enter your account email. We will send a link if an account exists."
              : mode === "reset-password"
                ? "Use at least 12 characters. Your existing sessions will be signed out."
                : invitation
                  ? "Sign in or create an account to accept this workspace invitation."
                  : "Sign in to open hosted workspaces. The local canvas remains free and accountless."}
        </p>
        {notice && (
          <p className="hosted-notice" role="status">
            {notice}
          </p>
        )}
        {mode === "check-email" ? (
          <div className="hosted-form">
            {error && (
              <p className="hosted-error" role="alert">
                {error}
              </p>
            )}
            {emailAddress && (
              <Button
                variant="secondary"
                isPending={submitting}
                disabled={submitting}
                type="button"
                onClick={() => void resendVerification()}
              >
                {submitting ? "Sending…" : "Resend verification email"}
              </Button>
            )}
            <Button
              variant="quiet"
              type="button"
              onClick={() => {
                setError(null);
                setNotice(null);
                setMode("sign-in");
              }}
            >
              Back to sign in
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="hosted-form">
            {mode === "sign-up" && (
              <label>
                Name
                <input name="name" autoComplete="name" required maxLength={64} />
              </label>
            )}
            {mode !== "reset-password" && (
              <label>
                Email
                <input name="email" type="email" autoComplete="email" required />
              </label>
            )}
            {mode !== "forgot-password" && (
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  minLength={12}
                  required
                />
              </label>
            )}
            {mode === "reset-password" && (
              <label>
                Confirm password
                <input
                  name="password-confirmation"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
              </label>
            )}
            {error && (
              <p className="hosted-error" role="alert">
                {error}
              </p>
            )}
            {mode === "sign-up" && TURNSTILE_SITE_KEY && (
              <Turnstile
                key={turnstileVersion}
                onToken={setTurnstileToken}
                siteKey={TURNSTILE_SITE_KEY}
              />
            )}
            <Button
              variant="primary"
              isPending={submitting}
              disabled={
                submitting || (mode === "sign-up" && !!TURNSTILE_SITE_KEY && !turnstileToken)
              }
              type="submit"
            >
              {submitting
                ? "Please wait…"
                : mode === "sign-in"
                  ? "Sign in"
                  : mode === "sign-up"
                    ? "Create account"
                    : mode === "forgot-password"
                      ? "Send reset link"
                      : "Update password"}
            </Button>
          </form>
        )}
        {(mode === "sign-in" || mode === "sign-up") && (
          <Button
            className="hosted-mode-toggle"
            variant="quiet"
            type="button"
            onClick={() => {
              setError(null);
              setNotice(null);
              setTurnstileToken(null);
              setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            }}
          >
            {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
          </Button>
        )}
        {mode === "sign-in" && (
          <Button
            className="hosted-mode-toggle"
            variant="quiet"
            type="button"
            onClick={() => {
              setError(null);
              setNotice(null);
              setMode("forgot-password");
            }}
          >
            Forgot password?
          </Button>
        )}
        {(mode === "forgot-password" || mode === "reset-password") && (
          <Button
            className="hosted-mode-toggle"
            variant="quiet"
            type="button"
            onClick={() => {
              history.replaceState(null, "", "/cloud");
              setError(null);
              setNotice(null);
              setMode("sign-in");
            }}
          >
            Back to sign in
          </Button>
        )}
      </section>
    </main>
  );
}

function authModeFromPath(pathname: string): AuthMode {
  if (pathname === "/signup") return "sign-up";
  if (pathname === "/forgot-password") return "forgot-password";
  if (pathname === "/reset-password") return "reset-password";
  return "sign-in";
}

function Turnstile({ onToken, siteKey }: { onToken(token: string | null): void; siteKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    let widgetId: string | null = null;
    const render = () => {
      if (!active || !containerRef.current || !window.turnstile) return;
      widgetId = window.turnstile.render(containerRef.current, {
        action: "signup",
        callback: (token) => onToken(token),
        "error-callback": () => onToken(null),
        "expired-callback": () => onToken(null),
        sitekey: siteKey,
        theme: "auto",
      });
    };
    if (window.turnstile) render();
    else {
      let script = document.querySelector<HTMLScriptElement>("script[data-voidmesh-turnstile]");
      if (!script) {
        script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.dataset.voidmeshTurnstile = "true";
        document.head.append(script);
      }
      script.addEventListener("load", render, { once: true });
    }
    return () => {
      active = false;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [onToken, siteKey]);
  return <div className="hosted-turnstile" ref={containerRef} />;
}

async function loadWorkspaceDashboard(): Promise<{
  account: AccountResponse;
  deletedWorkspaces: readonly WorkspaceSummary[];
  workspaces: readonly WorkspaceSummary[];
}> {
  const [workspaceResponse, deletedResponse, account] = await Promise.all([
    api.listWorkspaces(),
    api.listDeletedWorkspaces(),
    api.getAccount(),
  ]);
  return {
    account,
    deletedWorkspaces: deletedResponse.workspaces,
    workspaces: workspaceResponse.workspaces,
  };
}

function WorkspaceDashboard() {
  const billingKeysRef = useRef<{ checkout: string; portal: string } | null>(null);
  const createAttemptRef = useRef<{ key: string; title: string } | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[] | null>(null);
  const [deletedWorkspaces, setDeletedWorkspaces] = useState<readonly WorkspaceSummary[] | null>(
    null,
  );
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [billingAction, setBillingAction] = useState<"checkout" | "portal" | null>(null);
  const [restoringWorkspaceId, setRestoringWorkspaceId] = useState<WorkspaceId | null>(null);

  const refresh = async () => {
    try {
      const result = await loadWorkspaceDashboard();
      setWorkspaces(result.workspaces);
      setDeletedWorkspaces(result.deletedWorkspaces);
      setAccount(result.account);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const restoreWorkspace = async (workspaceId: WorkspaceId) => {
    setRestoringWorkspaceId(workspaceId);
    setError(null);
    try {
      await api.restoreWorkspace(workspaceId);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRestoringWorkspaceId(null);
    }
  };

  useEffect(() => {
    let active = true;
    void loadWorkspaceDashboard()
      .then((result) => {
        if (!active) return;
        setWorkspaces(result.workspaces);
        setDeletedWorkspaces(result.deletedWorkspaces);
        setAccount(result.account);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    const attempt =
      createAttemptRef.current?.title === title
        ? createAttemptRef.current
        : { key: crypto.randomUUID(), title };
    createAttemptRef.current = attempt;
    try {
      const { workspace } = await api.createWorkspace({ title }, attempt.key);
      location.assign(`/w/${workspace.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
      setCreating(false);
    }
  };

  const openBilling = async (action: "checkout" | "portal") => {
    setBillingAction(action);
    setError(null);
    billingKeysRef.current ??= {
      checkout: crypto.randomUUID(),
      portal: crypto.randomUUID(),
    };
    try {
      const session =
        action === "checkout"
          ? await api.createCheckoutSession(billingKeysRef.current.checkout)
          : await api.createBillingPortalSession(billingKeysRef.current.portal);
      location.assign(session.url);
    } catch (reason) {
      setError(errorMessage(reason));
      setBillingAction(null);
    }
  };

  if ((!workspaces || !account) && !error) return <HostedStatus>Loading workspaces…</HostedStatus>;
  const workspaceLimitReached = account
    ? account.account.ownedWorkspaceCount >= account.account.workspaceLimit
    : false;
  return (
    <main className="hosted-shell">
      <section className="hosted-card hosted-dashboard">
        <header className="hosted-dashboard__header">
          <div className="hosted-dashboard__nav">
            <a className="hosted-wordmark" href="/">
              Voidmesh
            </a>
            <Button
              variant="quiet"
              size="sm"
              type="button"
              onClick={() => void authClient.signOut()}
            >
              Sign out
            </Button>
          </div>
          <div className="hosted-dashboard__title">
            <h1>Cloud workspaces</h1>
            {!workspaceLimitReached && workspaces?.length !== 0 && (
              <Button
                variant="primary"
                size="sm"
                type="button"
                aria-expanded={showCreate || workspaces?.length === 0}
                onClick={() => setShowCreate((visible) => !visible)}
              >
                {showCreate ? "Cancel" : "Create workspace"}
              </Button>
            )}
          </div>
        </header>
        {error && (
          <p className="hosted-error" role="alert">
            {error}
          </p>
        )}
        {!workspaceLimitReached && (showCreate || workspaces?.length === 0) && (
          <form className="hosted-create" onSubmit={createWorkspace}>
            <label>
              Workspace name
              <input
                name="title"
                defaultValue="Untitled workspace"
                required
                maxLength={120}
                autoFocus={showCreate}
              />
            </label>
            <Button variant="primary" isPending={creating} disabled={creating} type="submit">
              {creating ? "Creating…" : "Create"}
            </Button>
          </form>
        )}
        <div className="hosted-workspaces">
          {workspaces?.map((workspace) => (
            <div className="hosted-workspace" key={workspace.id}>
              <a href={`/w/${workspace.id}`}>
                <span>{workspace.title}</span>
                <small>
                  {workspace.role} · {formatBytes(workspace.usedBytes)}
                  {workspace.overQuota ? " · over quota" : ""}
                </small>
              </a>
              <a className="hosted-workspace__manage" href={`/w/${workspace.id}/settings`}>
                Manage
              </a>
            </div>
          ))}
          {workspaces?.length === 0 && (
            <div className="hosted-empty">
              <strong>Your first workspace is free</strong>
              <p className="hosted-muted">Name it above to start a new canvas.</p>
            </div>
          )}
        </div>
        {account && (
          <AccountUsage billingAction={billingAction} onBilling={openBilling} response={account} />
        )}
        {deletedWorkspaces && deletedWorkspaces.length > 0 && (
          <section className="hosted-recovery" aria-labelledby="recently-deleted-heading">
            <div>
              <h2 id="recently-deleted-heading">Recently deleted</h2>
              <p className="hosted-muted">Workspaces can be restored for 30 days.</p>
            </div>
            <div className="hosted-sharing__list">
              {deletedWorkspaces.map((workspace) => (
                <div className="hosted-sharing__row" key={workspace.id}>
                  <div>
                    <strong>{workspace.title}</strong>
                    <small>Permanently deleted {formatRecoveryDate(workspace.purgeAfter)}</small>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={restoringWorkspaceId !== null}
                    isPending={restoringWorkspaceId === workspace.id}
                    onClick={() => void restoreWorkspace(workspace.id)}
                  >
                    {restoringWorkspaceId === workspace.id ? "Restoring…" : "Restore"}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}
        {workspaceLimitReached ? (
          <div className="hosted-limit-message">
            <div>
              <strong>Workspace limit reached</strong>
              <p className="hosted-muted">Upgrade your plan to create more hosted workspaces.</p>
            </div>
            <Button
              variant="primary"
              size="sm"
              type="button"
              disabled={!account?.billingAvailable || billingAction !== null}
              isPending={billingAction === "checkout"}
              onClick={() => void openBilling("checkout")}
              title={account?.billingAvailable ? undefined : "Stripe billing is not configured"}
            >
              {billingAction === "checkout" ? "Opening…" : "Upgrade"}
            </Button>
          </div>
        ) : null}
        <AccountDeletion />
      </section>
    </main>
  );
}

function AccountDeletion() {
  const isMobile = useIsMobile();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const close = () => {
    if (deleting) return;
    setConfirming(false);
    setError(null);
  };
  const confirmationForm = (
    <form className="hosted-account-delete__form" onSubmit={deleteAccount}>
      <label>
        Confirm your password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && (
        <p className="hosted-error" role="alert">
          {error}
        </p>
      )}
      <div className="hosted-confirmation-actions">
        <Button variant="destructive" type="submit" disabled={deleting} isPending={deleting}>
          {deleting ? "Deleting…" : "Permanently delete account"}
        </Button>
        <Button variant="secondary" type="button" disabled={deleting} onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );

  return (
    <section className="hosted-account-delete" aria-labelledby="delete-account-heading">
      <div>
        <h2 id="delete-account-heading">Delete account</h2>
        <p className="hosted-muted">
          This signs you out everywhere, cancels Pro, and schedules owned workspaces for permanent
          deletion after 30 days.
        </p>
      </div>
      {isMobile ? (
        <Drawer.Root
          open={confirming}
          onOpenChange={(open) => {
            if (!deleting) setConfirming(open);
          }}
        >
          <Drawer.Trigger
            render={(props) => (
              <Button {...props} variant="destructive" type="button">
                Delete account…
              </Button>
            )}
          />
          <Drawer.Popup className="hosted-confirmation-drawer">
            <Drawer.Title>Delete account?</Drawer.Title>
            <Drawer.Content className="hosted-confirmation-drawer__content">
              <p className="hosted-muted">
                Enter your password to permanently delete the account after its 30-day recovery
                window.
              </p>
              {confirmationForm}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Root>
      ) : confirming ? (
        confirmationForm
      ) : (
        <Button variant="destructive" type="button" onClick={() => setConfirming(true)}>
          Delete account…
        </Button>
      )}
    </section>
  );
}

function AccountUsage({
  billingAction,
  onBilling,
  response,
}: {
  billingAction: "checkout" | "portal" | null;
  onBilling(action: "checkout" | "portal"): Promise<void>;
  response: AccountResponse;
}) {
  const { account, subscription } = response;
  return (
    <section className="hosted-plan" aria-label="Current hosted plan">
      <div className="hosted-plan__header">
        <div>
          <strong>{account.planKey === "pro" ? "Voidmesh Pro" : "Free plan"}</strong>
          <p className="hosted-muted">
            {account.ownedWorkspaceCount} of {account.workspaceLimit} workspaces
          </p>
        </div>
        <p className="hosted-plan__access">
          {account.canEditCollaborate
            ? "People you invite can view or edit"
            : "People you invite can view"}
        </p>
      </div>
      <div className="hosted-plan__usage">
        <progress
          aria-label="Account storage used"
          max={account.storageLimitBytes}
          value={account.ownedStorageBytes}
        />
        <small>
          {formatBytes(account.ownedStorageBytes)} of {formatBytes(account.storageLimitBytes)} used
        </small>
      </div>
      {subscription?.cancelAtPeriodEnd && subscription.currentPeriodEndsAt && (
        <p className="hosted-muted">
          Pro access ends {new Date(subscription.currentPeriodEndsAt).toLocaleDateString()}.
        </p>
      )}
      <div className="hosted-plan__actions">
        {subscription ? (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={!response.billingAvailable || billingAction !== null}
            isPending={billingAction === "portal"}
            onClick={() => void onBilling("portal")}
          >
            {billingAction === "portal" ? "Opening…" : "Manage billing"}
          </Button>
        ) : response.billingAvailable ? (
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={billingAction !== null}
            isPending={billingAction === "checkout"}
            onClick={() => void onBilling("checkout")}
          >
            {billingAction === "checkout" ? "Opening…" : "Upgrade to Pro"}
          </Button>
        ) : (
          <small className="hosted-muted">Pro upgrades aren’t available in this local build.</small>
        )}
      </div>
    </section>
  );
}

function InvitationRedeemer({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .redeemInvitation(token)
      .then(({ workspace }) => {
        if (active) location.replace(`/w/${workspace.id}`);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [token]);
  return error ? (
    <HostedStatus error={error} />
  ) : (
    <HostedStatus>Accepting workspace invitation…</HostedStatus>
  );
}

function WorkspaceLoader({
  children,
  workspaceId,
}: {
  children(workspace: WorkspaceSummary): React.ReactNode;
  workspaceId: WorkspaceId;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .getWorkspace(workspaceId)
      .then((response) => {
        if (active) setWorkspace(response.workspace);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);
  if (error) return <HostedStatus error={error} />;
  if (!workspace) return <HostedStatus>Opening workspace…</HostedStatus>;
  return children(workspace);
}

function HostedStatus({ children, error }: PropsWithChildren<{ error?: string }>) {
  return (
    <main className="hosted-shell">
      <section className="hosted-card hosted-status">
        <a className="hosted-wordmark" href="/">
          Voidmesh
        </a>
        <p className={error ? "hosted-error" : "hosted-muted"}>{error ?? children}</p>
        {error && <a href="/cloud">Back to workspaces</a>}
      </section>
    </main>
  );
}

function parseWorkspaceRoute(
  pathname: string,
): { settings: boolean; workspaceId: WorkspaceId } | null {
  const match = pathname.match(/^\/w\/([A-Za-z0-9_-]{1,128})(\/settings)?\/?$/);
  const workspaceId = match?.[1] as WorkspaceId | undefined;
  return workspaceId ? { settings: match?.[2] === "/settings", workspaceId } : null;
}

function parseInvitationToken(pathname: string): string | null {
  return pathname.match(/^\/invite\/([A-Za-z0-9_-]{43})\/?$/)?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostedApiError || error instanceof Error) return error.message;
  return "Something went wrong";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GB`;
}

function formatRecoveryDate(timestamp: number | null): string {
  return timestamp === null
    ? "after the recovery window"
    : new Date(timestamp).toLocaleDateString();
}
