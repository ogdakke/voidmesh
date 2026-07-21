/**
 * Test entity factory for creating ShaderCanvasEntity objects
 */
import {
  type MediaSourceGif,
  type MediaSourceImage,
  type MediaSourceVideo,
  MediaType,
  type PlaybackState,
  type Point,
  type ShaderCanvasEntity,
  type ShaderParams,
  type ShaderType,
  type Size,
} from "#types/canvas.ts";
import { config } from "#config";
import { deepMerge } from "#lib/deep-merge.ts";
import { createImageAsset } from "#lib/media-assets.ts";
import { createMockImageBitmap } from "../mocks/media.mock.ts";

let entityCounter = 0;

/**
 * Reset the entity counter for deterministic test IDs
 * Call in beforeEach() to ensure consistent entity IDs across tests
 */
export function resetEntityCounter(): void {
  entityCounter = 0;
}

export interface CreateEntityOptions {
  /** Entity ID (auto-generated if not provided) */
  id?: string;
  /** Display name (auto-generated if not provided) */
  name?: string;
  /** Shader type */
  shaderType?: ShaderType;
  /** Shader parameters (merged with defaults) */
  shaderParams?: Partial<ShaderParams>;
  /** Position in world coordinates */
  position?: Partial<Point>;
  /** Size in world coordinates */
  size?: Partial<Size>;
  /** Z-index for layering */
  zIndex?: number;
  /** Rotation in degrees */
  rotation?: number;
  /** Whether entity is selected */
  selected?: boolean;
  /** Whether entity is locked */
  locked?: boolean;
  /** Whether entity has been edited */
  edited?: boolean;
  /** Media source type */
  mediaType?: MediaType;
  /** Video duration (for video entities) */
  videoDuration?: number;
  /** Video FPS (for video entities) */
  videoFps?: number;
  /** Whether the video entity has an audio track */
  videoHasAudio?: boolean;
  /** Initial muted state for animated playback */
  muted?: boolean;
  /** Initial volume for animated playback */
  volume?: number;
  /** GIF duration in seconds (for gif entities) */
  gifDuration?: number;
  /** Number of GIF frames (for gif entities) */
  gifFrameCount?: number;
}

/**
 * Create a test entity with sensible defaults
 *
 * @example
 * // Simple image entity
 * const entity = createTestEntity();
 *
 * @example
 * // Entity with specific shader type
 * const entity = createTestEntity({
 *   id: "my-entity",
 *   shaderType: "halftone",
 *   shaderParams: { size: 20 },
 *   selected: true,
 * });
 *
 * @example
 * // Video entity
 * const entity = createTestEntity({
 *   mediaType: "video",
 *   videoDuration: 30,
 *   videoFps: 30,
 * });
 */
export function createTestEntity(options: CreateEntityOptions = {}): ShaderCanvasEntity {
  entityCounter++;

  const id = options.id ?? `test-entity-${entityCounter}`;
  const name = options.name ?? `Test Image ${entityCounter}`;
  const width = options.size?.width ?? 200;
  const height = options.size?.height ?? 150;

  // Create mock ImageBitmap
  const mockBitmap = createMockImageBitmap(width, height) as unknown as ImageBitmap;

  // Build shader params with defaults (deep merge to handle nested objects)
  const defaultParams = structuredClone(config.defaults.shaderParams);
  const shaderParams: ShaderParams = options.shaderParams
    ? deepMerge(defaultParams, options.shaderParams as Parameters<typeof deepMerge>[1])
    : defaultParams;

  // Common base properties
  const baseProps = {
    id,
    name,
    position: { x: 0, y: 0, ...options.position },
    size: { width, height },
    zIndex: options.zIndex ?? entityCounter,
    rotation: options.rotation ?? 0,
    imageBitmap: mockBitmap,
    originalSize: { width, height },
    shaderType: (options.shaderType ?? config.defaults.shader) as ShaderType,
    shaderParams,
    textureDirty: false,
    selected: options.selected ?? false,
    locked: options.locked ?? false,
    edited: options.edited ?? false,
  };

  // Build entity with proper discriminated union type
  if (options.mediaType === "video") {
    const videoElement = createMockVideoElement({
      duration: options.videoDuration ?? 10,
      videoWidth: width,
      videoHeight: height,
    });
    const mediaSource: MediaSourceVideo = {
      type: "video",
      videoElement,
      blob: new Blob(["mock-video"], { type: "video/mp4" }),
      duration: options.videoDuration ?? 10,
      fps: options.videoFps ?? 30,
      hasAudio: options.videoHasAudio ?? false,
      alphaMode: "none",
    };
    const playback: PlaybackState = {
      isPlaying: false,
      currentTime: 0,
      loop: false,
      playbackRate: 1,
      muted: options.muted ?? true,
      volume: options.volume ?? 1,
    };
    videoElement.muted = playback.muted;
    videoElement.volume = playback.volume;
    return { ...baseProps, mediaSource, playback };
  }

  if (options.mediaType === MediaType.gif) {
    const frameCount = options.gifFrameCount ?? 10;
    const duration = options.gifDuration ?? 1; // 1 second default
    const frameDelayMs = (duration * 1000) / frameCount;
    const frames = Array.from({ length: frameCount }, (_, i) => ({
      bitmap: createMockImageBitmap(width, height) as unknown as ImageBitmap,
      delay: frameDelayMs,
      timestamp: i * frameDelayMs,
    }));
    const mediaSource: MediaSourceGif = {
      type: "gif",
      frames,
      duration,
      fps: frameCount / duration,
      blob: new Blob(["GIF89a"], { type: "image/gif" }),
    };
    const playback: PlaybackState = {
      isPlaying: false,
      currentTime: 0,
      loop: true,
      playbackRate: 1,
      muted: options.muted ?? true,
      volume: options.volume ?? 1,
    };
    return { ...baseProps, mediaSource, playback };
  }

  // Default: image entity
  const mediaSource: MediaSourceImage = {
    type: "image",
    asset: createImageAsset({
      imageBitmap: mockBitmap,
      blob: new Blob(["mock-image"], { type: "image/png" }),
    }),
  };
  return { ...baseProps, mediaSource };
}

