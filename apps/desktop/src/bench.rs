//! Headless render benchmarks: the web app's `bench/` scenarios on the desktop compositor.
//!
//!     VOIDMESH_BENCH=<id> voidmesh --scene bench --frames <n> --size 1280x720 --scale 1
//!
//! `scripts/bench.sh` runs them all and compares with a recorded web run. Each scenario builds
//! the web's workspace (sources, display sizes, layout, effects, selection) and drives it the
//! same way frame by frame (viewport path, parameter tweaks, drags, marquee, forced reprocessing).
//! A frame's time is measured from one compositor frame to the next, the GPU waited on in
//! between, so it includes everything: Rune's update and layout, encoding, and the GPU work.
//! The web's batched scenarios drain the GPU once at the end, so this is the stricter count.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::effects::{Params, Shader};
use crate::media::{Asset, Frame, Kind, Original};
use crate::state::{App, Entity};

const CANVAS: (f32, f32) = (1280.0, 720.0);

#[derive(Clone, Copy)]
enum Look {
    Original,
    Dither8,
    Dither4,
    FlowingGlass { size: f32, intensity: f32, scale: f32, dispersion: f32, flow: f32 },
    Glitch,
    HalftoneBloom,
    Grain,
    /// The application's defaults (dithering, grain and bloom).
    Defaults,
}

#[derive(Clone, Copy, PartialEq)]
enum Layout {
    /// The web's `getEntityPosition`: a grid over the canvas, `createEntity`'s fitted size.
    Fitted,
    /// `getManyEntityPosition` "all-visible".
    AllVisible,
    /// `getManyEntityPosition` "world-grid".
    WorldGrid,
    /// The zoom-stress world grid of images and videos.
    Stress { paused: bool },
}

#[derive(Clone, Copy, PartialEq)]
enum View {
    Fixed,
    /// The world's origin at the canvas's top-left, at a zoom.
    At(f32),
    /// Pages through the world grid (`getManyEntityViewportOffset`) at a zoom.
    Pages(f32),
    /// 1% to 30% and back.
    ZoomRange(f32, f32),
    Stress,
    PausedPan,
}

#[derive(Clone, Copy)]
struct Spec {
    id: &'static str,
    count: usize,
    unique: usize,
    src: (u32, u32),
    display: Option<(f32, f32)>,
    layout: Layout,
    look: Look,
    view: View,
    mixed: bool,
    selected: Sel,
    tweak: bool,
    drag: bool,
    marquee: bool,
    frames: usize,
    warmup: usize,
    samples: usize,
    reset: bool,
    /// Seconds each frame advances the clocks: a video scenario's new frame every frame.
    step: f64,
    note: &'static str,
}

#[derive(Clone, Copy, PartialEq)]
enum Sel {
    None,
    Count(usize),
    Fraction(f32),
}

const BASE: Spec = Spec {
    id: "",
    count: 1,
    unique: 1,
    src: (1024, 1024),
    display: None,
    layout: Layout::Fitted,
    look: Look::Original,
    view: View::Fixed,
    mixed: false,
    selected: Sel::None,
    tweak: false,
    drag: false,
    marquee: false,
    frames: 60,
    warmup: 8,
    samples: 5,
    reset: false,
    step: 1.0 / 60.0,
    note: "",
};

#[allow(clippy::too_many_arguments)]
const fn many(id: &'static str, count: usize, unique: usize, src: u32, display: (f32, f32), layout: Layout, processed: bool, frames: usize, warmup: usize) -> Spec {
    Spec { id, count, unique, src: (src, src), display: Some(display), layout, look: if processed { Look::Dither4 } else { Look::Original }, frames, warmup, samples: 3, ..BASE }
}

const OVERVIEW: f32 = 0.18;

