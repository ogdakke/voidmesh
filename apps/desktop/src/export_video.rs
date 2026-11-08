//! Video and GIF export (FEATURES.md §9.2): a queue of jobs run one at a time on a worker thread
//! with its own headless GPU device, so the canvas never waits on it. Each job renders the
//! entity's source frames at the target frame rate through the effect pipeline at native size,
//! then encodes: H.264 in MP4 or MOV through AVFoundation (the source's audio copied through), or
//! a GIF with one global palette.
//!
//! Output is written beside the chosen path under a hidden name and moved into place once
//! complete, so a cancelled or failed job never leaves a partial file at the destination.

use std::borrow::Cow;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::effects::Params;
use crate::gfx::process::{self, Pipes};
use crate::media::{Asset, Loader};
use crate::state::App;
use crate::video::{FrameReader, VideoFrame};

// ------------------------------------------------------------------ options

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Mp4,
    Mov,
    Gif,
}

impl Format {
    pub const ALL: [Format; 3] = [Format::Mp4, Format::Mov, Format::Gif];
    pub const LABELS: [&'static str; 3] = ["MP4 (H.264)", "MOV (H.264)", "GIF"];

    pub fn ext(self) -> &'static str {
        match self {
            Format::Mp4 => "mp4",
            Format::Mov => "mov",
            Format::Gif => "gif",
        }
    }

    pub fn is_gif(self) -> bool {
        self == Format::Gif
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    High,
    Medium,
    Low,
}

impl Quality {
    pub const ALL: [Quality; 3] = [Quality::High, Quality::Medium, Quality::Low];
    pub const LABELS: [&'static str; 3] = ["High", "Medium", "Low"];

    /// Multiplier on the resolution-scaled base bitrate.
    pub fn factor(self) -> f64 {
        match self {
            Quality::High => 1.5,
            Quality::Medium => 1.0,
            Quality::Low => 0.6,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    Original,
    P1080,
    P720,
    P480,
}

impl Resolution {
    pub const ALL: [Resolution; 4] = [Resolution::Original, Resolution::P1080, Resolution::P720, Resolution::P480];
    pub const LABELS: [&'static str; 4] = ["Original", "1080p", "720p", "480p"];

    /// The box the output fits in, or None to keep the source size.
    fn bounds(self) -> Option<(u32, u32)> {
        match self {
            Resolution::Original => None,
            Resolution::P1080 => Some((1920, 1080)),
            Resolution::P720 => Some((1280, 720)),
            Resolution::P480 => Some((854, 480)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dither {
    FloydSteinberg,
    None,
}

impl Dither {
    pub const ALL: [Dither; 2] = [Dither::FloydSteinberg, Dither::None];
    pub const LABELS: [&'static str; 2] = ["Floyd–Steinberg", "None"];
}

/// UI ranges, as `config.videoExporting.ui`.
pub const FPS_MAX: u32 = 60;
pub const GIF_FPS_MAX: u32 = 30;
pub const GIF_WIDTH: (u32, u32, u32) = (100, 1920, 10);
pub const BITRATE_KBPS: (u32, u32, u32) = (1_000, 50_000, 100);
/// Colours in a GIF's global palette.
const GIF_COLORS: usize = 128;
/// Bitrate at 1920×1080 before the quality factor.
const BITRATE_1080P: f64 = 25_000_000.0;
/// Seconds between keyframes.
pub const KEYFRAME_SECONDS: u32 = 2;

#[derive(Clone, Debug, PartialEq)]
pub struct Options {
    pub format: Format,
    pub fps: u32,
    pub quality: Quality,
    pub include_audio: bool,
    /// Overrides the automatic bitrate.
    pub bitrate_kbps: Option<u32>,
    pub resolution: Resolution,
    pub dither: Dither,
    pub gif_max_width: u32,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            format: Format::Mp4,
            fps: 30,
            quality: Quality::High,
            include_audio: true,
            bitrate_kbps: None,
            resolution: Resolution::Original,
            dither: Dither::FloydSteinberg,
            gif_max_width: 256,
        }
    }
}

impl Options {
    /// The frame rate this format encodes at.
    pub fn effective_fps(&self) -> u32 {
        self.fps.clamp(1, if self.format.is_gif() { GIF_FPS_MAX } else { FPS_MAX })
    }
}

/// Rounds down to even (codecs need it), at least 2.
pub fn even(v: u32) -> u32 {
    (v / 2 * 2).max(2)
}

/// The encoded size: the source fitted inside the preset's box (never upscaled, aspect kept), even.
pub fn target_size(src: (u32, u32), res: Resolution) -> (u32, u32) {
    let (w, h) = (src.0.max(1), src.1.max(1));
    let Some((bw, bh)) = res.bounds() else { return (even(w), even(h)) };
    let aspect = f64::from(w) / f64::from(h);
    let (tw, th) = if aspect > f64::from(bw) / f64::from(bh) {
        let tw = w.min(bw);
        (tw, (f64::from(tw) / aspect).round() as u32)
    } else {
        let th = h.min(bh);
        ((f64::from(th) * aspect).round() as u32, th)
    };
    (even(tw), even(th))
}

/// Bits per second: 25 Mbps at 1080p scaled by pixel count and quality, unless overridden.
pub fn bitrate(size: (u32, u32), quality: Quality, override_kbps: Option<u32>) -> u32 {
    if let Some(kbps) = override_kbps {
        return kbps.saturating_mul(1000);
    }
    let pixels = f64::from(size.0) * f64::from(size.1);
    (BITRATE_1080P * pixels / (1920.0 * 1080.0) * quality.factor()).round() as u32
}

/// A GIF's size: at most `max_width` wide, aspect kept, even.
pub fn gif_size(src: (u32, u32), max_width: u32) -> (u32, u32) {
    let (w, h) = (src.0.max(1), src.1.max(1));
    if w <= max_width {
        return (even(w), even(h));
    }
    let k = f64::from(max_width) / f64::from(w);
    (even(max_width), even((f64::from(h) * k).round() as u32))
}

/// Frames covering `duration` seconds at `fps`.
pub fn frame_count(duration: f64, fps: u32) -> u32 {
    ((duration * f64::from(fps) - 1e-6).ceil() as u32).max(1)
}

/// GIF frame delays in centiseconds, carrying the rounding so the clip keeps time.
pub fn gif_delays(n: u32, fps: u32) -> Vec<u16> {
    let nominal = 100.0 / f64::from(fps.max(1));
    let mut carry = 0.0;
    (0..n)
        .map(|_| {
            let ideal = nominal + carry;
            let d = ideal.round();
            carry = ideal - d;
            d as u16
        })
        .collect()
}

/// Whether an entity can export as video: it has a timeline (a video or an animated GIF).
/// A still with an animated effect can't, as on the web.
pub fn exportable(asset: &Asset) -> bool {
    asset.animated()
}

// ------------------------------------------------------------------ queue

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Queued,
    Processing,
    Completed,
    Failed(String),
    Cancelled,
}

impl Status {
    pub fn active(&self) -> bool {
        matches!(self, Status::Queued | Status::Processing)
    }
}

#[derive(Clone, Debug)]
pub struct JobInfo {
    pub id: u64,
    pub name: String,
    pub status: Status,
    /// 0–1.
    pub progress: f32,
    /// What the job is doing, for display.
    pub stage: String,
}

/// Everything a job needs, captured when it's queued.
pub struct Spec {
    pub asset: Arc<Asset>,
    pub params: Params,
    /// The effect clock when queued: an animated effect runs on from here.
    pub fx_t: f64,
    pub options: Options,
    pub path: PathBuf,
}

struct Job {
    info: JobInfo,
    cancel: Arc<AtomicBool>,
    /// Taken by the worker when the job starts.
    spec: Option<Spec>,
}

/// The job list the UI and the worker share.
#[derive(Default)]
struct Queue {
    jobs: Vec<Job>,
    /// A worker thread is draining the queue.
    running: bool,
    next_id: u64,
    /// Bumped by every change, so the UI redraws only when something moved.
    version: u64,
}

enum Failure {
    Cancelled,
    Error(String),
}

impl From<String> for Failure {
    fn from(e: String) -> Self {
        Failure::Error(e)
    }
}

impl From<&str> for Failure {
    fn from(e: &str) -> Self {
        Failure::Error(e.to_string())
    }
}

impl Queue {
    fn push(&mut self, name: String, spec: Spec) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        let info = JobInfo { id, name, status: Status::Queued, progress: 0.0, stage: "Queued".into() };
        self.jobs.push(Job { info, cancel: Arc::new(AtomicBool::new(false)), spec: Some(spec) });
        self.version += 1;
        id
    }

    /// The oldest queued job, now processing.
    fn take_next(&mut self) -> Option<(u64, Spec, Arc<AtomicBool>)> {
        let job = self.jobs.iter_mut().find(|j| j.info.status == Status::Queued)?;
        let spec = job.spec.take()?;
        job.info.status = Status::Processing;
        job.info.stage = "Starting…".into();
        self.version += 1;
        Some((job.info.id, spec, job.cancel.clone()))
    }

    fn progress(&mut self, id: u64, progress: f32, stage: String) {
        if let Some(j) = self.jobs.iter_mut().find(|j| j.info.id == id) {
            j.info.progress = progress.clamp(0.0, 1.0);
            j.info.stage = stage;
            self.version += 1;
        }
    }

    fn finish(&mut self, id: u64, result: &Result<(), Failure>) {
        if let Some(j) = self.jobs.iter_mut().find(|j| j.info.id == id) {
            j.info.status = match result {
                Ok(()) => Status::Completed,
                Err(Failure::Cancelled) => Status::Cancelled,
                Err(Failure::Error(e)) => Status::Failed(e.clone()),
            };
            if result.is_ok() {
                j.info.progress = 1.0;
            }
            j.info.stage = match &j.info.status {
                Status::Completed => "Saved",
                Status::Cancelled => "Cancelled",
                _ => "Failed",
            }
            .into();
            self.version += 1;
        }
    }

    /// A queued job is cancelled at once; a processing one stops at its next frame.
    fn cancel(&mut self, id: u64) {
        let Some(j) = self.jobs.iter_mut().find(|j| j.info.id == id) else { return };
        match j.info.status {
            Status::Queued => {
                j.spec = None;
                j.info.status = Status::Cancelled;
                j.info.stage = "Cancelled".into();
            }
            Status::Processing => {
                j.cancel.store(true, Ordering::Relaxed);
                j.info.stage = "Cancelling…".into();
            }
            _ => return,
        }
        self.version += 1;
    }

    /// Drops finished jobs.
    fn clear(&mut self) {
        self.jobs.retain(|j| j.info.status.active());
        self.version += 1;
    }
}

/// An open export panel: the entities it exports (the selection's videos and GIFs, in
/// insertion order) and whether Advanced is unfolded.
pub struct Panel {
    pub entities: Vec<u32>,
    pub advanced: bool,
}

/// The export queue and the panel's state. `App::export`.
#[derive(Default)]
pub struct Exports {
    queue: Arc<Mutex<Queue>>,
    /// The panel's settings; they carry over between exports.
    pub options: Options,
    pub panel: Option<Panel>,
    /// The queue indicator's job list is open.
    pub list_open: bool,
    seen: u64,
}

fn lock(q: &Mutex<Queue>) -> MutexGuard<'_, Queue> {
    // A worker panic while holding the lock leaves plain data; keep using it.
    q.lock().unwrap_or_else(|e| e.into_inner())
}

impl Exports {
    /// Jobs, newest first.
    pub fn jobs(&self) -> Vec<JobInfo> {
        lock(&self.queue).jobs.iter().rev().map(|j| j.info.clone()).collect()
    }

    pub fn cancel(&self, id: u64) {
        lock(&self.queue).cancel(id);
    }

    pub fn clear_finished(&mut self) {
        lock(&self.queue).clear();
        if lock(&self.queue).jobs.is_empty() {
            self.list_open = false;
        }
    }

    fn start(&self, name: String, spec: Spec, loader: Loader) {
        let mut q = lock(&self.queue);
        let id = q.push(name, spec);
        if q.running {
            return;
        }
        q.running = true;
        let shared = self.queue.clone();
        let spawned = std::thread::Builder::new().name("voidmesh-export".into()).spawn(move || worker(&shared, &loader));
        if let Err(e) = spawned {
            // No worker: nothing will run it.
            q.running = false;
            let _ = q.take_next();
            q.finish(id, &Err(Failure::Error(format!("can't start the exporter: {e}"))));
        }
    }
}

/// Queue the entity's export to `path` with the panel's options.
pub fn enqueue(s: &mut App, entity: u32, mut path: PathBuf) {
    let Some(e) = s.entity(entity) else { return s.toast("Nothing to export") };
    if !exportable(&e.asset) {
        return s.toast("Only videos and GIFs export as video");
    }
    let mut options = s.export.options.clone();
    options.fps = options.effective_fps();
    options.include_audio &= e.has_audio();
    if path.extension().is_none_or(|x| !x.eq_ignore_ascii_case(options.format.ext())) {
        path.set_extension(options.format.ext());
    }
    let spec = Spec { asset: e.asset.clone(), params: (*e.params).clone(), fx_t: e.fx_t, options, path: path.clone() };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "export".into());
    s.export.start(name, spec, s.loader.clone());
    s.export.panel = None;
}

/// Queue each of `entities` into folder `dir`, named after them.
pub fn enqueue_into(s: &mut App, entities: &[u32], dir: &std::path::Path) {
    let ext = s.export.options.format.ext();
    let names: Vec<String> = entities.iter().filter_map(|id| s.entity(*id)).map(|e| crate::ui::stem(&e.name)).collect();
    for (id, path) in entities.iter().zip(crate::ui::batch_paths(dir, &names, ext)) {
        enqueue(s, *id, path);
    }
}

/// Keeps the view in step with the queue: closes the panel when its entity is no longer the
/// selection, and redraws while jobs progress. True when something changed.
pub fn poll(s: &mut App, tx: &mut rune::Tx) -> bool {
    let mut changed = false;
    if let Some(p) = &s.export.panel
        && p.entities != crate::ui::export_panel::exportable_selection(s)
    {
        s.export.panel = None;
        changed = true;
    }
    let (version, active) = {
        let q = lock(&s.export.queue);
        (q.version, q.jobs.iter().any(|j| j.info.status.active()))
    };
    if version != s.export.seen {
        s.export.seen = version;
        changed = true;
    }
    if active {
        tx.wake_after(std::time::Duration::from_millis(100));
    }
    changed
}

fn worker(shared: &Mutex<Queue>, loader: &Loader) {
    let mut gpu: Option<Gpu> = None;
    loop {
        let next = {
            let mut q = lock(shared);
            let next = q.take_next();
            if next.is_none() {
                q.running = false;
            }
            next
        };
        let Some((id, spec, cancel)) = next else { return };
        let report = |p: f32, stage: String| lock(shared).progress(id, p, stage);
        let job = Work { spec: &spec, cancel: &cancel, report: &report };
        let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&mut gpu, &job))) {
            Ok(r) => r,
            Err(_) => {
                // The device may be in any state after a panic: start over with a new one.
                gpu = None;
                Err(Failure::Error("the exporter crashed".into()))
            }
        };
        let name = spec.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match &result {
            Ok(()) => loader.notify(format!("Saved {name}")),
            Err(Failure::Error(e)) => loader.notify(format!("Export failed: {e}")),
            Err(Failure::Cancelled) => {}
        }
        lock(shared).finish(id, &result);
    }
}

/// A running job's inputs and its line back to the queue.
struct Work<'a> {
    spec: &'a Spec,
    cancel: &'a AtomicBool,
    report: &'a dyn Fn(f32, String),
}

