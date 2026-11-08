//! Media decoding: files become RGBA frames on a worker thread. A still image has one frame; a GIF
//! keeps every frame with its delay. SVG rasterizes once at a size that stays crisp when zoomed in.
//! Video keeps only its metadata here: `video::Decoder` streams its frames while it shows.
//! Every asset keeps its original bytes (or, for video, its file) so a workspace can save them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use image::AnimationDecoder;

/// Longest side an SVG rasterizes to.
const SVG_PX: u32 = 2048;
/// Longest side a decoded image keeps: the GPU's texture limit. Only media past it (over 16384 px
/// on a side) is downscaled, since no texture can hold it whole.
const MAX_PX: u32 = crate::gfx::process::MAX_SIDE;

pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
/// What AVFoundation plays (WebM and Matroska aren't among them).
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov"];
/// Colours in an entity's Original palette.
const ORIGINAL_COLORS: usize = 6;

/// Asset ids are unique for the process: workspace loads mint them on worker threads.
pub fn next_asset_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

pub fn is_video(ext: &str) -> bool {
    VIDEO_EXTENSIONS.contains(&ext)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Image,
    Gif,
    Svg,
    Video,
}

/// The bytes an asset came from, kept for saving.
pub enum Original {
    Bytes(Arc<[u8]>),
    /// Video stays on disk; AVFoundation reads it from there.
    File(PathBuf),
}

pub struct VideoMeta {
    pub fps: Option<f64>,
    pub has_audio: bool,
}

/// One straight-alpha sRGB RGBA8 frame.
pub struct Frame {
    pub rgba: Vec<u8>,
    /// How long this frame shows (GIFs); zero for stills.
    pub delay: Duration,
}

/// Decoded, immutable media shared by every entity that shows it.
pub struct Asset {
    pub id: u64,
    pub name: String,
    pub kind: Kind,
    pub width: u32,
    pub height: u32,
    /// Decoded frames; empty for video.
    pub frames: Vec<Frame>,
    /// Sum of frame delays (zero for stills); a video's length.
    pub duration: Duration,
    pub original: Original,
    /// The original's extension, lower case (`png`, `gif`, `mp4`…).
    pub ext: String,
    /// The Original palette's colours, from the first frame (none for video).
    pub palette: Option<Vec<crate::effects::Rgba>>,
    pub video: Option<VideoMeta>,
}

impl Asset {
    /// The frame showing `t` seconds into a looping playback.
    pub fn frame_at(&self, t: f64) -> usize {
        if self.frames.len() <= 1 || self.duration.is_zero() {
            return 0;
        }
        let mut rem = t.rem_euclid(self.duration.as_secs_f64());
        for (i, f) in self.frames.iter().enumerate() {
            let d = f.delay.as_secs_f64();
            if rem < d {
                return i;
            }
            rem -= d;
        }
        self.frames.len() - 1
    }

    /// Has a timeline: an animated GIF or a video.
    pub fn animated(&self) -> bool {
        self.frames.len() > 1 || self.kind == Kind::Video
    }

    pub fn video_path(&self) -> Option<&Path> {
        match (&self.original, self.kind) {
            (Original::File(p), Kind::Video) => Some(p),
            _ => None,
        }
    }

    pub fn original_palette(&self) -> Option<crate::effects::Palette> {
        self.palette.clone().map(crate::effects::original)
    }
}

/// What a decode produced, waiting for the next poll to pick it up.
pub struct Decoded {
    /// Files imported together land together.
    pub batch: u64,
    pub result: Result<Arc<Asset>, (String, String)>,
}

/// A finished workspace job.
pub enum WorkspaceDone {
    Opened(PathBuf, Result<crate::workspace::Workspace, String>),
    Saved(PathBuf, Result<(), String>),
}

/// Decodes on worker threads and hands results to the UI thread through `inbox`.
#[derive(Clone, Default)]
pub struct Loader {
    pub inbox: Arc<Mutex<Vec<Decoded>>>,
    workspaces: Arc<Mutex<Vec<WorkspaceDone>>>,
    /// Rendered PNGs waiting for the UI thread to put them on the clipboard.
    clipboard: Arc<Mutex<Vec<Vec<u8>>>>,
    /// Messages from other workers (exports) for the next poll to show.
    notices: Arc<Mutex<Vec<String>>>,
    waker: Option<rune::Waker>,
}

