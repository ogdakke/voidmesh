import { describe, expect, it, vi } from "vitest";
import { createCanvasMediaService } from "#application/canvas/canvas-media.ts";
import { CanvasStore } from "#engine";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("CanvasMediaService access", () => {
  it("blocks playback mutations when editing is not allowed", async () => {
    const store = new CanvasStore();
    const entity = createTestEntity({ id: "viewer-gif", mediaType: "gif" });
    store.addEntity(entity);
    const togglePlayback = vi.spyOn(store, "togglePlayback");
    const service = createCanvasMediaService(store, () => false);

    await service.play(entity.id);
    await service.togglePlayback(entity.id);
    service.seek(entity.id, 0.5);
    service.notifyPlayback(entity.id, 0.5);

    expect(togglePlayback).not.toHaveBeenCalled();
    expect(store.getState().entities.get(entity.id)?.playback?.isPlaying).toBe(false);
    expect(store.getState().entities.get(entity.id)?.playback?.currentTime).toBe(0);
  });
});