/// The web's scenarios, in its order.
const SPECS: &[Spec] = &[
    Spec { id: "image-original-4k-composition", src: (3840, 2160), frames: 180, warmup: 20, ..BASE },
    Spec { id: "image-dither-4k-upload-shader", src: (3840, 2160), look: Look::Dither8, frames: 60, warmup: 8, ..BASE },
    Spec { id: "image-flowing-glass-4k-continuous", src: (3840, 2160), look: Look::FlowingGlass { size: 40.0, intensity: 4.0, scale: 1.55, dispersion: 0.6, flow: 0.5 }, frames: 90, warmup: 12, ..BASE },
    Spec { id: "video-glitch-1080p-upload-shader", src: (1920, 1080), look: Look::Glitch, layout: Layout::Stress { paused: false }, count: 1, frames: 120, warmup: 20, step: 1.0 / 30.0, note: "an H.264 file decoded by AVFoundation (decoding untimed, as the web's canvas drawing is)", ..BASE },
    Spec { id: "image-bloom-1440p-stack", src: (2560, 1440), look: Look::HalftoneBloom, frames: 45, warmup: 6, ..BASE },
    Spec { id: "multi-25-flowing-glass-continuous", count: 25, unique: 25, look: Look::FlowingGlass { size: 28.0, intensity: 3.0, scale: 1.35, dispersion: 0.45, flow: 0.65 }, frames: 60, warmup: 10, ..BASE },
    Spec { id: "image-grain-4k-continuous-postprocess", src: (3840, 2160), look: Look::Grain, frames: 120, warmup: 16, note: "Show Original bypasses post-processing on the desktop", ..BASE },
    Spec { id: "multi-25-cached-composition", count: 25, unique: 25, frames: 180, warmup: 20, ..BASE },
    Spec { id: "multi-72-unique-cached-composition", count: 72, unique: 72, src: (512, 512), frames: 180, warmup: 20, ..BASE },
    many("many-10000-shared-original-all-visible", 10_000, 1, 1024, (10.0, 6.0), Layout::AllVisible, false, 12, 2),
    many("many-10000-shared-original-small-visible", 10_000, 1, 1024, (96.0, 96.0), Layout::WorldGrid, false, 60, 8),
    Spec { view: View::Pages(1.0), ..many("many-10000-shared-original-pan", 10_000, 1, 1024, (96.0, 96.0), Layout::WorldGrid, false, 90, 8) },
    many("many-4096-unique-thumbnails-all-visible", 4096, 4096, 128, (16.0, 10.0), Layout::AllVisible, false, 12, 2),
    Spec { view: View::Pages(1.0), ..many("many-4096-unique-thumbnails-pan", 4096, 4096, 192, (96.0, 96.0), Layout::WorldGrid, false, 90, 8) },
    many("many-2048-shared-processed-all-visible", 2048, 1, 128, (22.0, 14.0), Layout::AllVisible, true, 12, 2),
    many("many-16384-shared-processed-all-visible", 16_384, 1, 1024, (6.0, 6.0), Layout::AllVisible, true, 24, 4),
    Spec { view: View::Pages(OVERVIEW), ..many("many-131072-shared-processed-overview-pan", 131_072, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 18, 4) },
    Spec { view: View::Pages(OVERVIEW), ..many("many-262144-shared-processed-overview-pan", 262_144, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 18, 4) },
    Spec { view: View::Pages(OVERVIEW), mixed: true, ..many("many-262144-shared-mixed-static-overview-pan", 262_144, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 18, 4) },
    Spec { view: View::ZoomRange(0.01, 0.3), mixed: true, ..many("many-131072-shared-mixed-static-zoom-round-trip", 131_072, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 24, 4) },
    Spec { view: View::At(0.01), selected: Sel::Count(1), tweak: true, ..many("many-131072-shared-single-param-tweak", 131_072, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 24, 4) },
    Spec { view: View::At(0.01), mixed: true, selected: Sel::Count(1), drag: true, ..many("many-131072-shared-mixed-static-drag-single-selected", 131_072, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 24, 4) },
    Spec { view: View::Pages(OVERVIEW), selected: Sel::Count(1), ..many("many-262144-shared-processed-overview-pan-single-selected", 262_144, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 18, 4) },
    Spec { view: View::Pages(OVERVIEW), selected: Sel::Fraction(0.5), ..many("many-262144-shared-processed-overview-pan-half-selected", 262_144, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 18, 4) },
    Spec { view: View::Pages(OVERVIEW), selected: Sel::Fraction(1.0), ..many("many-262144-shared-processed-overview-pan-all-selected", 262_144, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 18, 4) },
    Spec { view: View::Pages(OVERVIEW), selected: Sel::Fraction(0.5), note: "the desktop has no debug borders: runs as half selected", ..many("many-262144-shared-processed-overview-pan-half-selected-debug", 262_144, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 18, 4) },
    Spec { view: View::At(OVERVIEW), selected: Sel::Fraction(0.5), drag: true, ..many("many-262144-shared-processed-overview-drag-half-selected", 262_144, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 18, 4) },
    Spec { view: View::At(OVERVIEW), marquee: true, ..many("many-262144-shared-processed-overview-drag-select", 262_144, 1, 1024, (6.0, 6.0), Layout::WorldGrid, true, 18, 4) },
    // Mostly unique media: the realistic workspace (also in the web's `many-entity` suite).
    Spec { id: "many-512-unique-photos-mixed-pan", count: 512, unique: 512, src: (768, 512), display: Some((240.0, 160.0)), layout: Layout::WorldGrid, look: Look::Dither4, mixed: true, view: View::Pages(0.5), frames: 90, warmup: 8, samples: 3, ..BASE },
    Spec { id: "many-512-unique-photos-mixed-zoom-round-trip", count: 512, unique: 512, src: (768, 512), display: Some((240.0, 160.0)), layout: Layout::WorldGrid, look: Look::Dither4, mixed: true, view: View::ZoomRange(0.05, 0.6), frames: 60, warmup: 8, samples: 3, ..BASE },
    Spec { id: "many-2048-unique-photos-mixed-overview-zoom", count: 2048, unique: 2048, src: (384, 256), display: Some((240.0, 160.0)), layout: Layout::WorldGrid, look: Look::Dither4, mixed: true, view: View::ZoomRange(0.02, 0.25), frames: 60, warmup: 8, samples: 3, ..BASE },
    Spec { id: "zoom-61-unique-mixed-round-trip", count: 61, unique: 61, src: (2048, 1365), layout: Layout::Stress { paused: false }, view: View::Stress, frames: 120, warmup: 4, samples: 3, reset: true, ..BASE },
    Spec { id: "zoom-61-unique-mixed-processed-round-trip", count: 61, unique: 61, src: (2048, 1365), layout: Layout::Stress { paused: false }, look: Look::Defaults, view: View::Stress, frames: 120, warmup: 4, samples: 3, reset: true, ..BASE },
    Spec { id: "pan-61-unique-mixed-paused-videos", count: 61, unique: 61, src: (2048, 1365), layout: Layout::Stress { paused: true }, view: View::PausedPan, frames: 240, warmup: 30, samples: 5, ..BASE },
];