impl Loader {
    pub fn set_waker(&mut self, waker: rune::Waker) {
        self.waker = Some(waker);
    }

    pub fn load(&self, id: u64, path: PathBuf, batch: u64) {
        let inbox = self.inbox.clone();
        let waker = self.waker.clone();
        std::thread::spawn(move || {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let result = Decoded { batch, result: decode_file(id, &path).map(Arc::new).map_err(|e| (name, e)) };
            if let Ok(mut q) = inbox.lock() {
                q.push(result);
            }
            if let Some(w) = waker {
                w();
            }
        });
    }

    pub fn open_workspace(&self, path: PathBuf, progress: Arc<crate::workspace::Progress>) {
        let this = self.clone();
        std::thread::spawn(move || {
            let r = crate::workspace::read(&path, &cache_dir(), &progress);
            this.finish(WorkspaceDone::Opened(path, r));
        });
    }

    pub fn save_workspace(&self, path: PathBuf, items: Vec<crate::workspace::Item>, viewport: crate::workspace::Viewport, palettes: Vec<crate::effects::Palette>) {
        let this = self.clone();
        std::thread::spawn(move || {
            let r = crate::workspace::write(&path, &items, viewport, &palettes);
            this.finish(WorkspaceDone::Saved(path, r));
        });
    }

    fn finish(&self, done: WorkspaceDone) {
        if let Ok(mut q) = self.workspaces.lock() {
            q.push(done);
        }
        if let Some(w) = &self.waker {
            w();
        }
    }

    pub fn drain_workspaces(&self) -> Vec<WorkspaceDone> {
        self.workspaces.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
    }

    pub fn to_clipboard(&self, png: Vec<u8>) {
        if let Ok(mut q) = self.clipboard.lock() {
            q.push(png);
        }
        if let Some(w) = &self.waker {
            w();
        }
    }

    pub fn drain_clipboard(&self) -> Vec<Vec<u8>> {
        self.clipboard.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
    }

    pub fn notify(&self, msg: String) {
        if let Ok(mut q) = self.notices.lock() {
            q.push(msg);
        }
        if let Some(w) = &self.waker {
            w();
        }
    }

    pub fn drain_notices(&self) -> Vec<String> {
        self.notices.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
    }

    pub fn drain(&self) -> Vec<Decoded> {
        self.inbox.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
    }
}

/// Where videos from opened workspaces are unpacked.
pub fn cache_dir() -> PathBuf {
    rune::dirs::AppDirs::new(APP_ID).map(|d| d.cache().join("media")).unwrap_or_else(|| std::env::temp_dir().join("voidmesh-media"))
}

/// The bundle id `install.sh` gives the app; preferences and caches live under it.
pub const APP_ID: &str = "dev.voidmesh.desktop";

pub fn decode_file(id: u64, path: &Path) -> Result<Asset, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "media".into());
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if is_video(&ext) {
        return decode_video(id, name, ext, path.to_path_buf());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    decode_bytes(id, name, &ext, bytes.into())
}

pub fn decode_video(id: u64, name: String, ext: String, path: PathBuf) -> Result<Asset, String> {
    let info = crate::video::probe(&path).map_err(|e| format!("{name}: {e}"))?;
    Ok(Asset {
        id,
        name,
        kind: Kind::Video,
        width: info.width,
        height: info.height,
        frames: Vec::new(),
        duration: Duration::from_secs_f64(info.duration.max(0.0)),
        original: Original::File(path),
        ext,
        palette: None,
        video: Some(VideoMeta { fps: info.fps, has_audio: info.has_audio }),
    })
}

