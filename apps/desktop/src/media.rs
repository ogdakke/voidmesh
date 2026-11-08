//! Media decoding: files become RGBA frames on a worker thread. A still image has one frame; a GIF
//! keeps every frame with its delay. SVG rasterizes once at a size that stays crisp when zoomed in.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use image::AnimationDecoder;

/// Longest side an SVG rasterizes to.
const SVG_PX: u32 = 2048;
/// Longest side a decoded image keeps; larger ones are downscaled (GPU texture limit headroom).
const MAX_PX: u32 = 8192;

pub const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

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
    pub width: u32,
    pub height: u32,
    pub frames: Vec<Frame>,
    /// Sum of frame delays (zero for stills).
    pub duration: Duration,
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

    pub fn animated(&self) -> bool {
        self.frames.len() > 1
    }
}

/// What a decode produced, waiting for the next poll to pick it up.
pub struct Decoded {
    /// Files imported together land together.
    pub batch: u64,
    pub result: Result<Arc<Asset>, (String, String)>,
}

/// Decodes on worker threads and hands results to the UI thread through `inbox`.
#[derive(Clone, Default)]
pub struct Loader {
    pub inbox: Arc<Mutex<Vec<Decoded>>>,
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

pub fn decode_file(id: u64, path: &Path) -> Result<Asset, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "media".into());
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    decode_bytes(id, name, &ext, &bytes)
}

pub fn decode_bytes(id: u64, name: String, ext: &str, bytes: &[u8]) -> Result<Asset, String> {
    let looks_svg = ext == "svg" || bytes.starts_with(b"<svg") || bytes.starts_with(b"<?xml");
    if looks_svg {
        let (width, height, rgba) = svg_rgba(bytes, SVG_PX)?;
        return Ok(still(id, name, width, height, rgba));
    }
    if ext == "gif" || bytes.starts_with(b"GIF8") {
        return decode_gif(id, name, bytes);
    }
    let img = image::load_from_memory(bytes).map_err(|e| format!("{name}: {e}"))?;
    let img = fit(img);
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(still(id, name, width, height, rgba.into_raw()))
}

fn still(id: u64, name: String, width: u32, height: u32, rgba: Vec<u8>) -> Asset {
    Asset { id, name, width, height, frames: vec![Frame { rgba, delay: Duration::ZERO }], duration: Duration::ZERO }
}

fn fit(img: image::DynamicImage) -> image::DynamicImage {
    if img.width() > MAX_PX || img.height() > MAX_PX {
        img.resize(MAX_PX, MAX_PX, image::imageops::FilterType::Triangle)
    } else {
        img
    }
}

fn decode_gif(id: u64, name: String, bytes: &[u8]) -> Result<Asset, String> {
    let decoder = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(bytes)).map_err(|e| format!("{name}: {e}"))?;
    let frames = decoder.into_frames().collect_frames().map_err(|e| format!("{name}: {e}"))?;
    let Some(first) = frames.first() else { return Err(format!("{name}: no frames")) };
    let (width, height) = first.buffer().dimensions();
    let mut out = Vec::with_capacity(frames.len());
    let mut duration = Duration::ZERO;
    for f in frames {
        let (n, d) = f.delay().numer_denom_ms();
        // Browsers clamp delays under 20 ms to 100 ms; match them so fast GIFs play as authored.
        let ms = if d == 0 { 100 } else { n / d };
        let delay = Duration::from_millis(if ms < 20 { 100 } else { u64::from(ms) });
        duration += delay;
        out.push(Frame { rgba: f.into_buffer().into_raw(), delay });
    }
    Ok(Asset { id, name, width, height, frames: out, duration })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svg_rasterizes_to_its_aspect() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>"#;
        let a = decode_bytes(1, "r.svg".into(), "svg", svg).expect("svg");
        assert_eq!((a.width, a.height), (2048, 1024));
        assert_eq!(&a.frames[0].rgba[..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn gif_frame_at_loops() {
        let mk = |ms| Frame { rgba: vec![], delay: Duration::from_millis(ms) };
        let a = Asset { id: 1, name: String::new(), width: 1, height: 1, frames: vec![mk(100), mk(200)], duration: Duration::from_millis(300) };
        assert_eq!(a.frame_at(0.05), 0);
        assert_eq!(a.frame_at(0.15), 1);
        assert_eq!(a.frame_at(0.35), 0);
    }
}
