import type {
  InvitationLinkSummary,
  WorkspaceExportSummary,
  WorkspaceMember,
} from "@voidmesh/api-contract";
import {
  WorkspaceRole,
  type InvitationId,
  type UserId,
  type WorkspaceRole as WorkspaceRoleValue,
} from "@voidmesh/domain";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { useHostedWorkspaceRuntime } from "#context/hosted-workspace-runtime.tsx";
import { Button } from "#ui/button/index.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { HostedApiError } from "#lib/hosted-api-client.ts";

export default function HostedWorkspaceSettings({
  runtime,
}: {
  runtime: NonNullable<ReturnType<typeof useHostedWorkspaceRuntime>>;
}) {
  const { api, workspace } = runtime;
  const isOwner = workspace.role === WorkspaceRole.owner;
  const canExport = workspace.role !== WorkspaceRole.viewer;
  const [title, setTitle] = useState(workspace.title);
  const [members, setMembers] = useState<readonly WorkspaceMember[] | null>(null);
  const [invitations, setInvitations] = useState<readonly InvitationLinkSummary[] | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [linkPermission, setLinkPermission] = useState<"viewer" | "editor">("viewer");
  const [invitationOpen, setInvitationOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceExport, setWorkspaceExport] = useState<WorkspaceExportSummary | null>(null);
  const invitationKeysRef = useRef<Map<"viewer" | "editor", string> | null>(null);
  const exportKeyRef = useRef<string | null>(null);

  const refreshPeople = async () => {
    const [memberResponse, invitationResponse] = await Promise.all([
      api.listMembers(workspace.id),
      isOwner ? api.listInvitations(workspace.id) : Promise.resolve(null),
    ]);
    setMembers(memberResponse.members);
    setInvitations(invitationResponse?.invitations ?? []);
  };

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.listMembers(workspace.id),
      isOwner ? api.listInvitations(workspace.id) : Promise.resolve(null),
    ])
      .then(([memberResponse, invitationResponse]) => {
        if (!active) return;
        setMembers(memberResponse.members);
        setInvitations(invitationResponse?.invitations ?? []);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [api, isOwner, workspace.id]);

  const renameWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTitle = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (!nextTitle || nextTitle === title) return;
    setPendingAction("rename");
    setError(null);
    try {
      const response = await api.updateWorkspace(workspace.id, nextTitle);
      setTitle(response.workspace.title);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  const createInvitation = async () => {
    setPendingAction(`create-${linkPermission}`);
    setError(null);
    invitationKeysRef.current ??= new Map();
    let key = invitationKeysRef.current.get(linkPermission);
    if (!key) {
      key = crypto.randomUUID();
      invitationKeysRef.current.set(linkPermission, key);
    }
    try {
      const response = await api.createInvitation(workspace.id, { role: linkPermission }, key);
      setCreatedLink(`${location.origin}/invite/${response.invitation.token}`);
      setInvitationOpen(false);
      await refreshPeople();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  const revokeInvitation = async (invitationId: InvitationId) => {
    setPendingAction(`revoke-${invitationId}`);
    setError(null);
    try {
      await api.revokeInvitation(workspace.id, invitationId);
      await refreshPeople();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  const updateMember = async (userId: UserId, role: "viewer" | "editor") => {
    setPendingAction(`member-${userId}`);
    setError(null);
    try {
      await api.updateMember(workspace.id, userId, { role });
      await refreshPeople();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  const removeMember = async (userId: UserId) => {
    setPendingAction(`member-${userId}`);
    setError(null);
    try {
      await api.removeMember(workspace.id, userId);
      await refreshPeople();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  const exportWorkspace = async () => {
    setPendingAction("export");
    setError(null);
    exportKeyRef.current ??= crypto.randomUUID();
    try {
      let response = await api.createWorkspaceExport(workspace.id, exportKeyRef.current);
      setWorkspaceExport(response.export);
      for (let attempt = 0; attempt < 240; attempt++) {
        if (response.export.state === "completed") {
          api.downloadWorkspaceExport(workspace.id, response.export.id, response.export.filename);
          return;
        }
        if (response.export.state === "failed") throw new Error("The export could not be created.");
        await new Promise((resolve) => setTimeout(resolve, 500));
        response = await api.getWorkspaceExport(workspace.id, response.export.id);
        setWorkspaceExport(response.export);
      }
      throw new Error("The export is taking longer than expected.");
    } catch (reason) {
      exportKeyRef.current = crypto.randomUUID();
      setError(errorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  const deleteWorkspace = async () => {
    setPendingAction("delete");
    setError(null);
    try {
      await api.deleteWorkspace(workspace.id);
      location.assign("/cloud");
    } catch (reason) {
      setError(errorMessage(reason));
      setPendingAction(null);
    }
  };

  return (
    <>
      <section id="workspace-settings-workspace" className="settings-workspace-page">
        <PageHeading kicker="Workspace" title={title} />
        <dl className="settings-workspace-facts">
          <div>
            <dt>Access</dt>
            <dd>{roleLabel(workspace.role)}</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>
              {formatBytes(workspace.usedBytes)} of {formatBytes(workspace.storageLimitBytes)}
            </dd>
          </div>
        </dl>
        <progress
          aria-label="Workspace storage used"
          max={workspace.storageLimitBytes}
          value={workspace.usedBytes}
        />
        {workspace.overQuota && (
          <p className="settings-page-error">
            This workspace is over quota. New uploads are paused.
          </p>
        )}
        {isOwner && (
          <form className="settings-workspace-form" onSubmit={renameWorkspace}>
            <label>
              Workspace name
              <input name="title" defaultValue={title} required maxLength={120} />
            </label>
            <Button
              variant="secondary"
              type="submit"
              disabled={pendingAction !== null}
              isPending={pendingAction === "rename"}
            >
              {pendingAction === "rename" ? "Saving…" : "Save name"}
            </Button>
          </form>
        )}
        <Button
          variant="secondary"
          type="button"
          onClick={() => location.assign(`/w/${workspace.id}/settings`)}
        >
          Open full workspace settings
        </Button>
      </section>

      <section id="workspace-settings-sharing" className="settings-workspace-page">
        <PageHeading kicker="Sharing" title="People and links" />
        <p className="settings-page-muted">
          Everyone here can see live cursors and selections while the canvas is open.
        </p>
        {error && (
          <p className="settings-page-error" role="alert">
            {error}
          </p>
        )}
        {isOwner && (
          <>
            <Drawer.Root
              open={invitationOpen}
              onOpenChange={(open) => {
                if (!pendingAction?.startsWith("create-")) setInvitationOpen(open);
              }}
            >
              <Drawer.Trigger
                render={(props) => (
                  <Button {...props} variant="primary" type="button">
                    Create invitation link
                  </Button>
                )}
              />
              <Drawer.Popup className="settings-action-drawer">
                <Drawer.Title>Create invitation link</Drawer.Title>
                <Drawer.Content className="settings-action-drawer__content">
                  <PermissionPicker value={linkPermission} onChange={setLinkPermission} />
                  <div className="settings-action-buttons">
                    <Button
                      variant="primary"
                      type="button"
                      disabled={pendingAction !== null}
                      isPending={pendingAction === `create-${linkPermission}`}
                      onClick={() => void createInvitation()}
                    >
                      {pendingAction === `create-${linkPermission}` ? "Creating…" : "Create link"}
                    </Button>
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={pendingAction !== null}
                      onClick={() => setInvitationOpen(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </Drawer.Content>
              </Drawer.Popup>
            </Drawer.Root>
            {createdLink && (
              <div className="settings-created-link">
                <strong>Invitation link</strong>
                <code>{createdLink}</code>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(createdLink)}
                >
                  Copy link
                </Button>
              </div>
            )}
            <SettingsList title="Invitation links">
              {invitations === null ? (
                <LoadingRows />
              ) : invitations.length === 0 ? (
                <p className="settings-page-muted">No invitation links yet.</p>
              ) : (
                invitations.map((invitation) => (
                  <div className="settings-list-row" key={invitation.id}>
                    <span>
                      <strong>{roleLabel(invitation.role)} link</strong>
                      <small>
                        {invitation.revokedAt ? "Revoked" : "Active"} · used {invitation.useCount}{" "}
                        {invitation.useCount === 1 ? "time" : "times"}
                      </small>
                    </span>
                    {!invitation.revokedAt && (
                      <Button
                        variant="quiet"
                        type="button"
                        disabled={pendingAction !== null}
                        isPending={pendingAction === `revoke-${invitation.id}`}
                        onClick={() => void revokeInvitation(invitation.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                ))
              )}
            </SettingsList>
          </>
        )}
        <SettingsList title="Members">
          {members === null ? (
            <LoadingRows />
          ) : (
            members.map((member) => (
              <div className="settings-list-row settings-member-row" key={member.userId}>
                <span>
                  <strong>{member.name}</strong>
                  <small>{member.email.toLocaleLowerCase()}</small>
                </span>
                {isOwner && member.role !== WorkspaceRole.owner ? (
                  <span className="settings-member-actions">
                    <select
                      aria-label={`Role for ${member.name}`}
                      value={member.role}
                      disabled={pendingAction !== null}
                      onChange={(event) =>
                        void updateMember(
                          member.userId,
                          event.currentTarget.value as "viewer" | "editor",
                        )
                      }
                    >
                      <option value={WorkspaceRole.viewer}>Viewer</option>
                      <option value={WorkspaceRole.editor}>Editor</option>
                    </select>
                    <Button
                      variant="quiet"
                      type="button"
                      disabled={pendingAction !== null}
                      isPending={pendingAction === `member-${member.userId}`}
                      onClick={() => void removeMember(member.userId)}
                    >
                      Remove
                    </Button>
                  </span>
                ) : (
                  <small>{roleLabel(member.role)}</small>
                )}
              </div>
            ))
          )}
        </SettingsList>
      </section>

      {canExport && (
        <section id="workspace-settings-transfer" className="settings-workspace-page">
          <PageHeading kicker="Transfer" title="Export and lifecycle" />
          <div className="settings-action-section">
            <h4>Export a copy</h4>
            <p className="settings-page-muted">
              Download the current canvas and its original media as a portable .vdmsh file.
            </p>
            <Button
              variant="secondary"
              type="button"
              disabled={pendingAction !== null}
              isPending={pendingAction === "export"}
              onClick={() => void exportWorkspace()}
            >
              {pendingAction === "export"
                ? workspaceExport?.state === "processing"
                  ? "Packaging…"
                  : "Preparing…"
                : "Download .vdmsh"}
            </Button>
          </div>
          {isOwner && (
            <div className="settings-action-section settings-danger-section">
              <h4>Delete workspace</h4>
              <p className="settings-page-muted">
                Access stops immediately. You can restore it from Cloud workspaces for 30 days.
              </p>
              <Drawer.Root
                open={deleteOpen}
                onOpenChange={(open) => {
                  if (pendingAction !== "delete") setDeleteOpen(open);
                }}
              >
                <Drawer.Trigger
                  render={(props) => (
                    <Button {...props} variant="destructive" type="button">
                      Delete workspace…
                    </Button>
                  )}
                />
                <Drawer.Popup className="settings-action-drawer">
                  <Drawer.Title>Delete workspace?</Drawer.Title>
                  <Drawer.Content className="settings-action-drawer__content">
                    <p className="settings-page-muted">
                      This moves the workspace to recently deleted and disconnects every member.
                    </p>
                    <div className="settings-action-buttons">
                      <Button
                        variant="destructive"
                        type="button"
                        disabled={pendingAction !== null}
                        isPending={pendingAction === "delete"}
                        onClick={() => void deleteWorkspace()}
                      >
                        {pendingAction === "delete" ? "Deleting…" : "Move to recently deleted"}
                      </Button>
                      <Button
                        variant="secondary"
                        type="button"
                        disabled={pendingAction !== null}
                        onClick={() => setDeleteOpen(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </Drawer.Content>
                </Drawer.Popup>
              </Drawer.Root>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function PageHeading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <header className="settings-page-heading">
      <span className="settings-page-kicker">{kicker}</span>
      <h3>{title}</h3>
    </header>
  );
}

function SettingsList({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="settings-list" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function LoadingRows() {
  return (
    <div className="settings-loading-rows" aria-label="Loading">
      <span />
      <span />
    </div>
  );
}

function PermissionPicker({
  onChange,
  value,
}: {
  onChange(value: "viewer" | "editor"): void;
  value: "viewer" | "editor";
}) {
  return (
    <fieldset className="settings-permissions">
      <legend>Link permissions</legend>
      <label>
        <input
          aria-label="Can view"
          type="radio"
          name="settings-link-permission"
          checked={value === WorkspaceRole.viewer}
          onChange={() => onChange(WorkspaceRole.viewer)}
        />
        <span>
          <strong>Can view</strong>
          <small>Open the canvas and see live cursors and selections.</small>
        </span>
      </label>
      <label>
        <input
          aria-label="Can edit"
          type="radio"
          name="settings-link-permission"
          checked={value === WorkspaceRole.editor}
          onChange={() => onChange(WorkspaceRole.editor)}
        />
        <span>
          <strong>Can edit</strong>
          <small>Change the canvas and its workspace assets.</small>
        </span>
      </label>
    </fieldset>
  );
}

function roleLabel(role: WorkspaceRoleValue): string {
  if (role === WorkspaceRole.owner) return "Owner";
  if (role === WorkspaceRole.editor) return "Can edit";
  return "Can view";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
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
