//! Video frames for the effect pipeline: decoded on a worker thread to CPU RGBA8 (Rune's
//! `Player` draws only into its own native surface, which effects can't sample). macOS reads
//! through AVFoundation's `AVAssetReader`; elsewhere video isn't supported yet.
//!
//! The worker keeps a few frames ahead and loops: at the end of the clip it reopens at 0, tagging
//! frames with a lap number, so the consumer's wrap from the end back to 0 finds the next lap's
//! frames already decoded. A seek bumps a generation and discards everything queued.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

/// Frames decoded ahead of the one on screen.
const AHEAD: usize = 4;
/// Slack when comparing a frame's time with the playback time.
const EPSILON: f64 = 1e-4;
/// Frame rate assumed for a clip that doesn't report one.
pub const DEFAULT_FPS: f64 = 30.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub fps: Option<f64>,
    pub has_audio: bool,
}

/// Upright display size (the track's `preferredTransform` applied), duration in seconds, nominal
/// frame rate, and whether an audio track is present.
pub fn probe(path: &Path) -> Result<VideoInfo, String> {
    platform::probe(path)
}

/// One frame: straight-alpha sRGB RGBA8, tightly packed, upright, at most `max_side` per side.
#[derive(Clone, Debug)]
pub struct VideoFrame {
    pub pts: f64,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Frame buffers the canvas is done with, for the decoders' next frames: a fresh buffer every
/// frame, at video rates, is page faults the system pays for under memory pressure.
static FRAMES: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());
const POOLED: usize = 48;

/// An empty buffer with room for `len` bytes, recycled when one is.
fn frame_buffer(len: usize) -> Vec<u8> {
    let mut pool = FRAMES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut v = pool.iter().position(|b| b.capacity() >= len).map(|i| pool.swap_remove(i)).unwrap_or_default();
    drop(pool);
    v.clear();
    v.reserve_exact(len);
    v
}

/// Hand a frame's pixels back for a later frame.
pub fn recycle(v: Vec<u8>) {
    let mut pool = FRAMES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if pool.len() < POOLED {
        pool.push(v);
    }
}

/// A decoded frame and the lap of the loop it belongs to (0 from the latest seek).
struct Queued {
    lap: u64,
    frame: VideoFrame,
}

#[derive(Default)]
struct State {
    /// Frames of the current generation, in decode order (lap, then time).
    queue: VecDeque<Queued>,
    /// A restart the worker hasn't taken yet; only the latest matters.
    seek: Option<f64>,
    /// Bumped by every seek; the worker only queues frames of the current one.
    generation: u64,
    /// Clip length, once the worker has opened it.
    duration: Option<f64>,
    error: Option<String>,
    stop: bool,
}

struct Shared {
    state: Mutex<State>,
    /// Wakes the worker: room in the queue, a seek, or stop.
    wake: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic elsewhere while holding the lock leaves plain data; keep using it.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Decodes one clip on its own worker thread. Dropping it stops the worker, which releases its
/// AVFoundation objects as it exits.
pub struct Decoder {
    shared: Arc<Shared>,
    /// The generation the bookkeeping below belongs to.
    generation: u64,
    /// The playback lap: bumped when `t` wraps from near the end back towards 0.
    lap: u64,
    last_t: Option<f64>,
    /// A frame has been returned in this generation.
    shown: bool,
}

impl Decoder {
    /// Starts decoding from `start` seconds. `waker` is called (from the worker) whenever a new
    /// frame becomes available, or decoding fails.
    pub fn new(path: PathBuf, start: f64, max_side: u32, waker: Option<rune::Waker>) -> Decoder {
        let shared = Arc::new(Shared {
            state: Mutex::new(State { seek: Some(start.max(0.0)), ..State::default() }),
            wake: Condvar::new(),
        });
        let worker = shared.clone();
        let spawned = std::thread::Builder::new()
            .name("voidmesh-video".into())
            .spawn(move || {
                crate::gfx::process::background();
                platform::run(&worker, &path, max_side.max(1), waker.as_deref())
            });
        // Detached: the worker exits on its own once `stop` is set.
        if let Err(e) = spawned {
            shared.lock().error = Some(format!("can't start the video decoder: {e}"));
        }
        Decoder { shared, generation: 0, lap: 0, last_t: None, shown: false }
    }