/**
 * Mock HTMLVideoElement with proper event listener support for testing
 */
export interface MockVideoElement extends HTMLVideoElement {
  /** Simulate seeking to a time (fires seeked event) */
  simulateSeek: (time: number) => void;
  /** Simulate timeupdate event */
  simulateTimeUpdate: () => void;
  /** Simulate play event */
  simulatePlay: () => void;
  /** Simulate ended event */
  simulateEnded: () => void;
}

/**
 * Create a mock HTMLVideoElement for video entities with proper event support
 */
function createMockVideoElement(options: {
  duration: number;
  videoWidth: number;
  videoHeight: number;
}): MockVideoElement {
  const listeners: Map<string, Set<EventListener>> = new Map();

  const video = {
    src: "blob:mock-video",
    currentTime: 0,
    duration: options.duration,
    videoWidth: options.videoWidth,
    videoHeight: options.videoHeight,
    paused: true,
    ended: false,
    loop: false,
    playbackRate: 1,
    muted: true,
    volume: 1,
    readyState: 4, // HAVE_ENOUGH_DATA
    seeking: false,

    play: async function () {
      const self = this as typeof video;
      // Simulate browser behavior: restart from beginning when playing at/past the end
      if (self.ended || self.currentTime >= self.duration) {
        self.currentTime = 0;
      }
      self.paused = false;
      self.ended = false;
      self.dispatchEvent(new Event("play"));
    },

    pause: function () {
      const self = this as typeof video;
      self.paused = true;
      self.dispatchEvent(new Event("pause"));
    },

    load: function () {},

    getAttribute: function (name: string) {
      return name === "src" ? this.src : null;
    },

    removeAttribute: function (name: string) {
      if (name === "src") this.src = "";
    },

    addEventListener: function (
      type: string,
      listener: EventListener,
      options?: AddEventListenerOptions | boolean,
    ) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);

      // Handle { once: true } option
      if (typeof options === "object" && options.once) {
        const originalListener = listener;
        const wrappedListener = (event: Event) => {
          listeners.get(type)?.delete(wrappedListener);
          originalListener(event);
        };
        listeners.get(type)!.delete(originalListener);
        listeners.get(type)!.add(wrappedListener);
      }
    },

    removeEventListener: function (type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },

    dispatchEvent: function (event: Event) {
      const typeListeners = listeners.get(event.type);
      if (typeListeners) {
        for (const listener of typeListeners) {
          listener(event);
        }
      }
      return true;
    },

    // Test helpers
    simulateSeek: function (time: number) {
      const self = this as typeof video;
      self.seeking = true;
      self.currentTime = Math.max(0, Math.min(time, self.duration));
      self.seeking = false;
      if (self.currentTime >= self.duration) {
        self.ended = true;
      } else {
        self.ended = false;
      }
      self.dispatchEvent(new Event("seeked"));
    },

    simulateTimeUpdate: function () {
      const self = this as typeof video;
      self.dispatchEvent(new Event("timeupdate"));
    },

    simulatePlay: function () {
      const self = this as typeof video;
      self.paused = false;
      self.ended = false;
      self.dispatchEvent(new Event("play"));
    },

    simulateEnded: function () {
      const self = this as typeof video;
      self.ended = true;
      self.paused = true;
      self.currentTime = self.duration;
      self.dispatchEvent(new Event("ended"));
    },
  };

  return video as unknown as MockVideoElement;
}

/**
 * Create multiple test entities at once
 *
 * @example
 * const entities = createTestEntities([
 *   { shaderType: "halftone" },
 *   { shaderType: "dithering" },
 *   { shaderType: "blobs" },
 * ]);
 */
export function createTestEntities(optionsList: CreateEntityOptions[]): ShaderCanvasEntity[] {
  return optionsList.map((opts) => createTestEntity(opts));
}

/**
 * Entity input type for addEntity - excludes id, zIndex, name which are auto-generated
 */
export type EntityInput = Omit<ShaderCanvasEntity, "id" | "zIndex" | "name">;

/**
 * Create entity input ready for addEntity()
 * Automatically strips id, zIndex, name which addEntity generates
 *
 * @example
 * // With overrides:
 * const entityId = addEntity(createEntityInput({
 *   shaderType: "halftone",
 *   shaderParams: { size: 20 },
 * }));
 */
export function createEntityInput(options: CreateEntityOptions = {}): EntityInput {
  const entity = createTestEntity(options);
  const { id: _id, zIndex: _zIndex, name: _name, ...input } = entity;
  return input;
}