impl Work<'_> {
    fn check(&self) -> Result<(), Failure> {
        if self.cancel.load(Ordering::Relaxed) { Err(Failure::Cancelled) } else { Ok(()) }
    }
}

fn run(gpu: &mut Option<Gpu>, job: &Work<'_>) -> Result<(), Failure> {
    let spec = job.spec;
    if !exportable(&spec.asset) {
        return Err("only videos and GIFs export as video".into());
    }
    if spec.asset.duration.as_secs_f64() <= 0.0 {
        return Err("the clip has no duration".into());
    }
    let gpu = match gpu {
        Some(g) => g,
        None => gpu.insert(Gpu::new()?),
    };
    let partial = partial_path(&spec.path);
    let _ = std::fs::remove_file(&partial);
    let result = if spec.options.format.is_gif() { gif(gpu, job, &partial) } else { h264(gpu, job, &partial) };
    match result {
        Ok(()) => std::fs::rename(&partial, &spec.path).map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            Failure::Error(format!("can't write {}: {e}", spec.path.display()))
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(e)
        }
    }
}

/// Hidden, beside the destination, with its extension.
fn partial_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "export".into());
    path.with_file_name(format!(".{name}.partial"))
}

// ------------------------------------------------------------------ rendering

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipes: Pipes,
}

impl Gpu {
    fn new() -> Result<Gpu, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::PRIMARY, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() }))
            .map_err(|e| format!("no GPU for export: {e}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("voidmesh export"),
            // The adapter's own limits: media renders up to the GPU's texture size, as on the canvas.
            required_limits: adapter.limits(),
            ..Default::default()
        }))
            .map_err(|e| format!("can't open the GPU for export: {e}"))?;
        let pipes = Pipes::new(&device, &queue);
        Ok(Gpu { device, queue, pipes })
    }
}

