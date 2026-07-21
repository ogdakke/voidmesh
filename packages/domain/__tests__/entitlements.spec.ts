import { describe, expect, it } from "vitest";
import {
  canEditWorkspace,
  canInviteRole,
  CLOUD_FREE_ENTITLEMENTS,
  effectiveWorkspaceRole,
  PlanFeature,
  WorkspaceRole,
} from "../src/index.ts";

describe("hosted workspace entitlements", () => {
  it("allows view sharing but not edit collaboration on Cloud Free", () => {
    expect(canInviteRole(CLOUD_FREE_ENTITLEMENTS, WorkspaceRole.viewer)).toBe(true);
    expect(canInviteRole(CLOUD_FREE_ENTITLEMENTS, WorkspaceRole.editor)).toBe(false);
  });

  it("allows paid plans to grant editor invitations", () => {
    const paid = {
      ...CLOUD_FREE_ENTITLEMENTS,
      features: new Set([...CLOUD_FREE_ENTITLEMENTS.features, PlanFeature.editCollaboration]),
    };

    expect(canInviteRole(paid, WorkspaceRole.editor)).toBe(true);
  });

  it("keeps viewer permissions read-only", () => {
    expect(canEditWorkspace(WorkspaceRole.owner)).toBe(true);
    expect(canEditWorkspace(WorkspaceRole.editor)).toBe(true);
    expect(canEditWorkspace(WorkspaceRole.viewer)).toBe(false);
  });

  it("downgrades editor membership when paid collaboration is unavailable", () => {
    expect(effectiveWorkspaceRole(WorkspaceRole.editor, false)).toBe(WorkspaceRole.viewer);
    expect(effectiveWorkspaceRole(WorkspaceRole.editor, true)).toBe(WorkspaceRole.editor);
    expect(effectiveWorkspaceRole(WorkspaceRole.owner, false)).toBe(WorkspaceRole.owner);
  });
});