pub fn ids() -> impl Iterator<Item = &'static str> {
    SPECS.iter().map(|s| s.id)
}

fn params(look: Look) -> Params {
    let neutral = |mut p: Params| {
        (p.brightness, p.contrast, p.saturation, p.blur) = (0.5, 0.5, 0.5, 0.0);
        p
    };
    let mut p = Params::default();
    match look {
        Look::Original => {
            p.show_original = true;
            p.post = false;
        }
        Look::Dither8 | Look::Dither4 => {
            p.set_shader(Shader::Dithering);
            (p.size, p.scale, p.post) = (1.0, 1.0, false);
            p.preserve_colors = matches!(look, Look::Dither4);
            p.dither_kind = if matches!(look, Look::Dither4) { 1 } else { 2 };
        }
        Look::FlowingGlass { size, intensity, scale, dispersion, flow } => {
            p.set_shader(Shader::Glass);
            p.set_glass_kind(2);
            (p.size, p.intensity, p.scale, p.post) = (size, intensity, scale, false);
            (p.glass_angle, p.caustic, p.frostiness, p.highlight, p.dispersion, p.flow) = (0.0, 1.0, 0.8, 0.1, dispersion, flow);
            p.time_autoplay = true;
        }
        Look::Glitch => {
            p.set_shader(Shader::Glitch);
            (p.size, p.intensity, p.scale, p.preserve_colors, p.post) = (25.0, 1.0, 1.0, true, false);
        }
        Look::HalftoneBloom => {
            p.set_shader(Shader::Halftone);
            (p.size, p.intensity, p.scale, p.preserve_colors) = (10.0, 1.0, 1.0, true);
            (p.post, p.grain, p.grain_size, p.grain_intensity) = (true, true, 1.0, 0.12);
            (p.bloom, p.bloom_threshold, p.bloom_intensity, p.bloom_radius, p.bloom_softness) = (true, 0.35, 0.2, 21.0, 0.1);
            (p.chroma, p.chroma_offset) = (true, 3.0);
        }
        Look::Grain => {
            p.show_original = true;
            (p.post, p.grain, p.grain_size, p.grain_intensity, p.bloom, p.chroma) = (true, true, 1.25, 0.15, false, false);
        }
        Look::Defaults => return p,
    }
    neutral(p)
}