/// Renders frames through the effect pipeline and reads them back.
struct Renderer {
    /// The render-size output: one level, export reads only that.
    out: wgpu::Texture,
    scratch: crate::gfx::process::ScratchPool,
    arena: crate::gfx::process::Arena,
    source: Option<(wgpu::Texture, wgpu::TextureView)>,
    readback: wgpu::Buffer,
    row: u32,
}

impl Renderer {
    fn new(gpu: &Gpu, size: (u32, u32)) -> Renderer {
        let row = (size.0 * 4).div_ceil(256) * 256;
        let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("voidmesh export readback"),
            size: u64::from(row) * u64::from(size.1),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        Renderer { out: process::target_mips(&gpu.device, size.0, size.1, 1, "voidmesh export"), scratch: Default::default(), arena: Default::default(), source: None, readback, row }
    }

    /// One frame: straight RGBA source pixels in, premultiplied RGBA at the render size out.
    #[allow(clippy::too_many_arguments)]
    fn render(&mut self, gpu: &Gpu, rgba: &[u8], w: u32, h: u32, media: (u32, u32), params: &Params, time: f32) -> Result<Vec<u8>, String> {
        if rgba.len() != (w as usize) * (h as usize) * 4 {
            return Err("a source frame has the wrong size".into());
        }
        match &self.source {
            Some((t, _)) if (t.width(), t.height()) == (w, h) => process::write(&gpu.queue, t, w, h, rgba),
            _ => {
                let t = process::upload(&gpu.device, &gpu.queue, w, h, rgba);
                let view = t.create_view(&Default::default());
                self.source = Some((t, view));
            }
        }
        let Some((texture, view)) = &self.source else { return Err("no source texture".into()) };
        let (ow, oh) = (self.out.width(), self.out.height());
        let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("voidmesh export") });
        let input = process::Input { texture, view, size: (w, h), levels: 1, media };
        process::run(&gpu.device, &mut enc, &gpu.pipes, &mut self.arena, &mut self.scratch, &input, params, time, &self.out);
        self.arena.flush(&gpu.queue);
        enc.copy_texture_to_buffer(
            self.out.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &self.readback, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(self.row), rows_per_image: Some(oh) } },
            wgpu::Extent3d { width: ow, height: oh, depth_or_array_layers: 1 },
        );
        gpu.queue.submit([enc.finish()]);
        let slice = self.readback.slice(..);
        let (send, recv) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = send.send(r);
        });
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("GPU: {e}"))?;
        recv.recv().map_err(|_| "GPU readback lost".to_string())?.map_err(|e| format!("GPU readback: {e}"))?;
        let out = match slice.get_mapped_range() {
            Ok(data) => {
                let mut out = Vec::with_capacity((ow * oh * 4) as usize);
                for y in 0..oh as usize {
                    let start = y * self.row as usize;
                    out.extend_from_slice(&data[start..start + ow as usize * 4]);
                }
                Ok(out)
            }
            Err(e) => Err(format!("GPU readback: {e:?}")),
        };
        self.readback.unmap();
        out
    }
}

/// Picks, for each output time, the latest source frame shown by then, reading frames in order.
struct Resample<F: FnMut() -> Result<Option<VideoFrame>, String>> {
    pull: F,
    current: Option<VideoFrame>,
    ahead: Option<VideoFrame>,
    done: bool,
    /// Counts frames taken, so callers can tell when the frame changed.
    serial: u64,
}

/// Slack when comparing a frame's time with the output time.
const EPSILON: f64 = 1e-4;

impl<F: FnMut() -> Result<Option<VideoFrame>, String>> Resample<F> {
    fn new(pull: F) -> Self {
        Resample { pull, current: None, ahead: None, done: false, serial: 0 }
    }

    fn fill(&mut self) -> Result<(), String> {
        if self.ahead.is_none() && !self.done {
            self.ahead = (self.pull)()?;
            self.done = self.ahead.is_none();
        }
        Ok(())
    }

    /// The frame showing at `t` (times only move forward), and its serial.
    fn at(&mut self, t: f64) -> Result<(u64, &VideoFrame), String> {
        if self.current.is_none() {
            self.fill()?;
            self.current = self.ahead.take();
            self.serial += 1;
        }
        loop {
            self.fill()?;
            match &self.ahead {
                Some(a) if a.pts <= t + EPSILON => {
                    self.current = self.ahead.take();
                    self.serial += 1;
                }
                _ => break,
            }
        }
        let serial = self.serial;
        self.current.as_ref().map(|f| (serial, f)).ok_or_else(|| "the video has no frames".to_string())
    }
}

/// Renders `n` frames at `fps` from the job's source and hands each to `sink` (premultiplied
/// RGBA at the render size), reporting progress across `span`.
fn render_frames(gpu: &Gpu, job: &Work<'_>, fps: u32, n: u32, span: (f32, f32), mut sink: impl FnMut(u32, Vec<u8>) -> Result<(), Failure>) -> Result<(), Failure> {
    let spec = job.spec;
    let asset = &spec.asset;
    let media = (asset.width, asset.height);
    let mut renderer = Renderer::new(gpu, process::render_size(asset.width, asset.height));
    let mut video = match asset.video_path() {
        Some(path) => {
            let (mut reader, _) = FrameReader::open(path, process::MAX_SIDE)?;
            Some(Resample::new(move || reader.next_frame()))
        }
        None => None,
    };
    let animated = spec.params.animated();
    // The last source frame rendered and its output, reused while neither changes.
    let mut last: Option<(u64, Vec<u8>)> = None;
    for i in 0..n {
        job.check()?;
        let t = f64::from(i) / f64::from(fps);
        let (key, rgba, w, h) = match &mut video {
            Some(r) => {
                let (serial, f) = r.at(t)?;
                (serial, &f.rgba[..], f.width, f.height)
            }
            None => {
                let k = asset.frame_at(t);
                let f = asset.frames.get(k).ok_or("the GIF has no frames")?;
                (k as u64, &f.rgba[..], asset.width, asset.height)
            }
        };
        let time = if animated { spec.fx_t + t } else { spec.fx_t };
        let px = match &last {
            Some((k, px)) if *k == key && !animated => px.clone(),
            _ => renderer.render(gpu, rgba, w, h, media, &spec.params, time as f32)?,
        };
        if !animated {
            last = Some((key, px.clone()));
        }
        sink(i, px)?;
        let done = (i + 1) as f32 / n as f32;
        (job.report)(span.0 + (span.1 - span.0) * done, format!("Rendering {}/{n}", i + 1));
    }
    Ok(())
}

/// Scales premultiplied RGBA from `from` to `to`: a crop when only rounding to even differs.
fn fit_to(rgba: Vec<u8>, from: (u32, u32), to: (u32, u32)) -> Result<Vec<u8>, String> {
    if from == to {
        return Ok(rgba);
    }
    if to.0 <= from.0 && to.1 <= from.1 && from.0 - to.0 <= 1 && from.1 - to.1 <= 1 {
        let mut out = Vec::with_capacity((to.0 * to.1 * 4) as usize);
        for row in rgba.chunks_exact(from.0 as usize * 4).take(to.1 as usize) {
            out.extend_from_slice(&row[..to.0 as usize * 4]);
        }
        return Ok(out);
    }
    let img = image::RgbaImage::from_raw(from.0, from.1, rgba).ok_or("bad frame size")?;
    Ok(image::imageops::resize(&img, to.0, to.1, image::imageops::FilterType::Triangle).into_raw())
}

/// Premultiplied to straight alpha, in place.
fn unpremultiply(rgba: &mut [u8]) {
    for px in rgba.as_chunks_mut::<4>().0 {
        let a = px[3];
        if a == 0 {
            *px = [0; 4];
        } else if a < 255 {
            let k = 255.0 / f32::from(a);
            for c in &mut px[..3] {
                *c = (f32::from(*c) * k).round().min(255.0) as u8;
            }
        }
    }
}

// ------------------------------------------------------------------ H.264

fn h264(gpu: &Gpu, job: &Work<'_>, out: &Path) -> Result<(), Failure> {
    let spec = job.spec;
    let o = &spec.options;
    let fps = o.effective_fps();
    let n = frame_count(spec.asset.duration.as_secs_f64(), fps);
    let render = process::render_size(spec.asset.width, spec.asset.height);
    let size = target_size(render, o.resolution);
    let bits = bitrate(size, o.quality, o.bitrate_kbps);
    let audio = if o.include_audio && spec.asset.video.as_ref().is_some_and(|v| v.has_audio) { spec.asset.video_path() } else { None };
    let end = f64::from(n) / f64::from(fps);
    (job.report)(0.0, "Starting encoder…".into());
    let mut writer = av::Writer::create(out, o.format == Format::Mov, size, fps, bits, audio, end)?;
    render_frames(gpu, job, fps, n, (0.0, 0.97), |i, px| writer.push(i, &fit_to(px, render, size)?, job.cancel))?;
    (job.report)(0.98, if audio.is_some() { "Adding audio…" } else { "Writing file…" }.into());
    writer.finish(end, job.cancel)
}

