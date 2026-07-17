import type {
  InvitationLinkSummary,
  WorkspaceExportSummary,
  WorkspaceMember,
  WorkspaceSummary,
} from "@voidmesh/api-contract";
import { WorkspaceRole, type InvitationId, type UserId } from "@voidmesh/domain";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "#ui/button/index.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { HostedApiClient, HostedApiError } from "#lib/hosted-api-client.ts";

interface HostedSharingProps {
  api: HostedApiClient;
  workspace: WorkspaceSummary;
}

export function HostedSharing({ api, workspace }: HostedSharingProps) {
  const isMobile = useIsMobile();
  const exportKeyRef = useRef<string | null>(null);
  const invitationKeysRef = useRef<Map<"viewer" | "editor", string> | null>(null);
  const isOwner = workspace.role === WorkspaceRole.owner;
  const [members, setMembers] = useState<readonly WorkspaceMember[] | null>(null);
  const [invitations, setInvitations] = useState<readonly InvitationLinkSummary[] | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTitle, setCurrentTitle] = useState(workspace.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [invitationOpen, setInvitationOpen] = useState(false);
  const [linkPermission, setLinkPermission] = useState<"viewer" | "editor">("viewer");
  const [workspaceExport, setWorkspaceExport] = useState<WorkspaceExportSummary | null>(null);

  const refresh = async () => {
    try {
      const [memberResponse, invitationResponse] = await Promise.all([
        api.listMembers(workspace.id),
        isOwner ? api.listInvitations(workspace.id) : Promise.resolve(null),
      ]);
      setMembers(memberResponse.members);
      setInvitations(invitationResponse?.invitations ?? []);
    } catch (reason) {
      setError(errorMessage(reason));
    }
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
  }, [api, workspace.id, isOwner]);

  const createInvitation = async (role: "viewer" | "editor") => {
    setPendingAction(`create-${role}`);
    setError(null);
    invitationKeysRef.current ??= new Map();
    let idempotencyKey = invitationKeysRef.current.get(role);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      invitationKeysRef.current.set(role, idempotencyKey);
    }
    try {
      const { invitation } = await api.createInvitation(workspace.id, { role }, idempotencyKey);
      setCreatedLink(`${location.origin}/invite/${invitation.token}`);
      setInvitationOpen(false);
      await refresh();
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
      setCreatedLink(null);
      await refresh();
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
      await refresh();
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
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  const renameWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (title === currentTitle) return;
    setPendingAction("rename");
    setError(null);
    try {
      const response = await api.updateWorkspace(workspace.id, title);
      setCurrentTitle(response.workspace.title);
    } catch (reason) {
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

  const closeDeleteConfirmation = () => {
    if (pendingAction === "delete") return;
    setConfirmingDelete(false);
  };

  const deleteActions = (
    <div className="hosted-confirmation-actions">
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
        onClick={closeDeleteConfirmation}
      >
        Cancel
      </Button>
    </div>
  );

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
        if (response.export.state === "failed") {
          exportKeyRef.current = crypto.randomUUID();
          throw new Error("The workspace export could not be created.");
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        response = await api.getWorkspaceExport(workspace.id, response.export.id);
        setWorkspaceExport(response.export);
      }
      throw new Error("The workspace export is taking longer than expected.");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <main className="hosted-shell">
      <section className="hosted-card hosted-dashboard hosted-sharing">
        <header className="hosted-dashboard__header">
          <div>
            <a className="hosted-wordmark" href="/cloud">
              Voidmesh
            </a>
            <h1>{currentTitle}</h1>
            <p className="hosted-muted">People and sharing</p>
          </div>
          <Button
            variant="secondary"
            type="button"
            onClick={() => location.assign(`/w/${workspace.id}`)}
          >
            Open canvas
          </Button>
        </header>

        {error && (
          <p className="hosted-error" role="alert">
            {error}
          </p>
        )}

        {workspace.role !== WorkspaceRole.viewer && (
          <section className="hosted-sharing__section" aria-labelledby="export-heading">
            <div className="hosted-sharing__heading">
              <div>
                <h2 id="export-heading">Export a copy</h2>
                <p className="hosted-muted">
                  Download a portable .vdmsh file with the current canvas and its original media.
                </p>
              </div>
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
          </section>
        )}

        {isOwner && (
          <section className="hosted-sharing__section" aria-labelledby="workspace-heading">
            <div className="hosted-sharing__heading">
              <div>
                <h2 id="workspace-heading">Workspace</h2>
                <p className="hosted-muted">Change its name or move it to recently deleted.</p>
              </div>
            </div>
            <form className="hosted-rename" onSubmit={renameWorkspace}>
              <label>
                Workspace name
                <input name="title" defaultValue={currentTitle} required maxLength={120} />
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
            <div className="hosted-danger-zone">
              <div>
                <strong>Delete workspace</strong>
                <p className="hosted-muted">
                  Access stops immediately. You can restore it for 30 days.
                </p>
              </div>
              {isMobile ? (
                <Drawer.Root
                  open={confirmingDelete}
                  onOpenChange={(open) => {
                    if (pendingAction !== "delete") setConfirmingDelete(open);
                  }}
                >
                  <Drawer.Trigger
                    render={(props) => (
                      <Button {...props} variant="destructive" type="button">
                        Delete workspace…
                      </Button>
                    )}
                  />
                  <Drawer.Popup className="hosted-confirmation-drawer">
                    <Drawer.Title>Delete workspace?</Drawer.Title>
                    <Drawer.Content className="hosted-confirmation-drawer__content">
                      <p className="hosted-muted">
                        Access stops immediately. You can restore this workspace for 30 days.
                      </p>
                      {deleteActions}
                    </Drawer.Content>
                  </Drawer.Popup>
                </Drawer.Root>
              ) : confirmingDelete ? (
                deleteActions
              ) : (
                <Button
                  variant="destructive"
                  type="button"
                  disabled={pendingAction !== null}
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete…
                </Button>
              )}
            </div>
          </section>
        )}

        {isOwner && (
          <section className="hosted-sharing__section" aria-labelledby="invite-heading">
            <div className="hosted-sharing__heading">
              <div>
                <h2 id="invite-heading">Invitation links</h2>
                <p className="hosted-muted">Links remain active until you revoke them.</p>
              </div>
              <Drawer.Root
                open={invitationOpen}
                onOpenChange={(open) => {
                  if (!pendingAction?.startsWith("create-")) setInvitationOpen(open);
                }}
              >
                <Drawer.Trigger
                  render={(props) => (
                    <Button {...props} variant="primary" size="md" type="button">
                      Create invitation link
                    </Button>
                  )}
                />
                <Drawer.Popup className="hosted-invitation-drawer">
                  <Drawer.Title>Create invitation link</Drawer.Title>
                  <Drawer.Content className="hosted-invitation-drawer__content">
                    <fieldset className="hosted-link-permissions">
                      <legend>Link permissions</legend>
                      <label>
                        <input
                          type="radio"
                          name="link-permission"
                          aria-label="Can view"
                          value={WorkspaceRole.viewer}
                          checked={linkPermission === WorkspaceRole.viewer}
                          onChange={() => setLinkPermission(WorkspaceRole.viewer)}
                        />
                        <span>
                          <strong>Can view</strong>
                          <small>Open the canvas and see live cursors and selections.</small>
                        </span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="link-permission"
                          aria-label="Can edit"
                          value={WorkspaceRole.editor}
                          checked={linkPermission === WorkspaceRole.editor}
                          onChange={() => setLinkPermission(WorkspaceRole.editor)}
                        />
                        <span>
                          <strong>Can edit</strong>
                          <small>Change the canvas and its workspace assets.</small>
                        </span>
                      </label>
                    </fieldset>
                    <div className="hosted-confirmation-actions">
                      <Button
                        variant="primary"
                        type="button"
                        isPending={pendingAction === `create-${linkPermission}`}
                        disabled={pendingAction !== null}
                        onClick={() => void createInvitation(linkPermission)}
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
            </div>

            {createdLink && (
              <div className="hosted-created-link">
                <div>
                  <strong>Copy this link now</strong>
                  <p className="hosted-muted">For security, the secret will not be shown again.</p>
                </div>
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

            <div className="hosted-sharing__list">
              {invitations?.map((invitation) => (
                <div className="hosted-sharing__row" key={invitation.id}>
                  <div>
                    <strong>{invitation.role} link</strong>
                    <small>
                      {invitation.revokedAt ? "Revoked" : "Active"} · used {invitation.useCount}{" "}
                      {invitation.useCount === 1 ? "time" : "times"}
                    </small>
                  </div>
                  {!invitation.revokedAt && (
                    <Button
                      variant="quiet"
                      type="button"
                      isPending={pendingAction === `revoke-${invitation.id}`}
                      disabled={pendingAction !== null}
                      onClick={() => void revokeInvitation(invitation.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              ))}
              {invitations?.length === 0 && (
                <p className="hosted-empty">No invitation links yet.</p>
              )}
            </div>
          </section>
        )}

        <section className="hosted-sharing__section" aria-labelledby="members-heading">
          <div className="hosted-sharing__heading">
            <div>
              <h2 id="members-heading">Members</h2>
              <p className="hosted-muted">Everyone here can see live cursors and selections.</p>
            </div>
          </div>
          <div className="hosted-sharing__list">
            {members?.map((member) => (
              <div className="hosted-sharing__row hosted-member" key={member.userId}>
                <div className="hosted-member__identity">
                  <strong>{member.name}</strong>
                  <small>{member.email.toLocaleLowerCase()}</small>
                </div>
                {isOwner && member.role !== WorkspaceRole.owner ? (
                  <div className="hosted-sharing__actions">
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
                      isPending={pendingAction === `member-${member.userId}`}
                      disabled={pendingAction !== null}
                      onClick={() => void removeMember(member.userId)}
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <small className="hosted-member__role">{member.role}</small>
                )}
              </div>
            ))}
            {!members && !error && <p className="hosted-empty">Loading members…</p>}
          </div>
        </section>
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof HostedApiError || error instanceof Error) return error.message;
  return "Something went wrong";
}