/// The web's `createSyntheticThumbnailBitmap`: a fill, an inset block and a stripe, by seed.
fn synthetic(id: u64, (w, h): (u32, u32), seed: u32) -> Asset {
    let hsl = |hue: u32, s: f32, l: f32| {
        let h = (hue % 360) as f32 / 60.0;
        let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
        let x = c * (1.0 - (h % 2.0 - 1.0).abs());
        let (r, g, b) = match h as u32 {
            0 => (c, x, 0.0),
            1 => (x, c, 0.0),
            2 => (0.0, c, x),
            3 => (0.0, x, c),
            4 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        let m = l - c / 2.0;
        [((r + m) * 255.0) as u8, ((g + m) * 255.0) as u8, ((b + m) * 255.0) as u8, 255]
    };
    let (fill, block, stripe_c) = (hsl(seed * 47, 0.72, 0.42), hsl(seed * 83 + 120, 0.82, 0.64), hsl(seed * 131 + 240, 0.76, 0.24));
    let inset = (w.min(h) as f32 * 0.12).round().max(2.0) as u32;
    let stripe = (w as f32 * 0.08).round().max(2.0) as u32;
    let sx = (seed * 17) % (w - stripe).max(1);
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let c = if x >= sx && x < sx + stripe {
                stripe_c
            } else if x >= inset && x < w - inset && y >= inset && y < h - inset {
                block
            } else {
                fill
            };
            rgba.extend_from_slice(&c);
        }
    }
    Asset {
        id,
        name: format!("bench-{seed}.png"),
        kind: Kind::Image,
        width: w,
        height: h,
        frames: vec![Frame { rgba, delay: Duration::ZERO }],
        duration: Duration::ZERO,
        original: Original::Bytes(Arc::from(Vec::new())),
        ext: "png".into(),
        palette: None,
        video: None,
        blob: Default::default(),
        proxy: Default::default(),
    }
}

/// `createEntity`'s display size for media of `src`.
fn fitted((w, h): (u32, u32)) -> (f32, f32) {
    let (w, h) = (w as f32, h as f32);
    let k = if w > CANVAS.0 || h > CANVAS.1 { (CANVAS.0 * 0.78 / w).min(CANVAS.1 * 0.78 / h) } else { (CANVAS.0 * 0.22 / w).min(1.0) };
    ((w * k).round().max(1.0), (h * k).round().max(1.0))
}

fn world_grid(count: usize, d: (f32, f32)) -> (usize, f32) {
    let columns = (count as f32).sqrt().ceil() as usize;
    let gap = (d.0.max(d.1) * 0.25).round().max(16.0);
    (columns, gap)
}

fn position(spec: &Spec, i: usize, d: (f32, f32)) -> [f32; 2] {
    let n = spec.count;
    match spec.layout {
        Layout::Fitted | Layout::Stress { .. } if n == 1 => [(CANVAS.0 - d.0) / 2.0, (CANVAS.1 - d.1) / 2.0],
        Layout::Fitted => {
            let cols = (n as f32).sqrt().ceil() as usize;
            let rows = n.div_ceil(cols);
            let (cw, ch) = (CANVAS.0 / cols as f32, CANVAS.1 / rows as f32);
            [(i % cols) as f32 * cw + cw * 0.14, (i / cols) as f32 * ch + ch * 0.14]
        }
        Layout::AllVisible => {
            let preferred = (n as f32 * (CANVAS.0 / CANVAS.1)).sqrt().ceil() as usize;
            let fitting = ((CANVAS.0 / d.0).floor() as usize).max(1);
            let cols = preferred.min(fitting);
            let rows = n.div_ceil(cols);
            let (cw, ch) = (CANVAS.0 / cols as f32, CANVAS.1 / rows as f32);
            [(i % cols) as f32 * cw + (cw - d.0) / 2.0, (i / cols) as f32 * ch + (ch - d.1) / 2.0]
        }
        Layout::WorldGrid => {
            let (cols, gap) = world_grid(n, d);
            [(i % cols) as f32 * (d.0 + gap), (i / cols) as f32 * (d.1 + gap)]
        }
        Layout::Stress { .. } => [(i % 8) as f32 * 680.0, (i / 8) as f32 * 480.0],
    }
}