// ------------------------------------------------------------------ GIF

fn gif(gpu: &Gpu, job: &Work<'_>, out: &Path) -> Result<(), Failure> {
    let spec = job.spec;
    let o = &spec.options;
    let fps = o.effective_fps();
    let n = frame_count(spec.asset.duration.as_secs_f64(), fps);
    let render = process::render_size(spec.asset.width, spec.asset.height);
    let size = gif_size(render, o.gif_max_width.clamp(GIF_WIDTH.0, GIF_WIDTH.1));
    let mut frames = Vec::with_capacity(n as usize);
    render_frames(gpu, job, fps, n, (0.0, 0.7), |_, px| {
        let mut px = fit_to(px, render, size)?;
        unpremultiply(&mut px);
        frames.push(px);
        Ok(())
    })?;
    job.check()?;
    (job.report)(0.72, "Building palette…".into());
    let transparent = frames.iter().any(|f| f.as_chunks::<4>().0.iter().any(|p| p[3] < 128));
    let step = (frames.len() / 20).max(1);
    let samples: Vec<&[u8]> = frames.iter().step_by(step).map(Vec::as_slice).collect();
    let palette = quantize(&samples, if transparent { GIF_COLORS - 1 } else { GIF_COLORS });
    let clear = transparent.then_some(palette.len() as u8);
    let mut flat: Vec<u8> = palette.iter().flatten().copied().collect();
    flat.resize(GIF_COLORS * 3, 0);

    let file = std::fs::File::create(out).map_err(|e| format!("can't create {}: {e}", out.display()))?;
    let (w, h) = (size.0.min(u32::from(u16::MAX)) as u16, size.1.min(u32::from(u16::MAX)) as u16);
    let mut enc = gif::Encoder::new(std::io::BufWriter::new(file), w, h, &flat).map_err(|e| e.to_string())?;
    enc.set_repeat(gif::Repeat::Infinite).map_err(|e| e.to_string())?;
    let mut nearest = Nearest::new(&palette);
    let delays = gif_delays(n, fps);
    let total = frames.len();
    for (i, px) in frames.iter().enumerate() {
        job.check()?;
        let indices = map_frame(px, size.0 as usize, size.1 as usize, &mut nearest, clear, o.dither == Dither::FloydSteinberg);
        let frame = gif::Frame {
            width: w,
            height: h,
            buffer: Cow::Owned(indices),
            delay: delays.get(i).copied().unwrap_or(3),
            transparent: clear,
            // Frames cover the whole canvas; clearing first keeps transparent pixels from
            // showing the previous frame.
            dispose: if clear.is_some() { gif::DisposalMethod::Background } else { gif::DisposalMethod::Keep },
            ..Default::default()
        };
        enc.write_frame(&frame).map_err(|e| e.to_string())?;
        (job.report)(0.72 + 0.28 * (i + 1) as f32 / total as f32, format!("Encoding {}/{total}", i + 1));
    }
    let mut file = enc.into_inner().map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Median cut over a 5-bit-per-channel histogram of the opaque pixels: at most `max` colours.
pub fn quantize(frames: &[&[u8]], max: usize) -> Vec<[u8; 3]> {
    struct Bin {
        q: [u8; 3],
        count: u64,
        sum: [u64; 3],
    }
    let mut hist: Vec<(u64, [u64; 3])> = vec![(0, [0; 3]); 1 << 15];
    for f in frames {
        for p in f.as_chunks::<4>().0 {
            if p[3] < 128 {
                continue;
            }
            let k = (usize::from(p[0] >> 3) << 10) | (usize::from(p[1] >> 3) << 5) | usize::from(p[2] >> 3);
            let b = &mut hist[k];
            b.0 += 1;
            for (sum, &v) in b.1.iter_mut().zip(p) {
                *sum += u64::from(v);
            }
        }
    }
    let mut bins: Vec<Bin> = hist
        .iter()
        .enumerate()
        .filter(|(_, b)| b.0 > 0)
        .map(|(k, b)| Bin { q: [(k >> 10) as u8, ((k >> 5) & 31) as u8, (k & 31) as u8], count: b.0, sum: b.1 })
        .collect();
    if bins.is_empty() {
        return vec![[0, 0, 0]];
    }
    let range = |bins: &[Bin], c: usize| {
        let (lo, hi) = bins.iter().fold((u8::MAX, 0u8), |(lo, hi), b| (lo.min(b.q[c]), hi.max(b.q[c])));
        hi.saturating_sub(lo)
    };
    let mut boxes: Vec<std::ops::Range<usize>> = std::iter::once(0..bins.len()).collect();
    while boxes.len() < max.max(1) {
        // Split the box with the most pixels times spread.
        let pick = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.len() > 1)
            .map(|(i, b)| {
                let s = &bins[b.clone()];
                let spread = (0..3).map(|c| range(s, c)).max().unwrap_or(0);
                (i, u64::from(spread) * s.iter().map(|b| b.count).sum::<u64>())
            })
            .max_by_key(|(_, score)| *score);
        let Some((i, _)) = pick else { break };
        let b = boxes.swap_remove(i);
        let slice = &mut bins[b.clone()];
        let c = (0..3).max_by_key(|&c| range(slice, c)).unwrap_or(0);
        slice.sort_unstable_by_key(|b| b.q[c]);
        let total: u64 = slice.iter().map(|b| b.count).sum();
        let mut acc = 0;
        let mut split = 1;
        for (j, bin) in slice.iter().enumerate() {
            acc += bin.count;
            if acc * 2 >= total {
                split = (j + 1).clamp(1, slice.len() - 1);
                break;
            }
        }
        boxes.push(b.start..b.start + split);
        boxes.push(b.start + split..b.end);
    }
    boxes
        .iter()
        .map(|b| {
            let s = &bins[b.clone()];
            let n = s.iter().map(|b| b.count).sum::<u64>().max(1);
            let avg = |c: usize| ((s.iter().map(|b| b.sum[c]).sum::<u64>() + n / 2) / n).min(255) as u8;
            [avg(0), avg(1), avg(2)]
        })
        .collect()
}

/// Nearest palette colour, cached per 6-bit-per-channel cell.
pub struct Nearest<'a> {
    palette: &'a [[u8; 3]],
    cache: Vec<u8>,
}

impl<'a> Nearest<'a> {
    pub fn new(palette: &'a [[u8; 3]]) -> Self {
        Nearest { palette, cache: vec![u8::MAX; 1 << 18] }
    }

    pub fn get(&mut self, c: [u8; 3]) -> u8 {
        let k = (usize::from(c[0] >> 2) << 12) | (usize::from(c[1] >> 2) << 6) | usize::from(c[2] >> 2);
        if self.cache[k] == u8::MAX {
            let center = [(c[0] & !3) | 2, (c[1] & !3) | 2, (c[2] & !3) | 2];
            let d = |p: &[u8; 3]| (0..3).map(|i| (i32::from(p[i]) - i32::from(center[i])).pow(2)).sum::<i32>();
            self.cache[k] = self.palette.iter().enumerate().min_by_key(|(_, p)| d(p)).map_or(0, |(i, _)| i as u8);
        }
        self.cache[k]
    }
}

/// Palette indices for straight-alpha RGBA: pixels under half alpha take `transparent` (when
/// given); the rest the nearest colour, Floyd–Steinberg dithered when `dither`.
pub fn map_frame(rgba: &[u8], w: usize, h: usize, near: &mut Nearest<'_>, transparent: Option<u8>, dither: bool) -> Vec<u8> {
    let mut out = vec![0u8; w * h];
    let mut cur = vec![[0f32; 3]; w + 2];
    let mut next = vec![[0f32; 3]; w + 2];
    for y in 0..h {
        for x in 0..w {
            let p = &rgba[(y * w + x) * 4..][..4];
            if let Some(t) = transparent
                && p[3] < 128
            {
                out[y * w + x] = t;
                continue;
            }
            let e = if dither { cur[x + 1] } else { [0.0; 3] };
            let c = [0, 1, 2].map(|i| (f32::from(p[i]) + e[i]).clamp(0.0, 255.0));
            let idx = near.get(c.map(|v| v.round() as u8));
            out[y * w + x] = idx;
            if dither {
                let q = near.palette.get(usize::from(idx)).copied().unwrap_or([0; 3]);
                let err = [0, 1, 2].map(|i| c[i] - f32::from(q[i]));
                for i in 0..3 {
                    cur[x + 2][i] += err[i] * 7.0 / 16.0;
                    next[x][i] += err[i] * 3.0 / 16.0;
                    next[x + 1][i] += err[i] * 5.0 / 16.0;
                    next[x + 2][i] += err[i] / 16.0;
                }
            }
        }
        std::mem::swap(&mut cur, &mut next);
        next.iter_mut().for_each(|e| *e = [0.0; 3]);
    }
    out
}