    /// Restarts decoding at `t`. Frames from before the seek are discarded and never returned.
    pub fn seek(&self, t: f64) {
        let mut s = self.shared.lock();
        s.generation += 1;
        s.seek = Some(t.max(0.0));
        s.queue.clear();
        s.error = None;
        drop(s);
        self.shared.wake.notify_all();
    }

    /// The frame to show at playback time `t` (seconds, 0..duration) of a looping clip; Some only
    /// when it changed since the last call. Never waits for decoding.
    pub fn frame_at(&mut self, t: f64) -> Option<VideoFrame> {
        let mut s = self.shared.lock();
        if s.generation != self.generation {
            self.generation = s.generation;
            self.lap = 0;
            self.last_t = None;
            self.shown = false;
        }
        // A jump back by more than half the clip with no seek is the loop wrapping.
        if let (Some(last), Some(duration)) = (self.last_t, s.duration)
            && t < last - duration * 0.5
        {
            self.lap += 1;
        }
        self.last_t = Some(t);

        let (lap, shown) = (self.lap, self.shown);
        let due = |q: &Queued| q.lap < lap || (q.lap == lap && q.frame.pts <= t + EPSILON);
        let mut pick = None;
        while let Some(front) = s.queue.front() {
            // Until something shows after a seek, the first frame shows even if slightly early.
            if !(due(front) || (!shown && pick.is_none())) {
                break;
            }
            pick = s.queue.pop_front();
        }
        drop(s);
        let picked = pick?;
        self.shown = true;
        self.shared.wake.notify_all();
        Some(picked.frame)
    }

    pub fn error(&self) -> Option<String> {
        self.shared.lock().error.clone()
    }

    /// A frame due at `t` is decoded and waiting (benchmarks wait for this, untimed).
    pub fn ready(&self, t: f64) -> bool {
        let s = self.shared.lock();
        s.error.is_some() || s.queue.iter().any(|q| q.frame.pts <= t + EPSILON || !self.shown)
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        self.shared.lock().stop = true;
        self.shared.wake.notify_all();
    }
}

/// Every frame of a clip once, in order from its start to its end, decoded on the calling thread
/// (the export worker). Frames are upright straight-alpha RGBA at most `max_side` per side.
pub struct FrameReader {
    inner: platform::Sequential,
}

impl FrameReader {
    pub fn open(path: &Path, max_side: u32) -> Result<(FrameReader, VideoInfo), String> {
        let (inner, info) = platform::sequential(path, max_side.max(1))?;
        Ok((FrameReader { inner }, info))
    }