/// The web's viewport at frame `k` (sample frame `j`): world point at the canvas's top-left and
/// pixels per world unit.
fn viewport(spec: &Spec, d: (f32, f32), k: usize, j: usize) -> ([f32; 2], f32) {
    let pages = |zoom: f32| {
        let (cols, gap) = world_grid(spec.count, d);
        let rows = spec.count.div_ceil(cols);
        let (ww, wh) = (cols as f32 * (d.0 + gap), rows as f32 * (d.1 + gap));
        let (mx, my) = ((ww - CANVAS.0).max(0.0), (wh - CANVAS.1).max(0.0));
        let page = k / 3;
        let px = ((ww / CANVAS.0).ceil() as usize).max(1);
        let (xp, yp) = (page % px, (page / px) % ((wh / CANVAS.1).ceil() as usize).max(1));
        ([mx.min(xp as f32 * CANVAS.0), my.min(yp as f32 * CANVAS.1)], zoom)
    };
    match spec.view {
        View::Fixed => ([0.0, 0.0], 1.0),
        View::At(z) => ([0.0, 0.0], z),
        View::Pages(z) => pages(z),
        View::ZoomRange(min, max) => {
            if k < spec.warmup {
                return ([0.0, 0.0], min);
            }
            let cycle = (spec.frames - 1).max(2) as f32;
            let g = ((k - spec.warmup) % spec.frames) as f32 / cycle;
            ([0.0, 0.0], min + (max - min) * (1.0 - (g * 2.0 - 1.0).abs()))
        }
        View::Stress => {
            let n = 4 + 44 + 8 + 60 + 4;
            let i = j % n;
            let ease = |from: f32, to: f32, t: f32| {
                let t = t.clamp(0.0, 1.0);
                let e = t * t * (3.0 - 2.0 * t);
                (from.ln() + (to.ln() - from.ln()) * e).exp()
            };
            let (detail, overview) = (2.2, 0.14);
            let zoom = match i {
                i if i < 4 => detail,
                i if i < 48 => ease(detail, overview, (i - 4 + 1) as f32 / 44.0),
                i if i < 56 => overview,
                i if i < 116 => ease(overview, detail, (i - 56 + 1) as f32 / 60.0),
                _ => detail,
            };
            // The target: entity 29's centre.
            let t = [(29 % 8) as f32 * 680.0 + 210.0, (29 / 8) as f32 * 480.0 + 140.0];
            ([t[0] - CANVAS.0 / (2.0 * zoom), t[1] - CANVAS.1 / (2.0 * zoom)], zoom)
        }
        View::PausedPan => {
            let p = (j % spec.frames) as f32 / spec.frames as f32;
            ([1650.0 + (p * std::f32::consts::PI * 4.0).sin() * 900.0, 1500.0 + (p * std::f32::consts::PI * 3.0).cos() * 600.0], 0.32)
        }
    }
}

/// One measured frame.
#[derive(Clone, Copy, Default)]
pub struct Row {
    /// Rune's frame: input, poll, view, layout (ms).
    pub update: f64,
    /// The compositor: canvas sync, processing, encoding (ms).
    pub render: f64,
    /// From this frame's start to the next's, the GPU waited on between (ms).
    pub wall: f64,
    pub visible: usize,
    pub processed: usize,
    pub resident: u64,
    pub draws: usize,
}

pub struct Bench {
    spec: Spec,
    display: (f32, f32),
    /// Frames stepped so far.
    pub frame: usize,
    /// Reprocess everything this frame (the web's `textureDirty`, or a sample's texture reset).
    pub dirty: bool,
    started: Option<Instant>,
    rows: Vec<Row>,
    setup_ms: f64,
    done: bool,
}

impl Bench {
    fn total(&self) -> usize {
        self.spec.warmup + self.spec.frames * self.spec.samples
    }

    /// Frames a run needs: warmup, the samples, and one more to time the last.
    pub fn frames_needed(id: &str) -> Option<usize> {
        SPECS.iter().find(|s| s.id == id).map(|s| s.warmup + s.frames * s.samples + 2)
    }