// ------------------------------------------------------------------ AVFoundation

#[cfg(not(target_os = "macos"))]
mod av {
    use super::Failure;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;

    pub struct Writer;

    impl Writer {
        pub fn create(_: &Path, _: bool, _: (u32, u32), _: u32, _: u32, _: Option<&Path>, _: f64) -> Result<Writer, String> {
            Err("video export needs macOS".into())
        }

        pub fn push(&mut self, _: u32, _: &[u8], _: &AtomicBool) -> Result<(), Failure> {
            Err("video export needs macOS".into())
        }

        pub fn finish(self, _: f64, _: &AtomicBool) -> Result<(), Failure> {
            Err("video export needs macOS".into())
        }
    }
}

#[cfg(target_os = "macos")]
mod av {
    use std::path::Path;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    use objc2::AnyThread;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::AnyObject;
    use objc2_av_foundation::{
        AVAssetReader, AVAssetReaderTrackOutput, AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus, AVFileTypeMPEG4,
        AVFileTypeQuickTimeMovie, AVMediaTypeAudio, AVMediaTypeVideo, AVURLAsset, AVVideoAverageBitRateKey, AVVideoCodecKey, AVVideoCodecTypeH264,
        AVVideoCompressionPropertiesKey, AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey, AVVideoMaxKeyFrameIntervalDurationKey, AVVideoMaxKeyFrameIntervalKey,
        AVVideoProfileLevelH264HighAutoLevel, AVVideoProfileLevelKey, AVVideoWidthKey,
    };
    use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString, CFType};
    use objc2_core_media::{CMFormatDescription, CMSampleBuffer, CMTime, CMTimeRange};
    use objc2_core_video::{
        CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
        CVPixelBufferLockFlags, CVPixelBufferPool, CVPixelBufferUnlockBaseAddress, kCVPixelBufferHeightKey, kCVPixelBufferPixelFormatTypeKey,
        kCVPixelBufferWidthKey, kCVPixelFormatType_32BGRA, kCVReturnSuccess,
    };
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

    use super::{Failure, KEYFRAME_SECONDS};

    /// How long the writer may refuse input before the export gives up.
    const STALL: Duration = Duration::from_secs(60);

    fn seconds(t: CMTime) -> f64 {
        // SAFETY: CMTimeGetSeconds reads a plain struct.
        let s = unsafe { t.seconds() };
        if s.is_finite() { s } else { 0.0 }
    }

    fn cm(seconds: f64) -> CMTime {
        // SAFETY: CMTimeMakeWithSeconds builds a plain struct.
        unsafe { CMTime::with_seconds(seconds, 600_000) }
    }

    fn constant<T: ?Sized>(c: Option<&'static T>) -> Result<&'static T, String> {
        c.ok_or_else(|| "an AVFoundation constant is unavailable".to_string())
    }

    fn dict(pairs: &[(&NSString, &AnyObject)]) -> Retained<NSDictionary<NSString, AnyObject>> {
        let keys: Vec<&NSString> = pairs.iter().map(|p| p.0).collect();
        let values: Vec<&AnyObject> = pairs.iter().map(|p| p.1).collect();
        NSDictionary::from_slices(&keys, &values)
    }

    fn writer_error(w: &AVAssetWriter) -> String {
        // SAFETY: a plain property read.
        unsafe { w.error() }.map_or_else(|| "the video encoder failed".into(), |e| e.localizedDescription().to_string())
    }

    /// The source's audio, copied through untouched up to `end`.
    struct Audio {
        input: Retained<AVAssetWriterInput>,
        output: Retained<AVAssetReaderTrackOutput>,
        reader: Retained<AVAssetReader>,
        _asset: Retained<AVURLAsset>,
        /// A sample read but not yet accepted.
        pending: Option<Retained<CMSampleBuffer>>,
        end: f64,
        done: bool,
    }

    impl Drop for Audio {
        fn drop(&mut self) {
            // SAFETY: cancelling an idle, reading or finished reader is allowed.
            unsafe { self.reader.cancelReading() };
        }
    }

    impl Audio {
        #[allow(deprecated)] // The synchronous track accessor suits a worker and local files.
        fn open(writer: &AVAssetWriter, path: &Path, end: f64) -> Result<Audio, String> {
            let path = std::path::absolute(path).map_err(|e| format!("can't resolve {}: {e}", path.display()))?;
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            // SAFETY: a file URL and no options.
            let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };
            // SAFETY: AVFoundation's media type constant.
            let audio = constant(unsafe { AVMediaTypeAudio })?;
            // SAFETY: the asset is alive; the accessor blocks until its tracks load.
            let track = unsafe { asset.tracksWithMediaType(audio) }.firstObject().ok_or("the source has no audio track")?;
            // SAFETY: as above.
            let reader = unsafe { AVAssetReader::assetReaderWithAsset_error(&asset) }.map_err(|e| e.localizedDescription().to_string())?;
            // SAFETY: the track belongs to the reader's asset; no settings means samples as stored.
            let output = unsafe { AVAssetReaderTrackOutput::assetReaderTrackOutputWithTrack_outputSettings(&track, None) };
            // SAFETY: plain property access on a reader that hasn't started.
            unsafe {
                output.setAlwaysCopiesSampleData(false);
                if !reader.canAddOutput(&output) {
                    return Err("can't read the source's audio".into());
                }
                reader.addOutput(&output);
                reader.setTimeRange(CMTimeRange { start: cm(0.0), duration: cm(end) });
            }
            // The stored format, so the writer can pass samples through without re-encoding.
            // SAFETY: a plain property read of a loaded track.
            let formats = unsafe { track.formatDescriptions() };
            let hint = formats.firstObject();
            // SAFETY: the array holds CMFormatDescriptions (CF objects bridged as ids); `hint`
            // keeps the object alive while the reference is used.
            let hint_ref = hint.as_ref().map(|h| unsafe { &*(Retained::as_ptr(h) as *const CMFormatDescription) });
            // SAFETY: audio media type, passthrough (no settings) and the source's format.
            let input = unsafe { AVAssetWriterInput::initWithMediaType_outputSettings_sourceFormatHint(AVAssetWriterInput::alloc(), audio, None, hint_ref) };
            // SAFETY: configuring an input before writing starts.
            unsafe {
                input.setExpectsMediaDataInRealTime(false);
                if !writer.canAddInput(&input) {
                    return Err("can't add the source's audio to this file type".into());
                }
                writer.addInput(&input);
                if !reader.startReading() {
                    return Err(reader.error().map_or_else(|| "can't read the source's audio".into(), |e| e.localizedDescription().to_string()));
                }
            }
            Ok(Audio { input, output, reader, _asset: asset, pending: None, end, done: false })
        }

        /// Append samples starting before `until` while the input takes them.
        fn pump(&mut self, until: f64, writer: &AVAssetWriter) -> Result<(), String> {
            while !self.done {
                if self.pending.is_none() {
                    // SAFETY: the reader is reading; the output belongs to it.
                    match unsafe { self.output.copyNextSampleBuffer() } {
                        Some(s) => self.pending = Some(s),
                        None => {
                            self.finish();
                            break;
                        }
                    }
                }
                let Some(sample) = &self.pending else { break };
                // SAFETY: a valid sample buffer.
                let pts = seconds(unsafe { sample.presentation_time_stamp() });
                if pts >= self.end {
                    self.finish();
                    break;
                }
                // SAFETY: plain property read.
                if pts > until || !unsafe { self.input.isReadyForMoreMediaData() } {
                    break;
                }
                // SAFETY: the input is ready, writing has started, the sample is in its format.
                if !unsafe { self.input.appendSampleBuffer(sample) } {
                    return Err(writer_error(writer));
                }
                self.pending = None;
            }
            Ok(())
        }

        fn finish(&mut self) {
            self.done = true;
            self.pending = None;
            // SAFETY: marking an input finished once, from the thread that appends to it.
            unsafe { self.input.markAsFinished() };
        }
    }

    /// An H.264 file being written: frames in, audio interleaved as they go.
    pub struct Writer {
        writer: Retained<AVAssetWriter>,
        video: Retained<AVAssetWriterInput>,
        adaptor: Retained<AVAssetWriterInputPixelBufferAdaptor>,
        audio: Option<Audio>,
        fps: i32,
        size: (u32, u32),
        finished: bool,
    }

    impl Drop for Writer {
        fn drop(&mut self) {
            if !self.finished {
                // SAFETY: cancelling a writer that hasn't finished is allowed in any state.
                unsafe { self.writer.cancelWriting() };
            }
        }
    }

    impl Writer {
        pub fn create(path: &Path, mov: bool, size: (u32, u32), fps: u32, bitrate: u32, audio: Option<&Path>, end: f64) -> Result<Writer, String> {
            autoreleasepool(|_| {
                let path = std::path::absolute(path).map_err(|e| format!("can't resolve {}: {e}", path.display()))?;
                let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
                // SAFETY: AVFoundation's file type constants.
                let file_type = constant(unsafe { if mov { AVFileTypeQuickTimeMovie } else { AVFileTypeMPEG4 } })?;
                // SAFETY: a file URL and a declared file type; nothing exists at the path.
                let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, file_type) }.map_err(|e| e.localizedDescription().to_string())?;
                // SAFETY: configuring a writer before it starts.
                unsafe { writer.setShouldOptimizeForNetworkUse(true) };

                let fps = fps.clamp(1, 240) as i32;
                // SAFETY: AVFoundation's settings keys and values, immutable constants.
                let (codec_key, codec, width_key, height_key, props_key, rate_key, interval_key, interval_dur_key, level_key, level, expected_key) = unsafe {
                    (
                        constant(AVVideoCodecKey)?,
                        constant(AVVideoCodecTypeH264)?,
                        constant(AVVideoWidthKey)?,
                        constant(AVVideoHeightKey)?,
                        constant(AVVideoCompressionPropertiesKey)?,
                        constant(AVVideoAverageBitRateKey)?,
                        constant(AVVideoMaxKeyFrameIntervalKey)?,
                        constant(AVVideoMaxKeyFrameIntervalDurationKey)?,
                        constant(AVVideoProfileLevelKey)?,
                        constant(AVVideoProfileLevelH264HighAutoLevel)?,
                        constant(AVVideoExpectedSourceFrameRateKey)?,
                    )
                };
                let bitrate = NSNumber::new_u32(bitrate);
                let interval = NSNumber::new_i32(fps * KEYFRAME_SECONDS as i32);
                let interval_dur = NSNumber::new_f64(f64::from(KEYFRAME_SECONDS));
                let expected = NSNumber::new_i32(fps);
                let props = dict(&[(rate_key, &bitrate), (interval_key, &interval), (interval_dur_key, &interval_dur), (level_key, level), (expected_key, &expected)]);
                let (w, h) = (NSNumber::new_u32(size.0), NSNumber::new_u32(size.1));
                let settings = dict(&[(codec_key, codec), (width_key, &w), (height_key, &h), (props_key, &props)]);
                // SAFETY: AVFoundation's media type constant.
                let video_type = constant(unsafe { AVMediaTypeVideo })?;
                // SAFETY: video settings with the required codec, width and height keys.
                let video = unsafe { AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(video_type, Some(&settings)) };
                // SAFETY: configuring an input before writing starts.
                unsafe {
                    video.setExpectsMediaDataInRealTime(false);
                    if !writer.canAddInput(&video) {
                        return Err("the encoder can't take these settings".into());
                    }
                    writer.addInput(&video);
                }
                let format = CFNumber::new_i32(kCVPixelFormatType_32BGRA as i32);
                let (cw, ch) = (CFNumber::new_i32(size.0 as i32), CFNumber::new_i32(size.1 as i32));
                // SAFETY: CoreVideo's key constants are immutable CFStrings.
                let keys: [&CFString; 3] = unsafe { [kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, kCVPixelBufferHeightKey] };
                let values: [&CFType; 3] = [format.as_ref(), cw.as_ref(), ch.as_ref()];
                let attrs: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(&keys, &values);
                // SAFETY: CFDictionary and NSDictionary are toll-free bridged; `attrs` outlives the borrow.
                let attrs = unsafe { &*(CFRetained::as_ptr(&attrs).as_ptr() as *const NSDictionary<NSString, AnyObject>) };
                // SAFETY: the input is attached to the writer, which hasn't started.
                let adaptor = unsafe { AVAssetWriterInputPixelBufferAdaptor::assetWriterInputPixelBufferAdaptorWithAssetWriterInput_sourcePixelBufferAttributes(&video, Some(attrs)) };
                let audio = match audio {
                    Some(p) => Some(Audio::open(&writer, p, end)?),
                    None => None,
                };
                // SAFETY: inputs are added; the session starts at 0.
                unsafe {
                    if !writer.startWriting() {
                        return Err(writer_error(&writer));
                    }
                    writer.startSessionAtSourceTime(cm(0.0));
                }
                Ok(Writer { writer, video, adaptor, audio, fps, size, finished: false })
            })
        }

        fn check(&self, cancel: &AtomicBool) -> Result<(), Failure> {
            if cancel.load(Ordering::Relaxed) {
                return Err(Failure::Cancelled);
            }
            // SAFETY: a plain property read.
            if unsafe { self.writer.status() } == AVAssetWriterStatus::Failed {
                return Err(Failure::Error(writer_error(&self.writer)));
            }
            Ok(())
        }

        fn pump(&mut self, until: f64) -> Result<(), String> {
            match &mut self.audio {
                Some(a) => a.pump(until, &self.writer),
                None => Ok(()),
            }
        }

        /// Append frame `index` (premultiplied RGBA at the output size; shown over black).
        pub fn push(&mut self, index: u32, rgba: &[u8], cancel: &AtomicBool) -> Result<(), Failure> {
            autoreleasepool(|_| {
                let t = f64::from(index) / f64::from(self.fps);
                // Keep audio a little ahead: the writer interleaves, and holds back an input
                // that runs too far ahead of the other.
                self.pump(t + 1.0)?;
                let started = Instant::now();
                // SAFETY: a plain property read.
                while !unsafe { self.video.isReadyForMoreMediaData() } {
                    self.check(cancel)?;
                    self.pump(f64::INFINITY)?;
                    if started.elapsed() > STALL {
                        return Err("the video encoder stalled".into());
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                self.check(cancel)?;
                // SAFETY: writing has started, so the adaptor has its pool.
                let pool = unsafe { self.adaptor.pixelBufferPool() }.ok_or("the encoder has no frame buffers")?;
                let mut raw: *mut CVPixelBuffer = std::ptr::null_mut();
                // SAFETY: a valid pool and an out pointer to fill.
                let r = unsafe { CVPixelBufferPool::create_pixel_buffer(None, &pool, NonNull::from(&mut raw)) };
                let Some(raw) = NonNull::new(raw).filter(|_| r == kCVReturnSuccess) else { return Err("can't allocate a frame buffer".into()) };
                // SAFETY: a +1 pixel buffer from a Create function.
                let buffer = unsafe { CFRetained::from_raw(raw) };
                fill(&buffer, rgba, self.size)?;
                // SAFETY: the input is ready; the time is numeric and increasing.
                let ok = unsafe { self.adaptor.appendPixelBuffer_withPresentationTime(&buffer, CMTime::new(i64::from(index), self.fps)) };
                if !ok {
                    return Err(Failure::Error(writer_error(&self.writer)));
                }
                Ok(())
            })
        }

        /// Finish the video, the rest of the audio, and the file, ending at `end` seconds.
        pub fn finish(mut self, end: f64, cancel: &AtomicBool) -> Result<(), Failure> {
            autoreleasepool(|_| {
                // SAFETY: no more frames follow.
                unsafe { self.video.markAsFinished() };
                let started = Instant::now();
                while self.audio.as_ref().is_some_and(|a| !a.done) {
                    self.check(cancel)?;
                    self.pump(f64::INFINITY)?;
                    if started.elapsed() > STALL {
                        return Err(Failure::Error("the audio stalled".into()));
                    }
                    if self.audio.as_ref().is_some_and(|a| !a.done) {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
                // SAFETY: every input is finished; trims anything (audio) past the end.
                unsafe { self.writer.endSessionAtSourceTime(cm(end)) };
                // SAFETY: called on a worker thread, after the last append returned.
                #[allow(deprecated)] // The blocking finish suits the worker.
                let ok = unsafe { self.writer.finishWriting() };
                // SAFETY: a plain property read.
                if !ok || unsafe { self.writer.status() } != AVAssetWriterStatus::Completed {
                    return Err(Failure::Error(writer_error(&self.writer)));
                }
                self.finished = true;
                Ok(())
            })
        }
    }

    /// Copies premultiplied RGBA into a BGRA pixel buffer, opaque (over black).
    fn fill(buffer: &CVPixelBuffer, rgba: &[u8], size: (u32, u32)) -> Result<(), String> {
        // SAFETY: a valid pixel buffer, unlocked below with the same flags.
        if unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags(0)) } != kCVReturnSuccess {
            return Err("can't write a frame buffer".into());
        }
        let (w, h) = (CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer));
        let stride = CVPixelBufferGetBytesPerRow(buffer);
        let base = CVPixelBufferGetBaseAddress(buffer) as *mut u8;
        let result = if base.is_null() || (w, h) != (size.0 as usize, size.1 as usize) || stride < w * 4 || rgba.len() != w * h * 4 {
            Err("a frame buffer has the wrong size".to_string())
        } else {
            // SAFETY: locked for writing, a non-planar buffer spans `stride * h` bytes from `base`.
            let dst = unsafe { std::slice::from_raw_parts_mut(base, stride * h) };
            for (src, row) in rgba.chunks_exact(w * 4).zip(dst.chunks_exact_mut(stride)) {
                for (s, d) in src.as_chunks::<4>().0.iter().zip(row[..w * 4].as_chunks_mut::<4>().0) {
                    *d = [s[2], s[1], s[0], 255];
                }
            }
            Ok(())
        };
        // SAFETY: locked above with these flags.
        unsafe { CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags(0)) };
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_size_keeps_aspect_never_upscales_and_is_even() {
        assert_eq!(target_size((1920, 1080), Resolution::Original), (1920, 1080));
        assert_eq!(target_size((1921, 1081), Resolution::Original), (1920, 1080));
        assert_eq!(target_size((3840, 2160), Resolution::P1080), (1920, 1080));
        assert_eq!(target_size((3840, 2160), Resolution::P720), (1280, 720));
        assert_eq!(target_size((3840, 2160), Resolution::P480), (852, 480));
        // Never upscaled.
        assert_eq!(target_size((640, 360), Resolution::P1080), (640, 360));
        // Portrait fits the box's height.
        assert_eq!(target_size((1080, 1920), Resolution::P720), (404, 720));
        assert_eq!(target_size((1, 1), Resolution::Original), (2, 2));
    }

    #[test]
    fn bitrate_scales_with_pixels_and_quality() {
        assert_eq!(bitrate((1920, 1080), Quality::Medium, None), 25_000_000);
        assert_eq!(bitrate((1920, 1080), Quality::High, None), 37_500_000);
        assert_eq!(bitrate((1920, 1080), Quality::Low, None), 15_000_000);
        assert_eq!(bitrate((960, 540), Quality::Medium, None), 6_250_000);
        assert_eq!(bitrate((960, 540), Quality::High, Some(8_000)), 8_000_000);
    }

    #[test]
    fn gif_size_caps_width_and_is_even() {
        assert_eq!(gif_size((1920, 1080), 256), (256, 144));
        assert_eq!(gif_size((200, 101), 256), (200, 100));
        assert_eq!(gif_size((1000, 333), 250), (250, 82));
    }

    #[test]
    fn frames_and_delays_keep_time() {
        assert_eq!(frame_count(2.0, 30), 60);
        assert_eq!(frame_count(2.01, 30), 61);
        assert_eq!(frame_count(0.0, 30), 1);
        let d = gif_delays(30, 30);
        assert_eq!(d.iter().map(|&v| u32::from(v)).sum::<u32>(), 100);
        assert!(d.iter().all(|&v| v == 3 || v == 4));
        let mut o = Options { format: Format::Gif, fps: 60, ..Options::default() };
        assert_eq!(o.effective_fps(), 30);
        o.format = Format::Mp4;
        assert_eq!(o.effective_fps(), 60);
        o.fps = 0;
        assert_eq!(o.effective_fps(), 1);
    }

    fn solid(colors: &[[u8; 4]], each: usize) -> Vec<u8> {
        colors.iter().flat_map(|c| std::iter::repeat_n(*c, each)).flatten().collect()
    }

    #[test]
    fn quantize_finds_the_distinct_colours() {
        let px = solid(&[[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [10, 10, 10, 0]], 50);
        let mut p = quantize(&[&px], 8);
        p.sort();
        // Transparent pixels don't count; each colour comes back exactly.
        assert_eq!(p, vec![[0, 0, 255], [0, 255, 0], [255, 0, 0]]);
        let one = quantize(&[&px], 1);
        assert_eq!(one.len(), 1);
        assert!(quantize(&[&[0, 0, 0, 0][..]], 8) == vec![[0, 0, 0]]);
        // Never more than asked for.
        let ramp: Vec<u8> = (0..=255u8).flat_map(|v| [v, 255 - v, v / 2, 255]).collect();
        assert!(quantize(&[&ramp], 16).len() <= 16);
    }

    #[test]
    fn dithering_mixes_to_the_mean() {
        // Mid grey on a black/white palette: dithered, about half the pixels are white;
        // undithered, all map to one colour.
        let (w, h) = (32, 32);
        let px: Vec<u8> = std::iter::repeat_n([128u8, 128, 128, 255], w * h).flatten().collect();
        let pal = [[0, 0, 0], [255, 255, 255]];
        let mut near = Nearest::new(&pal);
        let d = map_frame(&px, w, h, &mut near, None, true);
        let white = d.iter().filter(|&&i| i == 1).count() as f32 / (w * h) as f32;
        assert!((white - 0.5).abs() < 0.05, "white share {white}");
        let flat = map_frame(&px, w, h, &mut near, None, false);
        assert!(flat.iter().all(|&i| i == flat[0]));
        // Transparent pixels take the transparent index.
        let t = map_frame(&[0, 0, 0, 0, 255, 255, 255, 255], 2, 1, &mut near, Some(2), true);
        assert_eq!(t, vec![2, 1]);
    }

    #[test]
    fn unpremultiply_restores_colour() {
        let mut px = [64, 0, 0, 128, 0, 0, 0, 0, 10, 20, 30, 255];
        unpremultiply(&mut px);
        assert_eq!(px, [128, 0, 0, 128, 0, 0, 0, 0, 10, 20, 30, 255]);
    }

    #[test]
    fn fit_to_crops_odd_edges_and_scales_otherwise() {
        let px: Vec<u8> = (0..3 * 3).flat_map(|i| [i as u8, 0, 0, 255]).collect();
        let c = fit_to(px.clone(), (3, 3), (2, 2)).unwrap_or_default();
        assert_eq!(c.as_chunks::<4>().0.iter().map(|p| p[0]).collect::<Vec<_>>(), vec![0, 1, 3, 4]);
        let s = fit_to(vec![255; 8 * 8 * 4], (8, 8), (4, 4)).unwrap_or_default();
        assert_eq!(s.len(), 4 * 4 * 4);
    }

    fn frame(pts: f64) -> VideoFrame {
        VideoFrame { pts, width: 1, height: 1, rgba: vec![(pts * 10.0) as u8, 0, 0, 255] }
    }

    #[test]
    fn resample_picks_the_frame_on_screen() {
        // A 10 fps source sampled at 25 fps, and one that starts late.
        let mut src = (0..10).map(|i| frame(f64::from(i) / 10.0));
        let mut r = Resample::new(move || Ok(src.next()));
        let picks: Vec<f64> = (0..25).map(|i| r.at(f64::from(i) / 25.0).map(|(_, f)| f.pts).unwrap_or(-1.0)).collect();
        assert_eq!(picks[0], 0.0);
        assert_eq!(picks[2], 0.0); // 0.08 s
        assert_eq!(picks[3], 0.1); // 0.12 s
        assert_eq!(picks[24], 0.9); // past the end: the last frame holds
        let mut late = vec![frame(0.05), frame(0.15)].into_iter();
        let mut r = Resample::new(move || Ok(late.next()));
        let (s0, f0) = r.at(0.0).map(|(s, f)| (s, f.pts)).unwrap_or_default();
        assert_eq!(f0, 0.05);
        let (s1, _) = r.at(0.01).map(|(s, f)| (s, f.pts)).unwrap_or_default();
        assert_eq!(s0, s1, "same frame, same serial");
        let mut none = std::iter::empty();
        assert!(Resample::new(move || Ok(none.next())).at(0.0).is_err());
    }

    fn spec() -> Spec {
        Spec { asset: Arc::new(crate::media::test_asset(1, 4, 4)), params: Params::default(), fx_t: 0.0, options: Options::default(), path: PathBuf::from("/tmp/x.mp4") }
    }

    #[test]
    fn queue_runs_in_order_and_cancels() {
        let mut q = Queue::default();
        let a = q.push("a".into(), spec());
        let b = q.push("b".into(), spec());
        let c = q.push("c".into(), spec());
        let (first, _, flag) = q.take_next().unwrap_or_else(|| panic!("nothing queued"));
        assert_eq!(first, a);
        // Cancelling the running job flags it; it ends cancelled when the worker returns.
        q.cancel(a);
        assert!(flag.load(Ordering::Relaxed));
        q.finish(a, &Err(Failure::Cancelled));
        // A queued job cancels at once and is skipped.
        q.cancel(b);
        let (next, ..) = q.take_next().unwrap_or_else(|| panic!("c should be next"));
        assert_eq!(next, c);
        q.progress(c, 0.5, "Rendering 1/2".into());
        q.finish(c, &Ok(()));
        assert!(q.take_next().is_none());
        fn status(q: &Queue, id: u64) -> Option<Status> {
            q.jobs.iter().find(|j| j.info.id == id).map(|j| j.info.status.clone())
        }
        assert_eq!(status(&q, a), Some(Status::Cancelled));
        assert_eq!(status(&q, b), Some(Status::Cancelled));
        assert_eq!(status(&q, c), Some(Status::Completed));
        // Finished jobs clear; a failure keeps its message until then.
        let d = q.push("d".into(), spec());
        let _ = q.take_next();
        q.finish(d, &Err(Failure::Error("boom".into())));
        assert_eq!(status(&q, d), Some(Status::Failed("boom".into())));
        q.clear();
        assert!(q.jobs.is_empty());
    }

    #[cfg(target_os = "macos")]
    mod pipeline {
        use super::*;
        use std::process::Command;

        const FFMPEG: &str = "/opt/homebrew/bin/ffmpeg";
        const FFPROBE: &str = "/opt/homebrew/bin/ffprobe";

        struct Scratch(PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        fn tools() -> bool {
            let ok = Path::new(FFMPEG).exists() && Path::new(FFPROBE).exists();
            if !ok {
                eprintln!("skipping: {FFMPEG} or {FFPROBE} not found");
            }
            ok
        }

        fn ffmpeg(out: &Path, args: &[&str]) {
            let status = Command::new(FFMPEG).args(["-y", "-loglevel", "error"]).args(args).arg(out).status();
            assert!(status.is_ok_and(|s| s.success()), "ffmpeg failed making {}", out.display());
        }

        fn probe(path: &Path) -> serde_json::Value {
            let out = Command::new(FFPROBE)
                .args(["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration", "-of", "json"])
                .arg(path)
                .output()
                .unwrap_or_else(|e| panic!("ffprobe: {e}"));
            serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("ffprobe json: {e}"))
        }

        fn stream<'a>(p: &'a serde_json::Value, kind: &str) -> Option<&'a serde_json::Value> {
            p["streams"].as_array()?.iter().find(|s| s["codec_type"] == kind)
        }

        /// The first frame as RGBA, decoded by ffmpeg.
        fn first_frame(path: &Path) -> Vec<u8> {
            let out = Command::new(FFMPEG).args(["-loglevel", "error", "-i"]).arg(path).args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).output();
            out.map(|o| o.stdout).unwrap_or_default()
        }

        /// Mean absolute difference per colour channel.
        fn difference(a: &[u8], b: &[u8]) -> f64 {
            assert_eq!(a.len(), b.len());
            assert!(!a.is_empty());
            let sum: u64 = a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).flat_map(|(p, q)| (0..3).map(move |i| u64::from(p[i].abs_diff(q[i])))).sum();
            sum as f64 / (a.len() / 4 * 3) as f64
        }

        fn export(asset: Arc<Asset>, params: Params, options: Options, path: PathBuf) -> Result<(), String> {
            let spec = Spec { asset, params, fx_t: 0.0, options, path };
            let cancel = AtomicBool::new(false);
            let report = |_: f32, _: String| {};
            let work = Work { spec: &spec, cancel: &cancel, report: &report };
            let mut gpu = None;
            run(&mut gpu, &work).map_err(|e| match e {
                Failure::Cancelled => "cancelled".to_string(),
                Failure::Error(e) => e,
            })
        }

        #[test]
        fn export_video_to_mp4_mov_and_gif() {
            if !tools() {
                return;
            }
            let dir = Scratch(std::env::temp_dir().join(format!("voidmesh-export-{}", std::process::id())));
            let _ = std::fs::create_dir_all(&dir.0);
            // 2 s, 160×90 at 30 fps with a sine track.
            let src = dir.0.join("src.mp4");
            ffmpeg(
                &src,
                &[
                    "-f", "lavfi", "-i", "testsrc=size=160x90:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                ],
            );
            let asset = Arc::new(crate::media::decode_file(1, &src).unwrap_or_else(|e| panic!("decode: {e}")));
            // Flowing glass on autoplay: its time follows the frames.
            let mut glass = Params::default();
            glass.set_shader(crate::effects::Shader::Glass);
            glass.set_glass_kind(2);
            assert!(glass.animated());

            let mp4 = dir.0.join("out.mp4");
            export(asset.clone(), glass.clone(), Options { fps: 24, ..Options::default() }, mp4.clone()).unwrap_or_else(|e| panic!("mp4: {e}"));
            let p = probe(&mp4);
            let v = stream(&p, "video").unwrap_or_else(|| panic!("no video stream: {p}"));
            assert_eq!(v["codec_name"], "h264");
            assert_eq!((v["width"].as_u64(), v["height"].as_u64()), (Some(160), Some(90)));
            assert_eq!(v["r_frame_rate"], "24/1");
            assert_eq!(v["nb_read_frames"], "48");
            let a = stream(&p, "audio").unwrap_or_else(|| panic!("no audio stream: {p}"));
            assert_eq!(a["codec_name"], "aac");
            let duration: f64 = p["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
            assert!((duration - 2.0).abs() < 0.1, "duration {duration}");
            // No partial file left behind.
            assert!(!partial_path(&mp4).exists());

            // MOV at 480p-capped (no upscale), without audio.
            let mov = dir.0.join("out.mov");
            let o = Options { format: Format::Mov, include_audio: false, resolution: Resolution::P480, ..Options::default() };
            // Show Original passes the source through: the frames must match it (channel order,
            // orientation, no premultiply darkening).
            let original = Params { show_original: true, ..Params::default() };
            export(asset.clone(), original, o, mov.clone()).unwrap_or_else(|e| panic!("mov: {e}"));
            let p = probe(&mov);
            assert!(stream(&p, "audio").is_none());
            let v = stream(&p, "video").unwrap_or_else(|| panic!("no video stream: {p}"));
            assert_eq!((v["codec_name"].as_str(), v["nb_read_frames"].as_str()), (Some("h264"), Some("60")));
            let diff = difference(&first_frame(&src), &first_frame(&mov));
            assert!(diff < 12.0, "MOV differs from its source by {diff}");
            if let Some(keep) = std::env::var_os("VOIDMESH_KEEP_EXPORTS") {
                for f in [&mp4, &mov] {
                    let _ = std::fs::copy(f, Path::new(&keep).join(f.file_name().unwrap_or_default()));
                }
            }

            let gif = dir.0.join("out.gif");
            let o = Options { format: Format::Gif, fps: 10, gif_max_width: 100, ..Options::default() };
            export(asset, Params::default(), o, gif.clone()).unwrap_or_else(|e| panic!("gif: {e}"));
            let p = probe(&gif);
            let v = stream(&p, "video").unwrap_or_else(|| panic!("no gif stream: {p}"));
            assert_eq!(v["codec_name"], "gif");
            assert_eq!((v["width"].as_u64(), v["height"].as_u64()), (Some(100), Some(56)));
            assert_eq!(v["nb_read_frames"], "20");
        }

        #[test]
        fn export_gif_source_to_mp4() {
            if !tools() {
                return;
            }
            let dir = Scratch(std::env::temp_dir().join(format!("voidmesh-export-gif-{}", std::process::id())));
            let _ = std::fs::create_dir_all(&dir.0);
            let src = dir.0.join("src.gif");
            ffmpeg(&src, &["-f", "lavfi", "-i", "testsrc=size=63x47:rate=10:duration=1"]);
            let asset = Arc::new(crate::media::decode_file(2, &src).unwrap_or_else(|e| panic!("decode: {e}")));
            assert!(exportable(&asset));
            let out = dir.0.join("gif.mp4");
            export(asset, Params::default(), Options { fps: 20, ..Options::default() }, out.clone()).unwrap_or_else(|e| panic!("mp4: {e}"));
            let p = probe(&out);
            let v = stream(&p, "video").unwrap_or_else(|| panic!("no video stream: {p}"));
            // Odd sides round down to even.
            assert_eq!((v["width"].as_u64(), v["height"].as_u64()), (Some(62), Some(46)));
            assert_eq!(v["nb_read_frames"], "20");
            assert!(stream(&p, "audio").is_none());
        }

        #[test]
        fn a_still_cannot_export() {
            let still = Arc::new(crate::media::test_asset(3, 8, 8));
            let r = export(still, Params::default(), Options::default(), std::env::temp_dir().join("never.mp4"));
            assert!(r.is_err());
        }
    }
}
