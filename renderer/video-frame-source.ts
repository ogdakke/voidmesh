import { isWebkit } from "#lib/util.ts";

/**
 * Whether video frames are copied into renderer-owned textures instead of being imported
 * as external textures.
 *
 * External textures are the zero-copy path and stay the default. WebKit is the exception:
 * importing a video's frame every rendered frame makes its GPU process page-fault inside a
 * submitted command buffer (the device is lost), and the memory each import pins in the
 * page process is reclaimed late enough to reach iOS's per-process limit. A copied frame
 * is uploaded only when the video shows a new one, so a paused video costs nothing.
 */
export function shouldCopyVideoFrames(): boolean {
  return isWebkit();
}