    /// Before frame `self.frame` builds: move the camera and drive the scenario.
    pub fn step(&mut self, s: &mut App) {
        let k = self.frame;
        let spec = self.spec;
        let j = k.saturating_sub(spec.warmup);
        let (offset, zoom) = viewport(&spec, self.display, k, j);
        s.cam.set([-offset[0] * zoom / s.device_scale, -offset[1] * zoom / s.device_scale], zoom / s.device_scale);
        // The web's `textureDirty` on an unchanged still reuses its processed texture (it's keyed by
        // content, `canReuseDirtyTexture`), as materials here are: only a sample's reset reprocesses.
        self.dirty = spec.reset && k >= spec.warmup && j.is_multiple_of(spec.frames);
        if spec.tweak {
            let id = (spec.count / 2) as u32 + 1;
            if let Some(e) = s.entity_mut(id) {
                let mut p = (*e.params).clone();
                p.size = 1.0 + (k % 24) as f32 * 0.125;
                e.params = Arc::new(p);
            }
        }
        if spec.drag {
            // As a pointer drag of the selection runs (`ui/canvas.rs`): the offset moves, the
            // entities move when it ends.
            if s.drag.is_none() {
                let ids = s.selected().map(|e| (e.id, e.pos)).collect();
                s.drag = Some(crate::state::MoveDrag { ids, before: s.snapshot(), moved: true, collapse_to: None, toggle_play: None, clear_on_click: false, offset: [0.0; 2] });
            }
            if let Some(m) = s.drag.as_mut() {
                m.offset = [j as f32 * 16.0, j as f32 * -8.0];
            }
        }
        if spec.marquee {
            let start = s.cam.screen([0.0, 0.0]);
            let end = s.cam.screen([(j + 1) as f32 * 180.0, (j + 1) as f32 * 120.0]);
            s.marquee = Some(crate::state::Marquee { start, end, mode: crate::state::MarqueeMode::Replace, base: BTreeSet::new() });
            s.update_marquee();
        }
        self.frame += 1;
    }

    /// After the compositor's frame: its counters and times.
    pub fn record(&mut self, start: Instant, update: f64, render: f64, stats: Option<crate::gfx::scene::Stats>) {
        if self.done {
            return;
        }
        if let (Some(prev), Some(last)) = (self.started, self.rows.last_mut()) {
            last.wall = start.duration_since(prev).as_secs_f64() * 1000.0;
        }
        self.started = Some(start);
        if self.rows.len() == self.total() {
            self.done = true;
            println!("voidmesh-bench {}", self.report());
            return;
        }
        let st = stats.unwrap_or_default();
        self.rows.push(Row { update, render, wall: 0.0, visible: st.visible, processed: st.processed, resident: st.resident_bytes, draws: st.draws });
    }

    fn report(&self) -> serde_json::Value {
        let spec = &self.spec;
        let measured = &self.rows[spec.warmup..];
        let p = |mut v: Vec<f64>, q: f64| {
            v.sort_by(f64::total_cmp);
            if v.is_empty() { 0.0 } else { v[((v.len() - 1) as f64 * q).round() as usize] }
        };
        let mean = |v: &[f64]| if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 };
        let wall: Vec<f64> = measured.iter().map(|r| r.wall).collect();
        let render: Vec<f64> = measured.iter().map(|r| r.render).collect();
        let cpu: Vec<f64> = measured.iter().map(|r| r.render + r.update).collect();
        // Each sample's mean frame, the GPU waited on every frame; the median sample.
        let per_sample: Vec<f64> = measured.chunks(spec.frames).map(|c| c.iter().map(|r| r.wall).sum::<f64>() / c.len() as f64).collect();
        serde_json::json!({
            "id": spec.id,
            "entities": spec.count,
            "frames": spec.frames,
            "samples": spec.samples,
            "setupMs": self.setup_ms,
            "mode": "app",
            "msPerFrame": p(per_sample, 0.5),
            "draws": measured.iter().map(|r| r.draws).max().unwrap_or(0),
            "wallMeanMs": mean(&wall),
            "wallP95Ms": p(wall.clone(), 0.95),
            "renderP95Ms": p(render.clone(), 0.95),
            "renderMeanMs": mean(&render),
            "cpuP95Ms": p(cpu.clone(), 0.95),
            "cpuMeanMs": mean(&cpu),
            "visibleMean": measured.iter().map(|r| r.visible as f64).sum::<f64>() / measured.len().max(1) as f64,
            "processed": measured.iter().map(|r| r.processed).sum::<usize>(),
            "peakResidentBytes": self.rows.iter().map(|r| r.resident).max().unwrap_or(0),
            "note": spec.note,
        })
    }
}

