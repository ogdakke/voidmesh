import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasStore } from "#engine";
import type { CollaborationService } from "#context/collaboration-service.ts";
import {
  createCollaborativeEntity,
  type CollaborationInvite,
} from "#lib/collaboration/protocol.ts";
import { getEntityThumbhash } from "#lib/thumbhash.ts";
import { undo } from "#lib/undo.ts";
import { MediaType } from "#types/canvas.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { createEntityInput } from "../helpers/test-entity.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { clearUndoHistory } from "../helpers/undo-helpers.ts";

type CanvasAdapter = Parameters<CollaborationService["configure"]>[0];

const collaborationState = vi.hoisted(() => ({
  adapter: null as CanvasAdapter | null,
}));

vi.mock("#context/collaboration-service.ts", () => ({
  collaborationService: {
    configure: vi.fn<(adapter: CanvasAdapter) => () => void>((adapter) => {
      collaborationState.adapter = adapter;
      return () => {
        if (collaborationState.adapter === adapter) collaborationState.adapter = null;
      };
    }),
    start: vi.fn<(invite: CollaborationInvite) => Promise<void>>(async () => undefined),
    stop: vi.fn<() => void>(),
    createEntityId: vi.fn<(fallback: () => string) => string>((fallback) => fallback()),
    invite: null,
    isActive: false,
  },
}));

const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

let cleanupCanvas: () => void;

beforeEach(() => {
  cleanupCanvas = setupCanvasTest();
  clearUndoHistory();
  collaborationState.adapter = null;
});

afterEach(() => {
  clearUndoHistory();
  cleanupCanvas();
});

describe("collaborative undo", () => {
  it("keeps local commands undoable after a remote projection", async () => {
    const rendered = renderWithCanvas(undefined, { skip: skipProviders });
    await waitFor(() => expect(collaborationState.adapter).not.toBeNull());
    let entityId = "";
    act(() => {
      entityId = rendered.canvas.addEntity(createEntityInput());
    });
    clearUndoHistory();
    act(() => rendered.canvas.updateEntity(entityId, { locked: true }));
    expect(undo.canUndo()).toBe(true);

    const entity = canvasStore.getState().entities.get(entityId)!;
    if (entity.mediaSource.type !== MediaType.image) throw new Error("Expected an image entity");
    const remoteEntity = createCollaborativeEntity(
      { ...entity, position: { x: 77, y: 88 } },
      {
        transferId: "remote-transfer",
        mimeType: entity.mediaSource.asset.blob.type,
        byteLength: entity.mediaSource.asset.blob.size,
        filename: entity.name,
        preview: getEntityThumbhash(entity),
      },
    );
    await act(async () => {
      await collaborationState.adapter!.updateRemoteEntity(remoteEntity, false);
    });

    expect(undo.canUndo()).toBe(true);
    act(() => undo.undo());
    expect(canvasStore.getState().entities.get(entityId)).toMatchObject({
      locked: false,
      position: { x: 77, y: 88 },
    });

    clearUndoHistory();
    const beforeParams = canvasStore.getState().entities.get(entityId)!.shaderParams;
    const localParams = {
      ...beforeParams,
      intensity: beforeParams.intensity + 0.25,
    };
    act(() => rendered.canvas.updateEntity(entityId, { shaderParams: localParams }));
    const locallyUpdated = canvasStore.getState().entities.get(entityId)!;
    const remotelyUpdated = createCollaborativeEntity(
      {
        ...locallyUpdated,
        shaderParams: {
          ...locallyUpdated.shaderParams,
          size: 123,
        },
      },
      remoteEntity.asset,
    );
    await act(async () => {
      await collaborationState.adapter!.updateRemoteEntity(remotelyUpdated, false);
    });
    act(() => undo.undo());

    expect(canvasStore.getState().entities.get(entityId)?.shaderParams).toMatchObject({
      intensity: beforeParams.intensity,
      size: 123,
    });
    rendered.unmount();
  });
});
