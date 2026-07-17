import type { CanvasStore } from "#engine";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { isGifEntity, isVideoEntity } from "#types/canvas.ts";

export interface CanvasMediaService {
  subscribe(listener: () => void): () => void;
  getEntity(id: string): ShaderCanvasEntity | undefined;
  play(id: string): Promise<void>;
  pause(id: string): void;
  togglePlayback(id: string): Promise<void>;
  toggleMuted(id: string): void;
  seek(id: string, time: number): void;
  notifyPlayback(id: string, time: number): void;
}

export function createCanvasMediaService(
  store: CanvasStore,
  canEdit: () => boolean = () => true,
): CanvasMediaService {
  return {
    subscribe: (listener) => store.subscribe(listener),
    getEntity: (id) => store.getState().entities.get(id),
    async play(id) {
      if (!canEdit()) return;
      const entity = store.getState().entities.get(id);
      if (entity && isVideoEntity(entity)) await store.playVideo(id);
      else if (entity && isGifEntity(entity)) store.playGif(id);
    },
    pause(id) {
      if (!canEdit()) return;
      const entity = store.getState().entities.get(id);
      if (entity && isVideoEntity(entity)) store.pauseVideo(id);
      else if (entity && isGifEntity(entity)) store.pauseGif(id);
    },
    togglePlayback: (id) => (canEdit() ? store.togglePlayback(id) : Promise.resolve()),
    toggleMuted: (id) => {
      if (canEdit()) store.toggleVideoMuted(id);
    },
    seek(id, time) {
      if (!canEdit()) return;
      const entity = store.getState().entities.get(id);
      if (entity && isVideoEntity(entity)) store.seekVideo(id, time);
      else if (entity && isGifEntity(entity)) store.seekGif(id, time);
    },
    notifyPlayback: (id, time) => {
      if (canEdit()) store.forcePlaybackNotify(id, time);
    },
  };
}