/// The `bench` scene: the scenario `VOIDMESH_BENCH` names.
pub fn scene(s: &mut App) {
    let t0 = Instant::now();
    let Some(spec) = std::env::var("VOIDMESH_BENCH").ok().and_then(|id| SPECS.iter().find(|s| s.id == id).copied()) else {
        eprintln!("VOIDMESH_BENCH: one of {}", ids().collect::<Vec<_>>().join(", "));
        return;
    };
    s.canvas = [0.0, 0.0, CANVAS.0, CANVAS.1];
    s.bare = true;
    if let Some(sc) = rune::tooling::headless_run().map(|r| r.scale()) {
        s.device_scale = sc;
    }
    let display = spec.display.unwrap_or_else(|| fitted(spec.src));
    let video = std::env::var_os("VOIDMESH_BENCH_VIDEO").map(std::path::PathBuf::from);
    let shared: Vec<Arc<Asset>> = (0..spec.unique.min(spec.count)).map(|i| Arc::new(synthetic(crate::media::next_asset_id(), spec.src, i as u32 + 1))).collect();
    // As decoding does on the loader thread.
    for a in &shared {
        a.proxy();
    }
    let look = Arc::new(params(spec.look));
    // Mixed: contiguous quarters of dithering, dithering as original, ASCII, ASCII as original.
    let mixed: Vec<Arc<Params>> = (0..4)
        .map(|seg| {
            let mut p = params(spec.look);
            if seg >= 2 {
                p.set_shader(Shader::Ascii);
                (p.size, p.scale, p.preserve_colors, p.post) = (1.0, 1.0, true, false);
            }
            p.show_original = seg % 2 == 1;
            Arc::new(p)
        })
        .collect();
    let mut entities = Vec::with_capacity(spec.count);
    for i in 0..spec.count {
        let is_video = match spec.layout {
            Layout::Stress { paused: false } if spec.count == 1 => true,
            Layout::Stress { paused: false } => i % 4 == 0,
            Layout::Stress { paused: true } => i % 15 == 0 && i / 15 < 4,
            _ => false,
        };
        let (asset, d) = if is_video {
            let Some(path) = video.clone() else {
                eprintln!("VOIDMESH_BENCH_VIDEO: a video file is needed for {}", spec.id);
                return;
            };
            match crate::media::decode_video(crate::media::next_asset_id(), format!("video-{i}.mp4"), "mp4".into(), path) {
                Ok(a) => (Arc::new(a), if spec.count == 1 { fitted(spec.src) } else { (420.0, 236.0) }),
                Err(e) => {
                    eprintln!("{e}");
                    return;
                }
            }
        } else {
            let d = if matches!(spec.layout, Layout::Stress { .. }) { (420.0, 280.0) } else { display };
            (shared[i % shared.len()].clone(), d)
        };
        let pos = position(&spec, i, d);
        let params = if spec.mixed { mixed[((i * 4) / spec.count).min(3)].clone() } else { look.clone() };
        let id = i as u32 + 1;
        let mut e = Entity::new(id, asset, pos, id, params);
        e.size = [d.0, d.1];
        e.playing = is_video && !matches!(spec.layout, Layout::Stress { paused: true });
        entities.push(e);
    }
    s.next_id = spec.count as u32 + 1;
    s.next_z = spec.count as u32 + 1;
    s.entities = entities.into();
    let selected = match spec.selected {
        Sel::None => 0,
        Sel::Count(n) => n,
        Sel::Fraction(f) => (spec.count as f32 * f) as usize,
    };
    s.selection = if spec.tweak { [(spec.count / 2) as u32 + 1].into_iter().collect() } else { (1..=selected as u32).collect() };
    s.bench = Some(Box::new(Bench { spec, display, frame: 0, dirty: false, started: None, rows: Vec::new(), setup_ms: t0.elapsed().as_secs_f64() * 1000.0, done: false }));
}