    /// The next frame, or None after the last.
    pub fn next_frame(&mut self) -> Result<Option<VideoFrame>, String> {
        self.inner.next()
    }
}

/// What the worker should do next, decided under the lock.
enum Next {
    Stop,
    /// Restart at this time for this generation.
    Restart(f64, u64),
    Decode,
}

/// Blocks until the worker has something to do: stop, a seek, or room in the queue while a
/// reader is open (`reading`).
fn next(shared: &Shared, reading: bool) -> Next {
    let mut s = shared.lock();
    loop {
        if s.stop {
            return Next::Stop;
        }
        if let Some(t) = s.seek.take() {
            return Next::Restart(t, s.generation);
        }
        if reading && s.queue.len() < AHEAD {
            return Next::Decode;
        }
        s = shared.wake.wait(s).unwrap_or_else(|e| e.into_inner());
    }
}

/// Queues a frame if its generation is still current; returns whether it was.
fn push(shared: &Shared, generation: u64, lap: u64, frame: VideoFrame) -> bool {
    let mut s = shared.lock();
    if s.generation != generation || s.seek.is_some() || s.stop {
        return false;
    }
    s.queue.push_back(Queued { lap, frame });
    true
}

fn fail(shared: &Shared, error: String, waker: Option<&(dyn Fn() + Send + Sync)>) {
    shared.lock().error = Some(error);
    if let Some(wake) = waker {
        wake();
    }
}

/// The upright size at most `max_side` on its longest side, keeping the aspect ratio.
fn fit(width: u32, height: u32, max_side: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= max_side || long == 0 {
        return (width, height);
    }
    let scale = max_side as f64 / long as f64;
    let side = |v: u32| ((v as f64 * scale).round() as u32).max(1);
    (side(width), side(height))
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    const UNSUPPORTED: &str = "Video needs macOS";

    pub(super) fn probe(_path: &Path) -> Result<VideoInfo, String> {
        Err(UNSUPPORTED.into())
    }

    pub(super) fn run(shared: &Shared, _path: &Path, _max_side: u32, waker: Option<&(dyn Fn() + Send + Sync)>) {
        fail(shared, UNSUPPORTED.into(), waker);
    }

    pub(super) struct Sequential;

    pub(super) fn sequential(_path: &Path, _max_side: u32) -> Result<(Sequential, VideoInfo), String> {
        Err(UNSUPPORTED.into())
    }

    impl Sequential {
        pub(super) fn next(&mut self) -> Result<Option<VideoFrame>, String> {
            Err(UNSUPPORTED.into())
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    use objc2::AnyThread;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::AnyObject;
    use objc2_av_foundation::{
        AVAssetReader, AVAssetReaderStatus, AVAssetReaderVideoCompositionOutput, AVAssetTrack, AVMediaTypeAudio,
        AVMediaTypeVideo, AVMutableVideoComposition, AVURLAsset,
    };
    use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString, CFType};
    use objc2_core_media::{CMTime, CMTimeRange};
    use objc2_core_video::{
        CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
        CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
        CVPixelBufferUnlockBaseAddress, kCVPixelBufferHeightKey, kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
        kCVPixelFormatType_32BGRA, kCVReturnSuccess,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};

    /// An opened clip: its asset, video track and facts.
    struct Clip {
        asset: Retained<AVURLAsset>,
        track: Retained<AVAssetTrack>,
        info: VideoInfo,
    }

    fn seconds(t: CMTime) -> f64 {
        // SAFETY: CMTimeGetSeconds reads a plain struct.
        let s = unsafe { t.seconds() };
        if s.is_finite() { s } else { 0.0 }
    }

    fn cm(seconds: f64) -> CMTime {
        // SAFETY: CMTimeMakeWithSeconds builds a plain struct.
        unsafe { CMTime::with_seconds(seconds, 600_000) }
    }

    /// Opens a local file and reads its first video track's facts, blocking until they load.
    #[allow(deprecated)] // The synchronous track and duration accessors suit a worker and local files.
    fn open(path: &Path) -> Result<Clip, String> {
        if !path.is_file() {
            return Err(format!("no such file: {}", path.display()));
        }
        let path = std::path::absolute(path).map_err(|e| format!("can't resolve {}: {e}", path.display()))?;
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        // SAFETY: a file URL and no options.
        let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };
        // SAFETY: AVFoundation's media type constants, read once loaded.
        let (video, audio) = unsafe { (AVMediaTypeVideo, AVMediaTypeAudio) };
        let video = video.ok_or("AVMediaTypeVideo unavailable")?;
        // SAFETY: the asset is alive; the accessor blocks until its tracks load.
        let track = unsafe { asset.tracksWithMediaType(video) }
            .firstObject()
            .ok_or("no playable video track (unreadable, or a format AVFoundation can't read)")?;
        // SAFETY: as above.
        let has_audio = audio.is_some_and(|audio| unsafe { asset.tracksWithMediaType(audio) }.firstObject().is_some());
        // SAFETY: plain property reads of a loaded track.
        let (size, t, fps, duration) =
            unsafe { (track.naturalSize(), track.preferredTransform(), track.nominalFrameRate(), asset.duration()) };
        let width = (size.width * t.a + size.height * t.c).abs().round();
        let height = (size.width * t.b + size.height * t.d).abs().round();
        if width < 1.0 || height < 1.0 {
            return Err("video track has no size".into());
        }
        let fps = (fps.is_finite() && fps > 0.0).then_some(fps as f64);
        let info = VideoInfo { width: width as u32, height: height as u32, duration: seconds(duration), fps, has_audio };
        Ok(Clip { asset, track, info })
    }

    pub(super) fn probe(path: &Path) -> Result<VideoInfo, String> {
        autoreleasepool(|_| open(path).map(|clip| clip.info))
    }

    /// One pass over the clip from some time to its end.
    struct Reader {
        reader: Retained<AVAssetReader>,
        output: Retained<AVAssetReaderVideoCompositionOutput>,
    }

    impl Drop for Reader {
        fn drop(&mut self) {
            // SAFETY: cancelling an idle, reading or finished reader is allowed.
            unsafe { self.reader.cancelReading() };
        }
    }

    /// Reads the clip upright (the composition applies `preferredTransform`) as BGRA at `size`.
    #[allow(deprecated)] // The synchronous composition constructor; the asset's tracks are loaded.
    fn reader(clip: &Clip, from: f64, size: (u32, u32)) -> Result<Reader, String> {
        // SAFETY: the asset is alive with its tracks and duration loaded.
        let reader = unsafe { AVAssetReader::assetReaderWithAsset_error(&clip.asset) }
            .map_err(|e| e.localizedDescription().to_string())?;
        // SAFETY: as above.
        let composition = unsafe { AVMutableVideoComposition::videoCompositionWithPropertiesOfAsset(&clip.asset) };
        let format = CFNumber::new_i32(kCVPixelFormatType_32BGRA as i32);
        let (width, height) = (CFNumber::new_i32(size.0 as i32), CFNumber::new_i32(size.1 as i32));
        // SAFETY: CoreVideo's key constants are immutable CFStrings.
        let keys: [&CFString; 3] = unsafe { [kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, kCVPixelBufferHeightKey] };
        let values: [&CFType; 3] = [format.as_ref(), width.as_ref(), height.as_ref()];
        let settings: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(&keys, &values);
        // SAFETY: CFDictionary and NSDictionary are toll-free bridged; `settings` outlives the borrow.
        let settings = unsafe { &*(CFRetained::as_ptr(&settings).as_ptr() as *const NSDictionary<NSString, AnyObject>) };
        let tracks = NSArray::from_retained_slice(std::slice::from_ref(&clip.track));
        // SAFETY: the track belongs to the reader's asset; settings hold CF numbers for CV keys.
        let output = unsafe {
            let output = AVAssetReaderVideoCompositionOutput::initWithVideoTracks_videoSettings(
                AVAssetReaderVideoCompositionOutput::alloc(),
                &tracks,
                Some(settings),
            );
            output.setVideoComposition(Some(&composition));
            // Frames are copied out at once, so the decoder's own buffers may be handed over.
            output.setAlwaysCopiesSampleData(false);
            output
        };
        // SAFETY: a fresh reader that hasn't started.
        unsafe {
            if !reader.canAddOutput(&output) {
                return Err("can't read this video's frames".into());
            }
            reader.addOutput(&output);
            if from > 0.0 {
                let duration = (clip.info.duration - from).max(0.0);
                reader.setTimeRange(CMTimeRange { start: cm(from), duration: cm(duration) });
            }
            if !reader.startReading() {
                return Err(reader_error(&reader));
            }
        }
        Ok(Reader { reader, output })
    }

    fn reader_error(reader: &AVAssetReader) -> String {
        // SAFETY: a plain property read.
        unsafe { reader.error() }.map_or_else(|| "video decoding failed".into(), |e| e.localizedDescription().to_string())
    }

    impl Reader {
        /// The next frame, or None at the end of the range.
        fn next(&self) -> Result<Option<VideoFrame>, String> {
            // SAFETY: the reader is reading; the output belongs to it.
            let Some(sample) = (unsafe { self.output.copyNextSampleBuffer() }) else {
                // SAFETY: a plain property read.
                return match unsafe { self.reader.status() } {
                    AVAssetReaderStatus::Completed => Ok(None),
                    _ => Err(reader_error(&self.reader)),
                };
            };
            // SAFETY: a valid sample buffer from the output.
            let (pts, image) = unsafe { (seconds(sample.presentation_time_stamp()), sample.image_buffer()) };
            let image = image.ok_or("a video sample had no image")?;
            let (width, height, rgba) = rgba(&image)?;
            Ok(Some(VideoFrame { pts, width, height, rgba }))
        }
    }

    /// Copies a BGRA pixel buffer out as tightly packed opaque RGBA.
    fn rgba(buffer: &CVPixelBuffer) -> Result<(u32, u32, Vec<u8>), String> {
        if CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA {
            return Err("decoder returned an unexpected pixel format".into());
        }
        // SAFETY: a valid pixel buffer, unlocked below with the same flags.
        if unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) } != kCVReturnSuccess {
            return Err("can't read a decoded video frame".into());
        }
        let (width, height) = (CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer));
        let stride = CVPixelBufferGetBytesPerRow(buffer);
        let base = CVPixelBufferGetBaseAddress(buffer) as *const u8;
        let copied = if base.is_null() || width == 0 || height == 0 || stride < width * 4 {
            Err("decoded an empty video frame".to_string())
        } else {
            // SAFETY: locked, a non-planar buffer spans `stride * height` bytes from `base`.
            let src = unsafe { std::slice::from_raw_parts(base, stride * height) };
            let mut out = super::frame_buffer(width * height * 4);
            for row in src.chunks_exact(stride).take(height) {
                for s in row[..width * 4].as_chunks::<4>().0 {
                    out.extend_from_slice(&[s[2], s[1], s[0], 255]);
                }
            }
            Ok((width as u32, height as u32, out))
        };
        // SAFETY: locked above with these flags.
        unsafe { CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) };
        copied
    }

    /// One pass from 0 to the end. The reader drops (cancelling) before the clip it reads.
    pub(super) struct Sequential {
        reader: Reader,
        _clip: Clip,
    }

    pub(super) fn sequential(path: &Path, max_side: u32) -> Result<(Sequential, VideoInfo), String> {
        autoreleasepool(|_| {
            let clip = open(path)?;
            let info = clip.info;
            let reader = reader(&clip, 0.0, fit(info.width, info.height, max_side))?;
            Ok((Sequential { reader, _clip: clip }, info))
        })
    }

    impl Sequential {
        pub(super) fn next(&mut self) -> Result<Option<VideoFrame>, String> {
            autoreleasepool(|_| self.reader.next())
        }
    }

    pub(super) fn run(shared: &Shared, path: &Path, max_side: u32, waker: Option<&(dyn Fn() + Send + Sync)>) {
        let clip = match autoreleasepool(|_| open(path)) {
            Ok(clip) => clip,
            Err(e) => return fail(shared, e, waker),
        };
        let info = clip.info;
        shared.lock().duration = Some(info.duration);
        let size = fit(info.width, info.height, max_side);
        let half_frame = 0.5 / info.fps.unwrap_or(DEFAULT_FPS);

        let mut current: Option<Reader> = None;
        let mut generation = 0;
        let mut lap = 0;
        // Frames before this (a reader's range may start a little early) are skipped.
        let mut min_pts = f64::NEG_INFINITY;
        // Frames read this pass, and whether the pass started at 0 (so none means none at all).
        let mut pass_frames = 0usize;
        let mut from_zero = false;
        loop {
            match next(shared, current.is_some()) {
                Next::Stop => return,
                Next::Restart(t, g) => {
                    current = None;
                    generation = g;
                    lap = 0;
                    let from = t.clamp(0.0, (info.duration - half_frame * 2.0).max(0.0));
                    min_pts = from - half_frame;
                    pass_frames = 0;
                    from_zero = from <= 0.0;
                    match autoreleasepool(|_| reader(&clip, from, size)) {
                        Ok(r) => current = Some(r),
                        Err(e) => fail(shared, e, waker),
                    }
                }
                Next::Decode => {
                    let Some(r) = &current else { continue };
                    match autoreleasepool(|_| r.next()) {
                        Ok(Some(frame)) => {
                            if frame.pts < min_pts {
                                continue;
                            }
                            pass_frames += 1;
                            if push(shared, generation, lap, frame)
                                && let Some(wake) = waker
                            {
                                wake();
                            }
                        }
                        Ok(None) if pass_frames == 0 && from_zero => {
                            current = None;
                            fail(shared, "the video has no frames".into(), waker);
                        }
                        Ok(None) => {
                            // Loop: the next lap starts at 0, read ahead like any other frames.
                            current = None;
                            lap += 1;
                            min_pts = f64::NEG_INFINITY;
                            pass_frames = 0;
                            from_zero = true;
                            match autoreleasepool(|_| reader(&clip, 0.0, size)) {
                                Ok(r) => current = Some(r),
                                Err(e) => fail(shared, e, waker),
                            }
                        }
                        Err(e) => {
                            current = None;
                            fail(shared, e, waker);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod logic_tests {
    use super::*;

    #[test]
    fn fit_keeps_aspect() {
        assert_eq!(fit(1920, 1080, 4096), (1920, 1080));
        assert_eq!(fit(1920, 1080, 960), (960, 540));
        assert_eq!(fit(1080, 1920, 960), (540, 960));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    const FFMPEG: &str = "/opt/homebrew/bin/ffmpeg";

    /// A scratch directory removed when dropped.
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("voidmesh-video-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        Scratch(dir)
    }

    /// Makes a clip with ffmpeg, or None (with a note) when ffmpeg isn't installed.
    fn clip(dir: &Path, name: &str, args: &[&str]) -> Option<PathBuf> {
        if !Path::new(FFMPEG).exists() {
            eprintln!("skipping: {FFMPEG} not found");
            return None;
        }
        let out = dir.join(name);
        let status = Command::new(FFMPEG)
            .args(["-y", "-loglevel", "error"])
            .args(args)
            .arg(&out)
            .status()
            .ok()?;
        assert!(status.success(), "ffmpeg failed making {name}");
        Some(out)
    }

    /// 2 s, 64×48, 30 fps H.264 test pattern with a sine audio track.
    fn basic(dir: &Path) -> Option<PathBuf> {
        clip(
            dir,
            "basic.mp4",
            &[
                "-f", "lavfi", "-i", "testsrc=size=64x48:rate=30:duration=2",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15", "-c:a", "aac", "-shortest",
            ],
        )
    }

    /// ffmpeg's own first frame as RGBA (autorotated, as a player shows it).
    fn reference(path: &Path) -> Vec<u8> {
        let out = Command::new(FFMPEG)
            .args(["-loglevel", "error", "-i"])
            .arg(path)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
            .output()
            .unwrap_or_else(|e| panic!("ffmpeg: {e}"));
        out.stdout
    }

    /// Mean absolute difference per colour channel.
    fn difference(a: &[u8], b: &[u8]) -> f64 {
        assert_eq!(a.len(), b.len());
        let sum: u64 = a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).flat_map(|(p, q)| (0..3).map(move |i| p[i].abs_diff(q[i]) as u64)).sum();
        sum as f64 / (a.len() / 4 * 3) as f64
    }

    /// Polls `frame_at(t)` until a frame comes or `wait` passes.
    fn wait_frame(d: &mut Decoder, t: f64, wait: Duration) -> Option<VideoFrame> {
        let until = Instant::now() + wait;
        while Instant::now() < until {
            if let Some(f) = d.frame_at(t) {
                return Some(f);
            }
            assert_eq!(d.error(), None);
            std::thread::sleep(Duration::from_millis(2));
        }
        None
    }

    #[test]
    fn video_probe() {
        let dir = scratch("probe");
        let Some(path) = basic(&dir.0) else { return };
        let info = probe(&path).unwrap_or_else(|e| panic!("probe: {e}"));
        assert_eq!((info.width, info.height), (64, 48));
        assert!((info.duration - 2.0).abs() < 0.1, "duration {}", info.duration);
        assert!(info.fps.is_some_and(|f| (f - 30.0).abs() < 0.5), "fps {:?}", info.fps);
        assert!(info.has_audio);
        assert!(probe(&dir.0.join("missing.mp4")).is_err());
        let junk = dir.0.join("junk.mp4");
        let _ = std::fs::write(&junk, b"not a video");
        assert!(probe(&junk).is_err());
    }

    #[test]
    fn video_rotated_is_upright() {
        let dir = scratch("rotated");
        let Some(path) = clip(
            &dir.0,
            "rotated.mp4",
            &[
                "-display_rotation", "90", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=30:duration=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
            ],
        ) else {
            return;
        };
        let info = probe(&path).unwrap_or_else(|e| panic!("probe: {e}"));
        assert_eq!((info.width, info.height), (48, 64));
        assert!(!info.has_audio);
        let mut d = Decoder::new(path.clone(), 0.0, 4096, None);
        let f = wait_frame(&mut d, 0.0, Duration::from_secs(5)).unwrap_or_else(|| panic!("no frame: {:?}", d.error()));
        assert_eq!((f.width, f.height), (48, 64));
        assert_eq!(f.rgba.len(), 48 * 64 * 4);
        // Turned the way ffmpeg turns it, not stretched or mirrored.
        let diff = difference(&f.rgba, &reference(&path));
        assert!(diff < 20.0, "differs from ffmpeg's upright frame by {diff}");
    }

    #[test]
    fn video_frames_play_in_order() {
        let dir = scratch("order");
        let Some(path) = basic(&dir.0) else { return };
        let mut d = Decoder::new(path.clone(), 0.0, 4096, None);
        let first = wait_frame(&mut d, 0.0, Duration::from_secs(5)).unwrap_or_else(|| panic!("no frame: {:?}", d.error()));
        assert_eq!((first.width, first.height), (64, 48));
        assert_eq!(first.rgba.len(), 64 * 48 * 4);
        assert!(first.pts.abs() < 1e-3);
        let pixels = first.rgba.as_chunks::<4>().0;
        assert!(pixels.iter().all(|p| p[3] == 255));
        assert!(pixels.iter().any(|p| p[0] > 32 || p[1] > 32 || p[2] > 32), "all black");
        // Channels in RGBA order, matching ffmpeg's decode.
        let diff = difference(&first.rgba, &reference(&path));
        assert!(diff < 20.0, "differs from ffmpeg's frame by {diff}");
        // Same time again: nothing new.
        std::thread::sleep(Duration::from_millis(50));
        assert!(d.frame_at(0.0).is_none());

        let mut last = first.pts;
        let mut count = 1;
        let mut t = 0.0;
        while t < 1.5 {
            t += 1.0 / 30.0;
            if let Some(f) = wait_frame(&mut d, t, Duration::from_secs(2)) {
                assert!(f.pts > last, "{} after {last}", f.pts);
                assert!(f.pts <= t + EPSILON);
                last = f.pts;
                count += 1;
            }
        }
        assert!(count >= 40, "only {count} frames");
    }

    #[test]
    fn video_seek_lands_near_target() {
        let dir = scratch("seek");
        let Some(path) = basic(&dir.0) else { return };
        let mut d = Decoder::new(path.clone(), 0.0, 4096, None);
        assert!(wait_frame(&mut d, 0.0, Duration::from_secs(5)).is_some());
        // Coalesced: only the last seek counts.
        d.seek(0.3);
        d.seek(1.2);
        let f = wait_frame(&mut d, 1.2, Duration::from_secs(5)).unwrap_or_else(|| panic!("no frame: {:?}", d.error()));
        assert!((f.pts - 1.2).abs() < 1.0 / 30.0, "landed at {}", f.pts);
        // Starting mid-clip, between frames.
        let mut d = Decoder::new(path, 0.71, 4096, None);
        let f = wait_frame(&mut d, 0.71, Duration::from_secs(5)).unwrap_or_else(|| panic!("no frame: {:?}", d.error()));
        assert!((f.pts - 0.71).abs() < 1.0 / 30.0, "started at {}", f.pts);
    }

    #[test]
    fn video_loop_wraps_promptly() {
        let dir = scratch("loop");
        let Some(path) = basic(&dir.0) else { return };
        let mut d = Decoder::new(path, 1.8, 4096, None);
        assert!(wait_frame(&mut d, 1.8, Duration::from_secs(5)).is_some());
        let mut t: f64 = 1.8;
        while t < 1.98 {
            t += 1.0 / 30.0;
            let _ = wait_frame(&mut d, t.min(1.99), Duration::from_millis(500));
        }
        // Let the worker read ahead into the next lap, then wrap.
        std::thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        let f = d.frame_at(0.01).unwrap_or_else(|| panic!("no frame after wrap: {:?}", d.error()));
        assert!(started.elapsed() < Duration::from_millis(20));
        assert!(f.pts < 0.05, "wrapped to {}", f.pts);
        let next = wait_frame(&mut d, 0.1, Duration::from_secs(2)).unwrap_or_else(|| panic!("stalled after wrap"));
        assert!(next.pts > f.pts && next.pts < 0.15, "then {}", next.pts);
    }

    #[test]
    fn video_downscales() {
        let dir = scratch("scale");
        let Some(path) = basic(&dir.0) else { return };
        let mut d = Decoder::new(path, 0.0, 32, None);
        let f = wait_frame(&mut d, 0.0, Duration::from_secs(5)).unwrap_or_else(|| panic!("no frame: {:?}", d.error()));
        assert_eq!((f.width, f.height), (32, 24));
        // Scaled, not cropped: testsrc's right edge is coloured, not black.
        let px = |x: usize, y: usize| &f.rgba[(y * 32 + x) * 4..][..3];
        assert!((0..24).any(|y| px(31, y).iter().any(|&c| c > 32)), "right edge black");
    }

    #[test]
    fn video_errors_are_reported() {
        let dir = scratch("errors");
        let waked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = waked.clone();
        let waker: rune::Waker = Arc::new(move || flag.store(true, std::sync::atomic::Ordering::SeqCst));
        let mut d = Decoder::new(dir.0.join("missing.mp4"), 0.0, 4096, Some(waker));
        let until = Instant::now() + Duration::from_secs(5);
        while d.error().is_none() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(d.error().is_some());
        assert!(waked.load(std::sync::atomic::Ordering::SeqCst));
        assert!(d.frame_at(0.0).is_none());
    }
}
