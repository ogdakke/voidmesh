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

export function createCanvasMediaService(store: CanvasStore): CanvasMediaService {
  return {
    subscribe: (listener) => store.subscribe(listener),
    getEntity: (id) => store.getState().entities.get(id),
    async play(id) {
      const entity = store.getState().entities.get(id);
      if (entity && isVideoEntity(entity)) await store.playVideo(id);
      else if (entity && isGifEntity(entity)) store.playGif(id);
    },
    pause(id) {
      const entity = store.getState().entities.get(id);
      if (entity && isVideoEntity(entity)) store.pauseVideo(id);
      else if (entity && isGifEntity(entity)) store.pauseGif(id);
    },
    togglePlayback: (id) => store.togglePlayback(id),
    toggleMuted: (id) => store.toggleVideoMuted(id),
    seek(id, time) {
      const entity = store.getState().entities.get(id);
      if (entity && isVideoEntity(entity)) store.seekVideo(id, time);
      else if (entity && isGifEntity(entity)) store.seekGif(id, time);
    },
    notifyPlayback: (id, time) => store.forcePlaybackNotify(id, time),
  };
}