/// The compositor alone, as the web's bench drives its renderer: `VOIDMESH_BENCH=<id>
/// voidmesh` with `VOIDMESH_BENCH_DIRECT=1`. Frames are encoded and submitted back to back, up
/// to three in flight (as a swapchain's drawables allow), and the GPU is drained at the end of
/// each sample: a sample's wall time over its frames is the web's `msPerFrame`. CPU time per frame
/// covers the canvas's sync, visibility, processing, encoding and submission, not waiting for
/// the GPU.
pub fn run_direct() {
    // A GUI app's main thread runs at this class; a process started from a shell doesn't.
    crate::gfx::process::interactive();
    let scale: f32 = std::env::var("VOIDMESH_BENCH_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);
    let gpu = match rune::render::Gpu::try_with_features(rune::render::Gpu::instance(), None, wgpu::Features::IMMEDIATES) {
        Ok(g) => g,
        Err(e) => return eprintln!("{e}"),
    };
    let (device, queue) = (&gpu.device, &gpu.queue);
    let mut s = App::default();
    s.device_scale = scale;
    scene(&mut s);
    let Some(mut bench) = s.bench.take() else { return };
    let size = ((CANVAS.0 * scale) as u32, (CANVAS.1 * scale) as u32);
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("voidmesh bench"),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let mut direct = crate::gfx::Direct::new(device, queue);
    let drain = || {
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
    };
    const IN_FLIGHT: usize = 8;
    let mut in_flight = std::collections::VecDeque::with_capacity(IN_FLIGHT + 1);
    let spec = bench.spec;
    let mut cpu = Vec::new();
    let mut samples = Vec::new();
    let mut sample_start = Instant::now();
    let mut peak = 0u64;
    let mut peak_extra = 0u64;
    let (mut visible, mut processed) = (0usize, 0usize);
    for k in 0..bench.total() {
        let measuring = k >= spec.warmup;
        if measuring && (k - spec.warmup).is_multiple_of(spec.frames) {
            drain();
            sample_start = Instant::now();
        }
        bench.dirty = false;
        bench.step(&mut s);
        s.tick(spec.step);
        s.bench = Some(bench);
        // Decoding stays out of the timing, as the web's synthetic video drawing does.
        let wait = Instant::now();
        while !direct.scene.videos_ready(&s) && wait.elapsed() < Duration::from_millis(250) {
            std::thread::sleep(Duration::from_micros(200));
        }
        sample_start += wait.elapsed();
        // At most `IN_FLIGHT` frames queued, as a swapchain's drawables allow: a GPU-bound frame
        // waits here, in the sample's wall time but not in the frame's CPU time, rather than in
        // whichever call finds Metal's queue full.
        if in_flight.len() >= IN_FLIGHT
            && let Some(i) = in_flight.pop_front()
        {
            let _ = device.poll(wgpu::PollType::Wait { submission_index: Some(i), timeout: None });
        }
        let t0 = Instant::now();
        let mut enc = device.create_command_encoder(&Default::default());
        direct.frame(device, queue, &mut enc, &view, format, size, &mut s, scale);
        in_flight.push_back(queue.submit([enc.finish()]));
        let _ = device.poll(wgpu::PollType::Poll);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let Some(b) = s.bench.take() else { return };
        bench = b;
        let st = direct.scene.stats;
        peak = peak.max(st.resident_bytes);
        peak_extra = peak_extra.max(st.video_bytes + st.staging_bytes);
        if measuring {
            cpu.push(ms);
            visible += st.visible;
            processed += st.processed;
            if (k + 1 - spec.warmup).is_multiple_of(spec.frames) {
                drain();
                samples.push(sample_start.elapsed().as_secs_f64() * 1000.0 / spec.frames as f64);
            }
        }
    }
    let p = |mut v: Vec<f64>, q: f64| {
        v.sort_by(f64::total_cmp);
        if v.is_empty() { 0.0 } else { v[((v.len() - 1) as f64 * q).round() as usize] }
    };
    let n = cpu.len().max(1) as f64;
    let report = serde_json::json!({
        "id": spec.id,
        "mode": "direct",
        "entities": spec.count,
        "frames": spec.frames,
        "samples": spec.samples,
        "setupMs": bench.setup_ms,
        "msPerFrame": p(samples.clone(), 0.5),
        "sampleMsPerFrame": samples,
        "cpuMeanMs": cpu.iter().sum::<f64>() / n,
        "cpuP95Ms": p(cpu.clone(), 0.95),
        "visibleMean": visible as f64 / n,
        "processed": processed,
        "peakResidentBytes": peak,
        "peakVideoAndStagingBytes": peak_extra,
        "note": spec.note,
    });
    println!("voidmesh-bench {report}");
}