pub fn decode_bytes(id: u64, name: String, ext: &str, bytes: Arc<[u8]>) -> Result<Asset, String> {
    let looks_svg = ext == "svg" || bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml");
    let (kind, ext, width, height, frames, duration) = if looks_svg {
        let (w, h, rgba) = svg_rgba(&bytes, SVG_PX)?;
        (Kind::Svg, "svg", w, h, vec![Frame { rgba, delay: Duration::ZERO }], Duration::ZERO)
    } else if ext == "gif" || bytes.starts_with(b"GIF8") {
        let (w, h, frames, duration) = decode_gif(&name, &bytes)?;
        // A single-frame GIF is a still image, as on the web.
        let kind = if frames.len() > 1 { Kind::Gif } else { Kind::Image };
        (kind, "gif", w, h, frames, duration)
    } else {
        let img = image::load_from_memory(&bytes).map_err(|e| format!("{name}: {e}"))?;
        let rgba = fit(img).to_rgba8();
        let (w, h) = rgba.dimensions();
        (Kind::Image, ext, w, h, vec![Frame { rgba: rgba.into_raw(), delay: Duration::ZERO }], Duration::ZERO)
    };
    let palette = frames.first().map(|f| crate::palette::extract(&f.rgba, width, height, ORIGINAL_COLORS));
    Ok(Asset { id, name, kind, width, height, frames, duration, original: Original::Bytes(bytes), ext: ext.to_string(), palette, video: None })
}

fn fit(img: image::DynamicImage) -> image::DynamicImage {
    if img.width() > MAX_PX || img.height() > MAX_PX {
        img.resize(MAX_PX, MAX_PX, image::imageops::FilterType::Triangle)
    } else {
        img
    }
}

fn decode_gif(name: &str, bytes: &[u8]) -> Result<(u32, u32, Vec<Frame>, Duration), String> {
    let decoder = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes)).map_err(|e| format!("{name}: {e}"))?;
    let frames = decoder.into_frames().collect_frames().map_err(|e| format!("{name}: {e}"))?;
    let Some(first) = frames.first() else { return Err(format!("{name}: no frames")) };
    let (width, height) = first.buffer().dimensions();
    let mut out = Vec::with_capacity(frames.len());
    let mut duration = Duration::ZERO;
    for f in frames {
        let (n, d) = f.delay().numer_denom_ms();
        // Browsers clamp delays under 20 ms to 100 ms; match them so fast GIFs play as authored.
        let ms = n.checked_div(d).unwrap_or(100);
        let delay = Duration::from_millis(if ms < 20 { 100 } else { u64::from(ms) });
        duration += delay;
        out.push(Frame { rgba: f.into_buffer().into_raw(), delay });
    }
    Ok((width, height, out, duration))
}

fn svg_rgba(bytes: &[u8], px: u32) -> Result<(u32, u32, Vec<u8>), String> {
    use resvg::{tiny_skia, usvg};
    let tree = usvg::Tree::from_data(bytes, &usvg::Options::default()).map_err(|e| format!("SVG: {e}"))?;
    let size = tree.size();
    let k = px as f32 / size.width().max(size.height());
    let (w, h) = (((size.width() * k).round() as u32).clamp(1, px), ((size.height() * k).round() as u32).clamp(1, px));
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or("empty SVG")?;
    resvg::render(&tree, tiny_skia::Transform::from_scale(k, k), &mut pixmap.as_mut());
    let rgba = pixmap
        .pixels()
        .iter()
        .flat_map(|p| {
            let c = p.demultiply();
            [c.red(), c.green(), c.blue(), c.alpha()]
        })
        .collect();
    Ok((w, h, rgba))
}

/// A blank still for tests.
#[cfg(test)]
pub fn test_asset(id: u64, w: u32, h: u32) -> Asset {
    Asset {
        id,
        name: format!("a{id}.png"),
        kind: Kind::Image,
        width: w,
        height: h,
        frames: vec![Frame { rgba: vec![0; (w * h * 4) as usize], delay: Duration::ZERO }],
        duration: Duration::ZERO,
        original: Original::Bytes(Arc::from(&[][..])),
        ext: "png".into(),
        palette: None,
        video: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svg_rasterizes_to_its_aspect() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>"#;
        let a = decode_bytes(1, "r.svg".into(), "svg", svg.as_slice().into()).expect("svg");
        assert_eq!((a.width, a.height), (2048, 1024));
        assert_eq!(&a.frames[0].rgba[..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn gif_frame_at_loops() {
        let mk = |ms| Frame { rgba: vec![], delay: Duration::from_millis(ms) };
        let a = Asset { frames: vec![mk(100), mk(200)], duration: Duration::from_millis(300), ..test_asset(1, 1, 1) };
        assert_eq!(a.frame_at(0.05), 0);
        assert_eq!(a.frame_at(0.15), 1);
        assert_eq!(a.frame_at(0.35), 0);
    }
}
