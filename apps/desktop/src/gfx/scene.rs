//! The canvas's entities on the GPU, built to stay fast with hundreds of thousands of them.
//!
//! - **Instances.** One per entity, in z order, in a persistent storage buffer: a world rect, a
//!   material and flags. They're rebuilt only from the entity chunks that changed (`entities.rs`
//!   chunks are compared by identity) and drawn in one instanced call with the camera as
//!   immediates, so pan and zoom upload nothing.
//! - **Materials.** What an entity shows (asset, frame, params, and for flowing glass its time)
//!   is a material, shared by every entity showing the same thing: a workspace of 131,072 copies
//!   of one image under six effects has six. Each is processed once, at a preview LOD from the
//!   web's tiers for the largest size any visible instance shows it at, into a tile of the atlas
//!   array (`atlas.rs`), or into a texture of its own above the largest tile.
//! - **Visibility.** Instances are grouped in runs of `GROUP`, each with its bounds and the
//!   materials in it, so a frame tests a few thousand boxes to learn which materials show and how
//!   large, and the vertex shader culls the rest.
//! - **Budgets.** New materials and LOD changes are processed under per-frame pixel budgets, LOD
//!   changes wait for the zoom to settle (the web's `lodSettleFrames`) unless the zoom has left a
//!   texture magnified or minified past its tiers, and textures are freed with their last
//!   instance or, unseen, past a byte budget. Nothing is drawn from a texture processed for less
//!   of it than shows (`Material::region`).

use std::collections::HashMap;
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};

use super::atlas::{self, Atlas, Tile};
use super::process::{self, Input, Pipes, ScratchPool};
use crate::effects::Params;
use crate::entities::Chunk;
use crate::media::Asset;
use crate::state::{App, Entity};

/// `VOIDMESH_TRACE_FRAME=1`: each frame's phases on stderr.
struct Trace {
    on: bool,
    at: std::time::Instant,
    laps: Vec<(&'static str, f64)>,
}

impl Trace {
    fn start() -> Trace {
        static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        Trace { on: *ON.get_or_init(|| std::env::var_os("VOIDMESH_TRACE_FRAME").is_some()), at: std::time::Instant::now(), laps: Vec::new() }
    }

    fn lap(&mut self, name: &'static str) {
        if self.on {
            let now = std::time::Instant::now();
            self.laps.push((name, now.duration_since(self.at).as_secs_f64() * 1000.0));
            self.at = now;
        }
    }

    fn finish(&self, st: &Stats) {
        if self.on {
            let laps: Vec<String> = self.laps.iter().map(|(n, ms)| format!("{n} {ms:.3}")).collect();
            eprintln!("scene: {} | visible {} materials {} processed {} pending {} rebuilt {}", laps.join(", "), st.visible, st.materials, st.processed, st.pending, st.rebuilt);
        }
    }
}

/// The world texture's format: premultiplied, sRGB-encoded values, as the processed ones.
pub const WORLD_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// Instances per visibility group.
const GROUP: usize = 256;
/// Materials in a group up to which a partly visible group marks them all (`visibility`).
const GROUP_MATS: usize = 4;
/// Persistent texture budget: atlas, own textures and sources (the web's `entityTextureBudgetBytes`).
const BUDGET: u64 = 512 * 1024 * 1024;
/// Pixels of new materials processed in one frame, and how many.
const COLD_PIXELS: u64 = 48 * 1024 * 1024;
const COLD_COUNT: usize = 4096;
/// Pixels and count of LOD changes in one settled frame.
const TRANSITION_PIXELS: u64 = 8 * 1024 * 1024;
const TRANSITION_COUNT: usize = 32;
/// Frames the zoom must hold before LOD changes...
const SETTLE_FRAMES: u32 = 2;
/// ...but for what a zoom in progress leaves magnified, or minified past `MINIFIED`: this many
/// and pixels of those a frame.
const ZOOM_COUNT: usize = 8;
const ZOOM_PIXELS: u64 = 2 * 1024 * 1024;
/// Minification past the largest a settled level shows at (a tier is chosen with
/// `LOD_OVERSCAN` to spare, and tiers double).
const MINIFIED: f32 = process::LOD_OVERSCAN * 2.0;
/// Processing a frame takes on before it leaves the rest to the next frames.
/// Video frame bytes uploaded a frame (one frame always goes, whatever its size): a zoom that
/// leaves many decoders oversized for a moment spreads their uploads instead of copying them all
/// in one frame.
const VIDEO_BUDGET: u64 = 4 << 20;
/// Processing a frame takes on, still or moving: a backlog (a canvas opened, a zoom's new tier)
/// spreads over frames that each stay quick.
const FRAME_BUDGET: std::time::Duration = std::time::Duration::from_millis(2);
const FIRST_BUDGET: std::time::Duration = std::time::Duration::from_millis(4);
/// Bytes a frame stages for sources: past it, the rest wait for the next frames (as past the
/// time budget). Copying them is the frame's CPU, and what's staged is held until the GPU's done.
const STAGE_BUDGET: u64 = 16 << 20;
/// Materials processed between budget checks.
const BATCH: usize = 8;
/// Textures of materials off screen kept for when they show again.
const UNSEEN_BUDGET: u64 = 24 * 1024 * 1024;
/// Frames a still's source stays unused before it's freed.
const SOURCE_FRAMES: u64 = 4;
/// Media of more pixels than this makes its source mips on the GPU.
const GPU_MIPS_PIXELS: u64 = 1024 * 1024;
/// Bytes of source levels queued with the workers or waiting to be placed (one level always
/// goes): what they hold in buffers of their own until the GPU has copied them.
const SOURCE_BYTES: u64 = 12 << 20;
/// Frames a finished source level waits for a frame that wants it.
const BUILT_FRAMES: u64 = 30;
/// Output pixels processed around a clipped region (`occlusion`), for the drawn edge's filtering.
const CLIP_MARGIN: u32 = 2;
/// Visible instances past which `occlusion` isn't worked out (each is tested against those above).
const OCCLUSION_INSTANCES: usize = 1024;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default, PartialEq)]
struct Inst {
    rect: [f32; 4],
    mat: u32,
    flags: u32,
    progress: f32,
    _pad: u32,
}

const SELECTED: u32 = 1;
const HAIRLINE: u32 = 2;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default, PartialEq)]
struct GpuMat {
    tile: [f32; 4],
    layer: u32,
    levels: u32,
    state: u32,
    flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct World {
    pub view: [f32; 4],
    pub clip: [f32; 4],
    pub fade: [u32; 4],
    pub cam: [f32; 4],
    pub misc: [f32; 4],
    pub tex: [f32; 4],
    pub marquee: [f32; 4],
    pub drag: [f32; 4],
}

/// What a material shows.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum MatKey {
    /// A still or a GIF frame: shared by every entity showing it.
    Image { asset: u64, frame: u32, params: u64, time: u32 },
    /// A video entity's current frame: its own.
    Video { entity: u32, asset: u64, frame: u64, params: u64, time: u32 },
}

enum Tex {
    None,
    Atlas(Tile),
    /// A texture of its own, drawn with its own bind group, and the bytes it holds. A processed
    /// one goes back to the pool when freed; a large original's source level (`recycle` false)
    /// can't be rendered into, so it just goes.
    Own { bind: wgpu::BindGroup, bytes: u64, tex: wgpu::Texture, recycle: bool },
}

struct Material {
    key: MatKey,
    refs: u32,
    asset: Arc<Asset>,
    frame: usize,
    params: Arc<Params>,
    time: f32,
    /// The LOD size it was last built for; (0, 0) before the first. Its content can differ (an
    /// original takes its source's nearest mip level).
    size: (u32, u32),
    tex: Tex,
    /// The frame it was last visible in.
    seen: u64,
    /// The largest world side of a visible instance this frame.
    want: f32,
    /// The frame it was last in the view ahead (`prefetch`).
    ahead: u64,
    gpu: GpuMat,
    /// The part of its texture processed (0–1, x0 y0 x1 y1): all of it but for a continuous
    /// material clipped to what showed (`occlusion`).
    region: [f32; 4],
}

const FULL: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

/// `a` holds `b` (an empty `b` is held by anything).
fn holds(a: [f32; 4], b: [f32; 4]) -> bool {
    b[2] <= b[0] || b[3] <= b[1] || (a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3])
}

/// A material `build_tiles` processes: its id, size, tile, source view, params, time and media size.
type TileJob = (u32, (u32, u32), Tile, wgpu::TextureView, Arc<Params>, f32, (u32, u32));

/// A source: asset, frame, and the mip level its largest level is.
type SrcKey = (u64, u32, u32);

/// A source level waiting in the staging buffer.
#[derive(Clone, Copy)]
struct Staged {
    offset: u64,
    row: u32,
    w: u32,
    h: u32,
}

/// The mip level of media of `media` a preview of `size` reads from: the smallest level at least
/// as large, so no source is held above the size its previews need.
fn source_level(media: (u32, u32), size: (u32, u32)) -> u32 {
    let (m, s) = (media.0.max(media.1).max(1), size.0.max(size.1).max(1));
    let mut k = 0;
    while (m >> (k + 1)) >= s {
        k += 1;
    }
    k
}

/// A source texture for processing: a still or GIF frame from some mip level down, mipmapped.
struct Source {
    tex: wgpu::Texture,
    view: wgpu::TextureView,
    size: (u32, u32),
    levels: u32,
    used: u64,
    animated: bool,
}

/// A video entity's frames: its decoder, the seek it last followed and the frame on the GPU.
struct VideoSource {
    decoder: crate::video::Decoder,
    seek_gen: u32,
    /// Counts uploaded frames: part of the material key.
    frame: u64,
    tex: Option<(wgpu::Texture, wgpu::TextureView)>,
    /// A frame newer than `tex` is waiting in `App::video_frames` for upload.
    pending: bool,
    /// The scene frame it last uploaded on: the stalest go first when uploads are over budget.
    uploaded: u64,
    /// A seek is waiting for its first frame (keep drawing until it lands).
    waiting: bool,
    used: bool,
    /// Its entity plays: its material is processed again with every new frame.
    playing: bool,
    /// Where its entity was last seen.
    index: u32,
    /// The longest side it decodes at, and a different one the view has wanted since a frame.
    side: u32,
    wants: Option<(u32, u64)>,
}

/// The longest side to decode a video of `media` showing `projected` pixels at: the size it's
/// processed at (`process::screen_size`) in 128-pixel steps, so the decoder doesn't restart for
/// every small zoom, scaled in AVFoundation's reader rather than uploaded at full size.
fn decode_side(media: (u32, u32), projected: f32) -> u32 {
    let (w, h) = process::screen_size(media, projected);
    let native = media.0.max(media.1);
    (w.max(h).div_ceil(128) * 128).min(native)
}


#[derive(Default, Clone)]
struct Group {
    /// World bounds: x0, y0, x1, y1.
    bounds: [f32; 4],
    /// Materials in it and their largest world side.
    mats: Vec<(u32, f32)>,
    dirty: bool,
}

/// What the world texture was drawn for: the camera, device scale and size.
#[derive(Clone, Copy, PartialEq)]
struct WorldKey {
    pan: [f32; 2],
    scale: f32,
    dpr: f32,
    size: (u32, u32),
    dark: bool,
    marquee: ([f32; 4], u32),
    drag: Option<[f32; 2]>,
}

/// An open marquee as the world shader takes it: its world rect, and its mode (0 none).
fn marquee(s: &App) -> ([f32; 4], u32) {
    let Some(m) = &s.marquee else { return ([0.0; 4], 0) };
    let [x, y, w, h] = m.rect();
    let (a, b) = (s.cam.world([x, y]), s.cam.world([x + w, y + h]));
    let mode = match m.mode {
        crate::state::MarqueeMode::Replace => 1,
        crate::state::MarqueeMode::Add => 2,
        crate::state::MarqueeMode::Subtract => 3,
    };
    ([a[0], a[1], b[0], b[1]], mode)
}

/// Counters for the performance overlay and benchmarks.
#[derive(Default, Clone, Copy, Debug)]
pub struct Stats {
    pub visible: usize,
    pub materials: usize,
    pub processed: usize,
    pub processed_pixels: u64,
    pub pending: usize,
    pub instance_bytes: u64,
    pub draws: usize,
    pub rebuilt: bool,
    /// The world was drawn again this frame (rather than reused).
    pub redrawn: bool,
    /// GPU bytes held in the categories the web's bench counts (processed, source and pooled
    /// textures)...
    pub resident_bytes: u64,
    /// ...and outside them: decoded video frames' textures and upload staging buffers, which the
    /// web keeps in the browser's own GPU process.
    pub video_bytes: u64,
    pub staging_bytes: u64,
    pub source_uploads: usize,
    /// Visible materials with nothing processed to show yet (drawn as placeholders).
    pub unready: usize,
    /// Visible materials drawn from a texture processed for less of them than shows: the rest
    /// of what's drawn is whatever the texture held before.
    pub stale: usize,
    /// Visible materials drawn magnified past `SOFT` (below their native size): a zoom's
    /// sharper level not processed yet.
    pub soft: usize,
    /// Visible materials drawn minified past `MINIFIED` (one level sampled, they shimmer).
    pub minified: usize,
    /// Visible materials whose level changed this frame (a still's look changes with its level).
    pub swaps: usize,
}

/// Magnification past which a visible material counts as `Stats::soft`.
const SOFT: f32 = 1.5;

pub struct Scene {
    layout: wgpu::BindGroupLayout,
    tex_layout: wgpu::BindGroupLayout,
    /// The atlas as group 1.
    atlas_bind: Option<wgpu::BindGroup>,
    atlas_gen: u64,
    pipeline_layout: wgpu::PipelineLayout,
    module: wgpu::ShaderModule,
    pipelines: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    sampler: wgpu::Sampler,
    atlas: Atlas,
    inst_buf: wgpu::Buffer,
    mat_buf: wgpu::Buffer,
    bind: Option<wgpu::BindGroup>,
    scratch: ScratchPool,

    built_layout: u64,
    chunks: Vec<Chunk>,
    /// Instance → entity index, and back.
    order: Vec<u32>,
    slot_of: Vec<u32>,
    insts: Vec<Inst>,
    dirty: Option<(usize, usize)>,
    groups: Vec<Group>,
    sel_rev: u64,
    flagged: Vec<u32>,
    bare: bool,

    mats: Vec<Option<Material>>,
    free_mats: Vec<u32>,
    mat_index: HashMap<MatKey, u32>,
    mat_dirty: Vec<u32>,
    hashes: HashMap<*const Params, (Arc<Params>, u64)>,
    /// Materials visible this frame.
    visible_mats: Vec<u32>,
    /// Materials not visible but in the view the camera is moving into (`prefetch`), and the
    /// last frame's view it's extrapolated from.
    ahead_mats: Vec<u32>,
    last_view: Option<[f32; 4]>,
    /// Instances drawn from their own textures this frame, in z order.
    own_draws: Vec<u32>,
    /// Processed textures of their own freed this frame and last, for materials of their size.
    pool: Vec<wgpu::Texture>,
    pool_prev: Vec<wgpu::Texture>,
    /// Instance ranges of the groups that meet the view this frame, in order.
    ranges: Vec<(u32, u32)>,
    /// The entities as last drawn, at the canvas's size, and what they were drawn for.
    world: Option<(wgpu::Texture, wgpu::TextureView)>,
    world_for: Option<WorldKey>,
    /// Something drawn changed since the world was last drawn.
    world_dirty: bool,
    /// Bumped whenever the world texture is replaced.
    pub world_gen: u64,
    /// Entity indices of videos, for the layout the instances were built for.
    video_idx: Vec<u32>,

    /// Sources on the GPU by asset, frame and mip level (`source_level`).
    sources: HashMap<SrcKey, Source>,
    /// Source levels written to a staging buffer this frame and not kept as textures: originals
    /// copy straight from there into their atlas tiles.
    staged: HashMap<SrcKey, (wgpu::Buffer, Vec<Staged>)>,
    /// Buffers uploads go through (source batches, video frames, large instance changes).
    staging: Staging,
    /// Source levels are built off the frame (`SourceWorkers`): queued, and done (with the frame
    /// they arrived on) waiting for a frame to place them.
    workers: Option<SourceWorkers>,
    /// Level buffers copied from this frame, pooled once the GPU has run the copies.
    level_pool: LevelPool,
    retired: Vec<wgpu::Buffer>,
    /// Continuous materials' regions anything shows of this frame (0–1, x0 y0 x1 y1; empty when
    /// all of it is hidden), from `occlusion`; and which assets are opaque, by id.
    clips: HashMap<u32, [f32; 4]>,
    opaque_assets: HashMap<u64, bool>,
    building: HashMap<SrcKey, u64>,
    built: HashMap<SrcKey, (u64, Prepared)>,
    built_tx: std::sync::mpsc::Sender<(SrcKey, Option<Prepared>)>,
    built_rx: std::sync::mpsc::Receiver<(SrcKey, Option<Prepared>)>,
    /// Bytes packed for them, reused.
    staging_bytes: Vec<u8>,
    videos: HashMap<(u32, u64), VideoSource>,
    frame: u64,
    last_scale: f32,
    /// Frames the zoom has held (LOD changes wait for it).
    still: u32,
    pub stats: Stats,
    pub video_waiting: bool,
}

/// A source level built off the frame, in a buffer of its own (rows at the copy alignment),
/// written before anything reads it.
struct Prepared {
    buf: wgpu::Buffer,
    w: u32,
    h: u32,
    row: u32,
}

struct SourceWork {
    key: SrcKey,
    asset: Arc<Asset>,
    frame: usize,
}

/// Threads that build source levels: from the proxy when it serves the level, else from the
/// full-size frame (large media's whole frame as it is, for GPU mips). The frame only records
/// the copies: building and writing a level reads pixels the system may have compressed, and
/// copies them, which a frame of many new photos would otherwise spend milliseconds on.
struct SourceWorkers {
    tx: std::sync::mpsc::Sender<SourceWork>,
}

/// Source level buffers the GPU is done with, for the workers' next levels of their size: a new
/// buffer a level is a kernel call and fresh pages to fault in, which a pan of new photos paid
/// for each one.
type LevelPool = Arc<std::sync::Mutex<Vec<wgpu::Buffer>>>;

/// Bytes of level buffers pooled.
const LEVEL_POOL: u64 = 4 << 20;

fn pool_levels(pool: &LevelPool, bufs: Vec<wgpu::Buffer>) {
    let mut p = pool.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut bytes: u64 = p.iter().map(wgpu::Buffer::size).sum();
    for b in bufs {
        if bytes + b.size() <= LEVEL_POOL {
            bytes += b.size();
            p.push(b);
        }
    }
}

impl SourceWorkers {
    fn start(device: &wgpu::Device, queue: &wgpu::Queue, done: std::sync::mpsc::Sender<(SrcKey, Option<Prepared>)>, pool: LevelPool) -> SourceWorkers {
        let (tx, rx) = std::sync::mpsc::channel::<SourceWork>();
        let rx = Arc::new(std::sync::Mutex::new(rx));
        let threads = std::thread::available_parallelism().map_or(2, |n| n.get().saturating_sub(2)).clamp(2, 6);
        for _ in 0..threads {
            let (rx, done, device, queue, pool) = (rx.clone(), done.clone(), device.clone(), queue.clone(), pool.clone());
            // A thread that can't start leaves the others; none starting is out of memory.
            let _ = std::thread::Builder::new().name("voidmesh-source".into()).spawn(move || {
                process::interactive();
                let mut padded = Vec::new();
                loop {
                    let work = match rx.lock() {
                        Ok(rx) => rx.recv(),
                        Err(_) => return,
                    };
                    let Ok(work) = work else { return };
                    let prepared = Self::build(&device, &queue, &pool, &work, &mut padded);
                    if done.send((work.key, prepared)).is_err() {
                        return;
                    }
                }
            });
        }
        SourceWorkers { tx }
    }

    fn send(&self, work: SourceWork) -> bool {
        self.tx.send(work).is_ok()
    }

    fn build(device: &wgpu::Device, queue: &wgpu::Queue, pool: &LevelPool, work: &SourceWork, padded: &mut Vec<u8>) -> Option<Prepared> {
        let a = &work.asset;
        let f = a.frames.get(work.frame)?;
        let level = work.key.2;
        let large = level == 0 && u64::from(a.width) * u64::from(a.height) > GPU_MIPS_PIXELS;
        let proxy = a.proxy().filter(|p| p.level <= level && work.frame == 0);
        let built;
        let (w, h, px): (u32, u32, &[u8]) = match proxy {
            _ if large || level == 0 => (a.width, a.height, &f.rgba),
            Some(p) if p.level == level => (p.width, p.height, &p.rgba),
            Some(p) => {
                built = process::level_chain(p.width, p.height, &p.rgba, level - p.level, 1).pop()?;
                (built.0, built.1, &built.2)
            }
            None => {
                built = process::level_chain(a.width, a.height, &f.rgba, level, 1).pop()?;
                (built.0, built.1, &built.2)
            }
        };
        let src_row = w as usize * 4;
        let row = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        if px.len() < src_row * h as usize {
            return None;
        }
        let size = u64::from(row) * u64::from(h);
        let pooled = {
            let mut p = pool.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            p.iter().position(|b| b.size() == size).map(|i| p.swap_remove(i))
        };
        let buf = pooled.unwrap_or_else(|| device.create_buffer(&wgpu::BufferDescriptor { label: Some("voidmesh source level"), size, usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        if row as usize == src_row {
            queue.write_buffer(&buf, 0, &px[..src_row * h as usize]);
        } else {
            padded.clear();
            padded.resize(row as usize * h as usize, 0);
            for (dst, r) in padded.chunks_exact_mut(row as usize).zip(px.chunks_exact(src_row)) {
                dst[..src_row].copy_from_slice(r);
            }
            queue.write_buffer(&buf, 0, padded);
        }
        Some(Prepared { buf, w, h, row })
    }
}

/// Staging buffers, in sets: a frame takes a set the GPU is done with (or a new one when the GPU
/// is that far behind) and its uploads take buffers from it in turn. A set comes back once the
/// work submitted with it completes, so a queue write always lands in a buffer nothing reads:
/// Rune writes that in place. One written while a copy from it was still in flight would be
/// staged instead, and Rune pins a buffer staged into for good, making every later write to it
/// allocate a new buffer.
#[derive(Default)]
struct Staging {
    sets: Vec<StagingSet>,
    /// The set this frame took, and how many of its buffers it used.
    cur: Option<usize>,
    next: usize,
    /// Bytes asked for this frame.
    frame_bytes: u64,
}

struct StagingSet {
    bufs: Vec<wgpu::Buffer>,
    done: std::sync::Arc<std::sync::atomic::AtomicBool>,
    used: u64,
}

/// Frames a finished set stays unused before its buffers go.
const STAGING_IDLE_FRAMES: u64 = 120;
/// Bytes of buffers a set keeps for the next frame that takes it: enough for a frame's steady
/// uploads (video frames, a few batches). A burst's other buffers go once the GPU is done with them.
const STAGING_KEEP: u64 = 4 << 20;

impl Staging {
    /// A new frame: the last frame's set comes back once the work it was submitted with is done
    /// (it was submitted before this one prepares), and long-unused sets go.
    fn begin(&mut self, queue: &wgpu::Queue, frame: u64) {
        use std::sync::atomic::Ordering;
        if let Some(c) = self.cur.take() {
            // Dropping a handle here is safe: the frame's command buffers hold what they read.
            let mut kept = 0;
            self.sets[c].bufs.retain(|b| {
                kept += b.size();
                kept <= STAGING_KEEP
            });
            let done = self.sets[c].done.clone();
            if self.next == 0 {
                done.store(true, Ordering::Release);
            } else {
                queue.on_submitted_work_done(move || done.store(true, Ordering::Release));
            }
        }
        self.next = 0;
        self.frame_bytes = 0;
        self.sets.retain(|s| !(s.done.load(Ordering::Acquire) && frame.saturating_sub(s.used) > STAGING_IDLE_FRAMES));
    }

    /// This frame's next buffer, at least `size` bytes. Buffers persist with their set (pages
    /// stay mapped) and grow to the largest upload they've taken, in 64 KiB steps (a frame can take
    /// many small batches, a buffer each: a copy recorded from a buffer makes Rune stage any
    /// further write into it).
    fn buffer(&mut self, device: &wgpu::Device, size: u64, label: &str, frame: u64) -> wgpu::Buffer {
        use std::sync::atomic::Ordering;
        let c = match self.cur {
            Some(c) => c,
            None => {
                let c = match self.sets.iter().position(|s| s.done.load(Ordering::Acquire)) {
                    Some(c) => c,
                    None => {
                        self.sets.push(StagingSet { bufs: Vec::new(), done: Default::default(), used: frame });
                        self.sets.len() - 1
                    }
                };
                self.sets[c].done.store(false, Ordering::Release);
                self.sets[c].used = frame;
                self.cur = Some(c);
                c
            }
        };
        let i = self.next;
        self.next += 1;
        self.frame_bytes += size;
        let bufs = &mut self.sets[c].bufs;
        if bufs.get(i).is_none_or(|b| b.size() < size) {
            let b = device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size.next_multiple_of(64 << 10), usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            if i < bufs.len() {
                bufs[i] = b;
            } else {
                bufs.push(b);
            }
        }
        bufs[i].clone()
    }

    fn bytes(&self) -> u64 {
        self.sets.iter().flat_map(|s| &s.bufs).map(wgpu::Buffer::size).sum()
    }
}

/// An RGBA8 texture's bytes, all its levels.
fn texture_bytes(t: &wgpu::Texture) -> u64 {
    (0..t.mip_level_count()).map(|l| u64::from((t.width() >> l).max(1)) * u64::from((t.height() >> l).max(1)) * 4).sum()
}

fn storage_buffer(device: &wgpu::Device, label: &str, bytes: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: bytes.max(256), usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false })
}

impl Scene {
    pub fn new(device: &wgpu::Device, _pipes: &Pipes) -> Scene {
        let (built_tx, built_rx) = std::sync::mpsc::channel();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("voidmesh world"),
            source: wgpu::ShaderSource::Wgsl(format!("{}\n{}", rune::render::CLIP_WGSL, include_str!("world.wgsl")).into()),
        });
        let tex_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("voidmesh world texture"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false },
                count: None,
            }],
        });
        let storage = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("voidmesh world"),
            entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None }, storage(1), storage(2)],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("voidmesh world"), bind_group_layouts: &[Some(&layout), Some(&tex_layout)], immediate_size: std::mem::size_of::<World>() as u32 });
        Scene {
            layout,
            tex_layout,
            atlas_bind: None,
            atlas_gen: u64::MAX,
            pipeline_layout,
            module,
            pipelines: HashMap::new(),
            // The nearest level, bilinear: tiers are within a level of the screen size.
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("voidmesh world"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::MipmapFilterMode::Nearest,
                ..Default::default()
            }),
            atlas: Atlas::new(device),
            inst_buf: storage_buffer(device, "voidmesh instances", 0),
            mat_buf: storage_buffer(device, "voidmesh materials", 0),
            bind: None,
            scratch: ScratchPool::default(),
            built_layout: 0,
            chunks: Vec::new(),
            order: Vec::new(),
            slot_of: Vec::new(),
            insts: Vec::new(),
            dirty: None,
            groups: Vec::new(),
            sel_rev: 0,
            flagged: Vec::new(),
            bare: false,
            mats: Vec::new(),
            free_mats: Vec::new(),
            mat_index: HashMap::new(),
            mat_dirty: Vec::new(),
            hashes: HashMap::new(),
            visible_mats: Vec::new(),
            ahead_mats: Vec::new(),
            last_view: None,
            own_draws: Vec::new(),
            ranges: Vec::new(),
            pool: Vec::new(),
            pool_prev: Vec::new(),
            world: None,
            world_for: None,
            world_dirty: true,
            world_gen: 0,
            video_idx: Vec::new(),
            sources: HashMap::new(),
            staged: HashMap::new(),
            staging: Staging::default(),
            workers: None,
            level_pool: Default::default(),
            retired: Vec::new(),
            clips: HashMap::new(),
            opaque_assets: HashMap::new(),
            building: Default::default(),
            built: HashMap::new(),
            built_tx,
            built_rx,
            staging_bytes: Vec::new(),
            videos: HashMap::new(),
            frame: 1,
            last_scale: 0.0,
            still: 0,
            stats: Stats::default(),
            video_waiting: false,
        }
    }

    pub fn ensure_pipeline(&mut self, device: &wgpu::Device, format: wgpu::TextureFormat) {
        if self.pipelines.contains_key(&format) {
            return;
        }
        let p = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("voidmesh world"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState { module: &self.module, entry_point: Some("vs_world"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &self.module,
                entry_point: Some("fs_world"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        self.pipelines.insert(format, p);
    }

    // ------------------------------------------------------------------ materials

    fn params_hash(&mut self, p: &Arc<Params>) -> u64 {
        if let Some((_, h)) = self.hashes.get(&Arc::as_ptr(p)) {
            return *h;
        }
        let h = process::params_hash(p);
        self.hashes.insert(Arc::as_ptr(p), (p.clone(), h));
        h
    }

    fn key_of(&mut self, e: &Entity) -> MatKey {
        let params = self.params_hash(&e.params);
        let time = if e.params.uses_time() { (e.fx_t as f32).to_bits() } else { 0 };
        let asset = e.asset.id;
        if e.asset.video_path().is_some() {
            let frame = self.videos.get(&(e.id, asset)).map_or(0, |v| v.frame);
            MatKey::Video { entity: e.id, asset, frame, params, time }
        } else {
            MatKey::Image { asset, frame: e.asset.frame_at(e.play_t) as u32, params, time }
        }
    }

    /// Material `id` moved on to `e`'s next time or frame (flowing glass, video), when only `e`
    /// shows it and nothing shows the next yet: the same material, processed again and its
    /// texture showing until then, rather than a new material and the old one freed every frame
    /// (an instance and a material record to upload each, and a placeholder for an instant).
    /// True when it did.
    fn rekey_in_place(&mut self, id: u32, e: &Entity) -> bool {
        let key = self.key_of(e);
        if self.mat_index.contains_key(&key) {
            return false;
        }
        let Some(Some(m)) = self.mats.get_mut(id as usize) else { return false };
        let moved_on = match (m.key, key) {
            (MatKey::Image { asset: a0, params: p0, .. }, MatKey::Image { asset: a1, params: p1, .. }) => a0 == a1 && p0 == p1,
            (MatKey::Video { entity: e0, asset: a0, params: p0, .. }, MatKey::Video { entity: e1, asset: a1, params: p1, .. }) => e0 == e1 && a0 == a1 && p0 == p1,
            _ => false,
        };
        if m.refs != 1 || !moved_on {
            return false;
        }
        let old = std::mem::replace(&mut m.key, key);
        m.frame = e.asset.frame_at(e.play_t);
        m.time = e.fx_t as f32;
        m.size = (0, 0);
        self.mat_index.remove(&old);
        self.mat_index.insert(key, id);
        true
    }

    /// The material showing what `e` shows, made if new; counts a reference.
    fn retain_mat(&mut self, e: &Entity) -> u32 {
        let key = self.key_of(e);
        let id = match self.mat_index.get(&key) {
            Some(id) => *id,
            None => {
                let m = Material {
                    key,
                    refs: 0,
                    asset: e.asset.clone(),
                    frame: e.asset.frame_at(e.play_t),
                    params: e.params.clone(),
                    time: e.fx_t as f32,
                    size: (0, 0),
                    tex: Tex::None,
                    seen: 0,
                    want: 0.0,
                    ahead: 0,
                    gpu: GpuMat::default(),
                    region: FULL,
                };
                let id = match self.free_mats.pop() {
                    Some(id) => {
                        self.mats[id as usize] = Some(m);
                        id
                    }
                    None => {
                        self.mats.push(Some(m));
                        self.mats.len() as u32 - 1
                    }
                };
                self.mat_index.insert(key, id);
                self.mat_dirty.push(id);
                id
            }
        };
        if let Some(m) = self.mats[id as usize].as_mut() {
            m.refs += 1;
        }
        id
    }

    fn release_mat(&mut self, id: u32) {
        let Some(m) = self.mats.get_mut(id as usize).and_then(Option::as_mut) else { return };
        m.refs = m.refs.saturating_sub(1);
        if m.refs > 0 {
            return;
        }
        let Some(m) = self.mats[id as usize].take() else { return };
        self.drop_tex(m.tex);
        self.mat_index.remove(&m.key);
        self.free_mats.push(id);
        self.mat_dirty.push(id);
    }

    /// Free a material's texture: an atlas tile back to the atlas, a processed texture of its own
    /// to the pool for the next frame's material of its size.
    fn drop_tex(&mut self, t: Tex) {
        match t {
            Tex::Atlas(tile) => self.atlas.free(tile),
            Tex::Own { tex, recycle: true, .. } => self.pool.push(tex),
            _ => {}
        }
    }

    fn mat(&self, id: u32) -> Option<&Material> {
        self.mats.get(id as usize).and_then(Option::as_ref)
    }

    // ------------------------------------------------------------------ instances

    fn inst_for(&self, e: &Entity, mat: u32, selected: bool) -> Inst {
        let mut flags = if selected { SELECTED } else { 0 };
        let mut progress = 0.0;
        if e.asset.animated() && !self.bare {
            flags |= HAIRLINE;
            let dur = e.asset.duration.as_secs_f64();
            progress = if dur > 0.0 { (e.play_t / dur).clamp(0.0, 1.0) as f32 } else { 0.0 };
        }
        Inst { rect: e.rect(), mat, flags, progress, _pad: 0 }
    }

    fn touch(&mut self, slot: usize) {
        self.dirty = Some(match self.dirty {
            None => (slot, slot + 1),
            Some((a, b)) => (a.min(slot), b.max(slot + 1)),
        });
        if let Some(g) = self.groups.get_mut(slot / GROUP) {
            g.dirty = true;
        }
    }

    /// Rebuild every instance: entities were added, removed or reordered.
    fn rebuild(&mut self, s: &App) {
        let n = s.entities.len();
        let mut order: Vec<u32> = (0..n as u32).collect();
        // Z order; entities are almost always in it already.
        if !s.entities.iter().zip(s.entities.iter().skip(1)).all(|(a, b)| a.z <= b.z) {
            let z: Vec<u32> = s.entities.iter().map(|e| e.z).collect();
            order.sort_by_key(|i| z[*i as usize]);
        }
        let mut slot_of = vec![0u32; n];
        for (slot, i) in order.iter().enumerate() {
            slot_of[*i as usize] = slot as u32;
        }
        // References to the new materials first, so shared ones aren't freed and remade.
        let old: Vec<u32> = self.insts.iter().map(|i| i.mat).collect();
        let mut insts = Vec::with_capacity(n);
        let mut prev: Option<(*const Asset, *const Params, u32, u32, u32)> = None;
        let mut prev_mat = 0;
        for &i in &order {
            let Some(e) = s.entities.get(i as usize) else { continue };
            // Runs of entities showing the same thing (the common case) skip the key lookup.
            let sig = (Arc::as_ptr(&e.asset), Arc::as_ptr(&e.params), e.asset.frame_at(e.play_t) as u32, if e.params.uses_time() { (e.fx_t as f32).to_bits() } else { 0 }, u32::from(e.asset.video_path().is_some()));
            let mat = if prev == Some(sig) && sig.4 == 0 {
                if let Some(m) = self.mats[prev_mat as usize].as_mut() {
                    m.refs += 1;
                }
                prev_mat
            } else {
                self.retain_mat(e)
            };
            prev = Some(sig);
            prev_mat = mat;
            insts.push(self.inst_for(e, mat, s.selection.contains(&e.id)));
        }
        for m in old {
            self.release_mat(m);
        }
        self.insts = insts;
        self.order = order;
        self.slot_of = slot_of;
        self.flagged = self.insts.iter().enumerate().filter(|(_, i)| i.flags & SELECTED != 0).map(|(s, _)| s as u32).collect();
        self.groups = vec![Group { dirty: true, ..Group::default() }; n.div_ceil(GROUP)];
        self.dirty = (n > 0).then_some((0, n));
        self.chunks = s.entities.chunks().to_vec();
        self.built_layout = s.entities.layout();
        self.sel_rev = s.selection.rev();
        self.video_idx = s.entities.iter().enumerate().filter(|(_, e)| e.asset.video_path().is_some()).map(|(i, _)| i as u32).collect();
        self.stats.rebuilt = true;
    }

    /// Re-derive entity `i`'s instance.
    fn rederive(&mut self, s: &App, i: usize, old: Option<&Entity>) {
        let Some(e) = s.entities.get(i) else { return };
        let slot = self.slot_of[i] as usize;
        let cur = self.insts[slot];
        // Same asset, params, frame and clock: same material, whatever moved.
        let same = old.is_some_and(|o| {
            Arc::ptr_eq(&o.asset, &e.asset)
                && Arc::ptr_eq(&o.params, &e.params)
                && o.asset.video_path().is_none()
                && o.asset.frame_at(o.play_t) == e.asset.frame_at(e.play_t)
                && (!e.params.uses_time() || o.fx_t == e.fx_t)
        });
        let mat = if same || self.rekey_in_place(cur.mat, e) {
            cur.mat
        } else {
            let m = self.retain_mat(e);
            self.release_mat(cur.mat);
            m
        };
        let next = self.inst_for(e, mat, cur.flags & SELECTED != 0);
        if next != cur {
            self.insts[slot] = next;
            self.touch(slot);
        }
    }

    fn sync(&mut self, s: &App) {
        self.stats.rebuilt = false;
        if s.entities.layout() != self.built_layout || s.bare != self.bare {
            self.bare = s.bare;
            self.rebuild(s);
            return;
        }
        for (ci, chunk) in s.entities.chunks().iter().enumerate() {
            if Arc::ptr_eq(chunk, &self.chunks[ci]) {
                continue;
            }
            let old = std::mem::replace(&mut self.chunks[ci], chunk.clone());
            for (j, e) in chunk.iter().enumerate() {
                self.rederive(s, ci * crate::entities::CHUNK + j, old.get(j).filter(|o| o.id == e.id));
            }
        }
        // An open marquee is drawn from the selection it started from (the world shader tests
        // each instance against it): the selection it changes on every move applies once it closes.
        if s.selection.rev() != self.sel_rev && s.marquee.is_none() {
            self.sel_rev = s.selection.rev();
            for slot in std::mem::take(&mut self.flagged) {
                self.insts[slot as usize].flags &= !SELECTED;
                self.touch(slot as usize);
            }
            let mut flagged = Vec::with_capacity(s.selection.len());
            for id in s.selection.iter() {
                if let Some(i) = s.entities.position(*id) {
                    let slot = self.slot_of[i] as usize;
                    self.insts[slot].flags |= SELECTED;
                    flagged.push(slot as u32);
                    self.touch(slot);
                }
            }
            self.flagged = flagged;
        }
    }

    // ------------------------------------------------------------------ videos

    fn update_videos(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, s: &mut App, dpr: f32) {
        self.video_waiting = false;
        let found: Vec<usize> = self.video_idx.iter().map(|i| *i as usize).collect();
        let upload = crate::video::Upload { device: device.clone(), queue: queue.clone() };
        for v in self.videos.values_mut() {
            v.used = false;
        }
        let mut changed = Vec::new();
        // Decoders restarted at a new size this frame: a couple at most, so a zoom spreads them.
        let mut restarts = 0;
        for i in found {
            let Some(e) = s.entities.get(i) else { continue };
            let Some(path) = e.asset.video_path() else { continue };
            let key = (e.id, e.asset.id);
            let r = s.cam.screen_rect(e.rect());
            let on_screen = r[0] < s.canvas[2] && r[0] + r[2] > 0.0 && r[1] < s.canvas[3] && r[1] + r[3] > 0.0;
            // Off screen, a decoder never grows (a zoom into one corner leaves the rest projected
            // large but unseen): a new one starts at the smallest size.
            let mut want = decode_side((e.asset.width, e.asset.height), e.size[0].max(e.size[1]) * s.cam.scale * dpr);
            if !on_screen {
                want = want.min(self.videos.get(&key).map_or(128, |v| v.side));
            }
            let frame = self.frame;
            let v = self.videos.entry(key).or_insert_with(|| VideoSource {
                decoder: crate::video::Decoder::uploading(path.to_path_buf(), e.play_t, want, upload.clone()),
                side: want,
                wants: None,
                seek_gen: e.seek_gen,
                frame: 0,
                tex: None,
                pending: false,
                uploaded: 0,
                waiting: true,
                used: true,
                playing: e.playing,
                index: i as u32,
            });
            v.used = true;
            v.playing = e.playing;
            v.index = i as u32;
            // A new decode size once the view has wanted it a moment: soon for more detail, later
            // for less, so a zoom doesn't restart decoders on every tier it passes.
            if want == v.side {
                v.wants = None;
            } else {
                let since = match v.wants {
                    Some((w, since)) if w == want => since,
                    _ => {
                        v.wants = Some((want, frame));
                        frame
                    }
                };
                let hold = if want > v.side { 4 } else { 12 };
                if frame - since >= hold && restarts < 2 {
                    restarts += 1;
                    v.decoder = crate::video::Decoder::uploading(path.to_path_buf(), e.play_t, want, upload.clone());
                    v.side = want;
                    v.wants = None;
                    v.waiting = true;
                }
            }
            if v.seek_gen != e.seek_gen {
                v.decoder.seek(e.play_t);
                v.seek_gen = e.seek_gen;
                v.waiting = true;
            }
            // Off screen, frames are taken (playback stays in step, picking reads them) but not
            // uploaded or processed.
            let shown = on_screen || v.tex.is_none();
            if let Some(f) = v.decoder.frame_at(e.play_t) {
                v.pending = shown;
                if !shown {
                    v.waiting = false;
                }
                if let Some(old) = s.video_frames.insert(key, f) {
                    crate::video::recycle(old.rgba);
                    // Its last copy was recorded on an earlier frame, so submitted already.
                    if let Some(g) = old.gpu {
                        queue.on_submitted_work_done(move || crate::video::recycle_gpu(g.buf));
                    }
                }
            } else if !shown {
                v.pending = false;
            }
            if v.decoder.error().is_some() {
                v.waiting = false;
            }
        }
        self.videos.retain(|_, v| v.used);
        s.video_frames.retain(|k, _| self.videos.contains_key(k));
        let (uploaded, bytes) = self.upload_videos(device, enc, s);
        for v in self.videos.values() {
            self.video_waiting |= v.waiting || v.pending;
        }
        if std::env::var_os("VOIDMESH_TRACE_FRAME").is_some() && (restarts > 0 || !uploaded.is_empty()) {
            eprintln!("videos: {restarts} restarted, {} uploaded, {} KB", uploaded.len(), bytes >> 10);
        }
        changed.extend(uploaded);
        for i in changed {
            if i < self.slot_of.len() {
                self.rederive(s, i, None);
            }
        }
    }

    /// Copies waiting video frames into their textures: a seek's first frame, then the stalest,
    /// up to `VIDEO_BUDGET` bytes a frame (and always one), the rest on the next frames. The
    /// entities whose frames changed, and the bytes.
    fn upload_videos(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, s: &App) -> (Vec<usize>, u64) {
        let mut want: Vec<((u32, u64), bool, u64)> = self.videos.iter().filter(|(_, v)| v.pending).map(|(k, v)| (*k, v.waiting, v.uploaded)).collect();
        if want.is_empty() {
            return (Vec::new(), 0);
        }
        want.sort_unstable_by_key(|(k, waiting, at)| (!waiting, *at, *k));
        let mut changed = Vec::new();
        let mut total = 0u64;
        for (key, _, _) in want {
            // Frames arrive in buffers of their own (`Decoder::uploading`): a copy each.
            let Some(f) = s.video_frames.get(&key) else { continue };
            let Some(g) = &f.gpu else { continue };
            if !changed.is_empty() && total + g.buf.size() > VIDEO_BUDGET {
                break;
            }
            total += g.buf.size();
            let Some(v) = self.videos.get_mut(&key) else { continue };
            if v.tex.as_ref().is_none_or(|(t, _)| (t.width(), t.height()) != (f.width, f.height)) {
                let t = process::texture(device, f.width, f.height);
                let view = t.create_view(&Default::default());
                v.tex = Some((t, view));
            }
            if let Some((t, _)) = &v.tex {
                enc.copy_buffer_to_texture(
                    wgpu::TexelCopyBufferInfo { buffer: &g.buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(g.row), rows_per_image: Some(f.height) } },
                    t.as_image_copy(),
                    wgpu::Extent3d { width: f.width, height: f.height, depth_or_array_layers: 1 },
                );
            }
            v.frame = v.frame.wrapping_add(1);
            v.pending = false;
            v.waiting = false;
            v.uploaded = self.frame;
            changed.push(v.index as usize);
        }
        (changed, total)
    }

    // ------------------------------------------------------------------ visibility and LOD

    fn refresh_groups(&mut self) {
        for (gi, g) in self.groups.iter_mut().enumerate() {
            if !g.dirty {
                continue;
            }
            g.dirty = false;
            let insts = &self.insts[gi * GROUP..((gi + 1) * GROUP).min(self.insts.len())];
            let mut b = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
            g.mats.clear();
            for i in insts {
                let r = i.rect;
                b = [b[0].min(r[0]), b[1].min(r[1]), b[2].max(r[0] + r[2]), b[3].max(r[1] + r[3])];
                let side = r[2].max(r[3]);
                match g.mats.iter_mut().find(|(m, _)| *m == i.mat) {
                    Some((_, s)) => *s = s.max(side),
                    None => g.mats.push((i.mat, side)),
                }
            }
            g.bounds = b;
        }
    }

    /// Which materials show, at what world size, and how many instances: the world rect `view`.
    fn visibility(&mut self, view: [f32; 4]) {
        for &m in &self.visible_mats {
            if let Some(Some(m)) = self.mats.get_mut(m as usize) {
                m.want = 0.0;
            }
        }
        self.visible_mats.clear();
        let [vx0, vy0, vx1, vy1] = view;
        let mut visible = 0;
        let frame = self.frame;
        self.ranges.clear();
        let n = self.insts.len() as u32;
        for (gi, g) in self.groups.iter().enumerate() {
            let b = g.bounds;
            if b[0] > vx1 || b[2] < vx0 || b[1] > vy1 || b[3] < vy0 {
                continue;
            }
            let (a, z) = ((gi * GROUP) as u32, (((gi + 1) * GROUP) as u32).min(n));
            match self.ranges.last_mut() {
                Some(r) if r.1 == a => r.1 = z,
                _ => self.ranges.push((a, z)),
            }
            let inside = b[0] >= vx0 && b[2] <= vx1 && b[1] >= vy0 && b[3] <= vy1;
            // A group of a few materials (shared media) partly in view: its visible instances
            // counted, its materials marked at the group's largest side, rather than an instance
            // at a time. Many materials (unique photos) still go an instance at a time, so the
            // ones off screen aren't processed.
            let partly = if inside || g.mats.len() > GROUP_MATS {
                None
            } else {
                Some(self.insts[gi * GROUP..((gi + 1) * GROUP).min(self.insts.len())].iter().filter(|i| {
                    let r = i.rect;
                    !(r[0] > vx1 || r[0] + r[2] < vx0 || r[1] > vy1 || r[1] + r[3] < vy0)
                }).count())
            };
            if inside || partly.is_some_and(|n| n > 0) {
                visible += partly.unwrap_or(((gi + 1) * GROUP).min(self.insts.len()) - gi * GROUP);
                for &(m, side) in &g.mats {
                    if let Some(Some(mat)) = self.mats.get_mut(m as usize) {
                        if mat.seen != frame {
                            mat.seen = frame;
                            mat.want = 0.0;
                            self.visible_mats.push(m);
                        }
                        mat.want = mat.want.max(side);
                    }
                }
                continue;
            }
            if partly.is_some() {
                continue;
            }
            for i in &self.insts[gi * GROUP..((gi + 1) * GROUP).min(self.insts.len())] {
                let r = i.rect;
                if r[0] > vx1 || r[0] + r[2] < vx0 || r[1] > vy1 || r[1] + r[3] < vy0 {
                    continue;
                }
                visible += 1;
                if let Some(Some(mat)) = self.mats.get_mut(i.mat as usize) {
                    if mat.seen != frame {
                        mat.seen = frame;
                        mat.want = 0.0;
                        self.visible_mats.push(i.mat);
                    }
                    mat.want = mat.want.max(r[2].max(r[3]));
                }
            }
        }
        self.stats.visible = visible;
    }

    // ------------------------------------------------------------------ processing

    /// The source a material of preview `size` reads: the level covering what it shows on screen
    /// (the tier less its overscan), so the 1.25× margin isn't paid twice.
    fn source_key(m: &Material, size: (u32, u32)) -> SrcKey {
        let shown = |v: u32| ((v as f32 / process::LOD_OVERSCAN).ceil() as u32).max(1);
        (m.asset.id, m.frame as u32, source_level((m.asset.width, m.asset.height), (shown(size.0), shown(size.1))))
    }

    /// Put on the GPU the sources the materials `chosen` (at their sizes) read: each from the mip
    /// level its preview needs. Their levels are built on every core at once, packed into one
    /// buffer written once, and copied out on the GPU; an original small enough for the atlas is
    /// copied from there straight into its tile, with no source texture kept.
    fn prepare_sources(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, chosen: &[(u32, (u32, u32))]) {
        // Levels the workers finished.
        while let Ok((key, prepared)) = self.built_rx.try_recv() {
            self.building.remove(&key);
            if let Some(p) = prepared {
                self.built.insert(key, (self.frame, p));
            }
        }
        let frame = self.frame;
        let expired: Vec<SrcKey> = self.built.iter().filter(|(_, (at, _))| frame - *at >= BUILT_FRAMES).map(|(k, _)| *k).collect();
        let idle: Vec<wgpu::Buffer> = expired.into_iter().filter_map(|k| self.built.remove(&k)).map(|(_, p)| p.buf).collect();
        pool_levels(&self.level_pool, idle);
        for &(id, size) in chosen {
            let Some(m) = self.mats.get(id as usize).and_then(Option::as_ref) else { continue };
            if matches!(m.key, MatKey::Video { .. }) {
                continue;
            }
            let key = Self::source_key(m, size);
            if let Some(s) = self.sources.get_mut(&key) {
                s.used = frame;
                continue;
            }
            if self.staged.contains_key(&key) {
                continue;
            }
            let content = m.asset.width.max(m.asset.height) >> key.2;
            // Kept as a texture when processing reads it, or an original too large for a tile
            // draws from it; an original that fits copies straight into its tile.
            let texture = !m.params.show_original || !atlas::Atlas::fits(content, content);
            let large = key.2 == 0 && u64::from(m.asset.width) * u64::from(m.asset.height) > GPU_MIPS_PIXELS;
            let Some((_, p)) = self.built.remove(&key) else {
                // As its buffer holds it: rows at the copy alignment.
                let bytes = u64::from(((m.asset.width >> key.2).max(1) * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)) * u64::from((m.asset.height >> key.2).max(1));
                let held: u64 = self.building.values().sum::<u64>() + self.built.values().map(|(_, p)| p.buf.size()).sum::<u64>();
                if !self.building.contains_key(&key) && (held == 0 || held + bytes <= SOURCE_BYTES) {
                    let workers = self.workers.get_or_insert_with(|| SourceWorkers::start(device, queue, self.built_tx.clone(), self.level_pool.clone()));
                    if workers.send(SourceWork { key, asset: m.asset.clone(), frame: m.frame }) {
                        self.building.insert(key, bytes);
                    }
                }
                continue;
            };
            self.stats.source_uploads += 1;
            self.staging.frame_bytes += p.buf.size();
            let place = Staged { offset: 0, row: p.row, w: p.w, h: p.h };
            if !texture && !large {
                self.staged.insert(key, (p.buf, vec![place]));
                continue;
            }
            let tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("voidmesh source"),
                size: wgpu::Extent3d { width: p.w, height: p.h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: process::FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            enc.copy_buffer_to_texture(
                wgpu::TexelCopyBufferInfo { buffer: &p.buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(p.row), rows_per_image: Some(p.h) } },
                tex.as_image_copy(),
                wgpu::Extent3d { width: p.w, height: p.h, depth_or_array_layers: 1 },
            );
            self.retired.push(p.buf);
            let view = tex.create_view(&Default::default());
            self.sources.insert(key, Source { levels: 1, tex, view, size: (p.w, p.h), used: frame, animated: m.asset.animated() });
        }
    }

    /// Process the materials of `batch` that are their effect pass alone and fit the atlas, a
    /// render pass per atlas layer for all of them (`process::run_tiles`). Returns the others.
    fn build_tiles(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, batch: &[(u32, (u32, u32))]) -> Vec<(u32, (u32, u32))> {
        let mut rest = Vec::new();
        // (id, size, tile, source view, params, time, media)
        let mut jobs: Vec<TileJob> = Vec::new();
        for &(id, size) in batch {
            let Some(m) = self.mat(id) else { continue };
            let continuous = m.params.uses_time() || matches!(m.key, MatKey::Video { .. }) || m.asset.animated();
            let fits = atlas::Atlas::fits(size.0, size.1);
            if continuous || !fits || m.params.show_original || !process::one_pass(&m.params) {
                rest.push((id, size));
                continue;
            }
            let skey = Self::source_key(m, size);
            let (params, time, media) = (m.params.clone(), m.time, (m.asset.width, m.asset.height));
            let Some(src) = self.sources.get_mut(&skey) else {
                rest.push((id, size));
                continue;
            };
            src.used = self.frame;
            // The source level nearest this size, as `run` reads it.
            // The smallest source level still as large as the output.
            let lod = ((src.size.0.max(src.size.1) as f32 / size.0.max(size.1) as f32).log2()).clamp(0.0, (src.levels.max(1) - 1) as f32);
            let view = if src.levels == 1 { src.view.clone() } else { src.tex.create_view(&wgpu::TextureViewDescriptor { base_mip_level: lod.floor() as u32, mip_level_count: Some(1), ..Default::default() }) };
            let Some(tile) = self.atlas.alloc(device, enc, size.0, size.1) else {
                rest.push((id, size));
                continue;
            };
            jobs.push((id, size, tile, view, params, time, media));
        }
        if jobs.is_empty() {
            return rest;
        }
        let levels = process::levels_for(jobs.iter().map(|j| j.1.0.min(j.1.1)).min().unwrap_or(1), 1).min(process::PREVIEW_LEVELS);
        let mut layers: Vec<u32> = jobs.iter().map(|j| j.2.layer).collect();
        layers.sort_unstable();
        layers.dedup();
        for layer in layers {
            let tiled: Vec<process::Tiled<'_>> = jobs
                .iter()
                .filter(|j| j.2.layer == layer)
                .map(|j| process::Tiled { src: j.3.clone(), params: &j.4, time: j.5, media: j.6, at: [j.2.x, j.2.y, j.1.0, j.1.1] })
                .collect();
            process::run_tiles(device, enc, pipes, &self.atlas.texture, layer, levels, &tiled);
        }
        for (id, size, tile, ..) in jobs {
            let gpu = GpuMat { tile: [tile.x as f32, tile.y as f32, size.0 as f32, size.1 as f32], layer: tile.layer, levels, state: 1, flags: 0 };
            self.finish_build(id, Tex::Atlas(tile), gpu, size, size);
        }
        rest
    }

    /// Process material `id` at `size`, replacing what it had.
    fn build(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, id: u32, size: (u32, u32)) {
        let Some(m) = self.mats.get(id as usize).and_then(Option::as_ref) else { return };
        let (asset, params, time, key, skey) = (m.asset.clone(), m.params.clone(), m.time, m.key, Self::source_key(m, size));
        let media = (asset.width, asset.height);
        // An original small enough for the atlas, its levels waiting in the staging buffer:
        // copied from there into its tile.
        if params.show_original
            && !self.sources.contains_key(&skey)
            && let Some((staging, place)) = self.staged.get(&skey).cloned()
            && let Some(first) = place.first().copied()
        {
            let Some(tile) = self.atlas.alloc(device, enc, first.w, first.h) else { return };
            let levels = (place.len() as u32).min(process::levels_for(first.w, first.h)).min(process::PREVIEW_LEVELS);
            for (j, st) in place.iter().take(levels as usize).enumerate() {
                let j = j as u32;
                enc.copy_buffer_to_texture(
                    wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: st.offset, bytes_per_row: Some(st.row), rows_per_image: Some(st.h) } },
                    wgpu::TexelCopyTextureInfo { texture: &self.atlas.texture, mip_level: j, origin: wgpu::Origin3d { x: tile.x >> j, y: tile.y >> j, z: tile.layer }, aspect: wgpu::TextureAspect::All },
                    wgpu::Extent3d { width: st.w, height: st.h, depth_or_array_layers: 1 },
                );
            }
            let gpu = GpuMat { tile: [tile.x as f32, tile.y as f32, first.w as f32, first.h as f32], layer: tile.layer, levels, state: 1, flags: 1 };
            self.finish_build(id, Tex::Atlas(tile), gpu, size, (first.w, first.h));
            return;
        }
        // The input: a video's latest frame or a still's mipmapped source.
        let (src_view, src_size, src_levels, src_tex) = match key {
            MatKey::Video { entity, asset: a, .. } => {
                let Some((t, v)) = self.videos.get(&(entity, a)).and_then(|v| v.tex.as_ref()) else { return };
                (v.clone(), (t.width(), t.height()), 1, t.clone())
            }
            MatKey::Image { .. } => {
                let Some(s) = self.sources.get_mut(&skey) else { return };
                s.used = self.frame;
                (s.view.clone(), s.size, s.levels, s.tex.clone())
            }
        };
        // An original small enough for a tile is its source level, copied in; a larger one is
        // resampled to its preview size below, as any effect is, rather than kept at its source's.
        let original = params.show_original && !matches!(key, MatKey::Video { .. });
        if original && !atlas::Atlas::fits(src_size.0, src_size.1) {
            // A large original is its source level: drawn from it, with no copy.
            let view = src_tex.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
            let bind = self.tex_bind(device, &view);
            let gpu = GpuMat { tile: [0.0, 0.0, src_size.0 as f32, src_size.1 as f32], layer: 0, levels: 1, state: 2, flags: 1 };
            // The material holds it now: the source map lets go, so it's counted once.
            self.sources.remove(&skey);
            let bytes = u64::from(src_size.0) * u64::from(src_size.1) * 4;
            self.finish_build(id, Tex::Own { bind, bytes, tex: src_tex, recycle: false }, gpu, size, src_size);
            return;
        }
        let straight = original;
        let (tex, gpu, done) = if straight {
            let k = 0;
            let (cw, ch) = src_size;
            {
                let Some(tile) = self.atlas.alloc(device, enc, cw, ch) else { return };
                let levels = process::levels_for(cw, ch).min(src_levels - k).min(process::PREVIEW_LEVELS);
                for j in 0..levels {
                    let (lw, lh) = ((cw >> j).max(1), (ch >> j).max(1));
                    enc.copy_texture_to_texture(
                        wgpu::TexelCopyTextureInfo { texture: &src_tex, mip_level: k + j, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                        wgpu::TexelCopyTextureInfo { texture: &self.atlas.texture, mip_level: j, origin: wgpu::Origin3d { x: tile.x >> j, y: tile.y >> j, z: tile.layer }, aspect: wgpu::TextureAspect::All },
                        wgpu::Extent3d { width: lw, height: lh, depth_or_array_layers: 1 },
                    );
                }
                (Tex::Atlas(tile), GpuMat { tile: [tile.x as f32, tile.y as f32, cw as f32, ch as f32], layer: tile.layer, levels, state: 1, flags: 1 }, (cw, ch))
            }
        } else {
            let input = Input { texture: &src_tex, view: &src_view, size: src_size, levels: src_levels, media };
            // What changes every frame (flowing glass, video and GIF frames) renders into a
            // texture of its own, recycled frame to frame: no copy into the atlas, and no mip
            // chain (as the web keeps none), since it's drawn again next frame anyway.
            let continuous = params.uses_time() || matches!(key, MatKey::Video { .. }) || asset.animated();
            if !continuous && atlas::Atlas::fits(size.0, size.1) {
                let Some(tile) = self.atlas.alloc(device, enc, size.0, size.1) else { return };
                let out = self.scratch.get(size).out(device).clone();
                process::run(device, enc, pipes, &mut self.scratch, &input, &params, time, &out, None);
                let levels = out.mip_level_count();
                for j in 0..levels {
                    let (lw, lh) = ((size.0 >> j).max(1), (size.1 >> j).max(1));
                    enc.copy_texture_to_texture(
                        wgpu::TexelCopyTextureInfo { texture: &out, mip_level: j, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                        wgpu::TexelCopyTextureInfo { texture: &self.atlas.texture, mip_level: j, origin: wgpu::Origin3d { x: tile.x >> j, y: tile.y >> j, z: tile.layer }, aspect: wgpu::TextureAspect::All },
                        wgpu::Extent3d { width: lw, height: lh, depth_or_array_layers: 1 },
                    );
                }
                (Tex::Atlas(tile), GpuMat { tile: [tile.x as f32, tile.y as f32, size.0 as f32, size.1 as f32], layer: tile.layer, levels, state: 1, flags: 0 }, size)
            } else {
                let levels = if continuous { 1 } else { process::levels_for(size.0, size.1).min(process::PREVIEW_LEVELS) };
                let fits = |t: &wgpu::Texture| (t.width(), t.height(), t.mip_level_count()) == (size.0, size.1, levels);
                let out = match self.pool.iter().position(fits) {
                    Some(i) => self.pool.swap_remove(i),
                    None => match self.pool_prev.iter().position(fits) {
                        Some(i) => self.pool_prev.swap_remove(i),
                        None => process::target_mips(device, size.0, size.1, levels, "voidmesh material"),
                    },
                };
                // Only the part that shows (`occlusion`), with a margin for filtering; nothing
                // when it's all hidden.
                let clip = match self.clips.get(&id) {
                    Some(c) if c[2] <= c[0] || c[3] <= c[1] => {
                        self.pool.push(out);
                        return;
                    }
                    Some(c) => {
                        let (fw, fh) = (size.0 as f32, size.1 as f32);
                        let x0 = ((c[0] * fw).floor() as u32).saturating_sub(CLIP_MARGIN);
                        let y0 = ((c[1] * fh).floor() as u32).saturating_sub(CLIP_MARGIN);
                        let x1 = (((c[2] * fw).ceil() as u32) + CLIP_MARGIN).min(size.0);
                        let y1 = (((c[3] * fh).ceil() as u32) + CLIP_MARGIN).min(size.1);
                        // The edges too: an occluder's edge lying on this one's is partly
                        // transparent where it's anti-aliased, and shows this one through.
                        let (w, h, m) = (size.0, size.1, CLIP_MARGIN.min(size.0).min(size.1));
                        (x1 > x0 && y1 > y0).then(|| vec![[x0, y0, x1 - x0, y1 - y0], [0, 0, w, m], [0, h - m, w, m], [0, 0, m, h], [w - m, 0, m, h]])
                    }
                    None => None,
                };
                process::run(device, enc, pipes, &mut self.scratch, &input, &params, time, &out, clip.as_deref());
                let region = clip.as_ref().map_or(FULL, |c| {
                    let (w, h) = (size.0 as f32, size.1 as f32);
                    [c[0][0] as f32 / w, c[0][1] as f32 / h, (c[0][0] + c[0][2]) as f32 / w, (c[0][1] + c[0][3]) as f32 / h]
                });
                let view = out.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
                let bind = self.tex_bind(device, &view);
                let bytes = texture_bytes(&out);
                let gpu = GpuMat { tile: [0.0, 0.0, size.0 as f32, size.1 as f32], layer: 0, levels: out.mip_level_count(), state: 2, flags: 0 };
                self.finish_build(id, Tex::Own { bind, bytes, tex: out, recycle: true }, gpu, size, size);
                if let Some(Some(m)) = self.mats.get_mut(id as usize) {
                    m.region = region;
                }
                return;
            }
        };
        self.finish_build(id, tex, gpu, size, done);
    }

    /// Material `id` built for `size` into `tex` (`done` its content): the old texture goes.
    fn finish_build(&mut self, id: u32, tex: Tex, gpu: GpuMat, size: (u32, u32), done: (u32, u32)) {
        if let Some(m) = self.mats[id as usize].as_mut() {
            let old = std::mem::replace(&mut m.tex, tex);
            // Its GPU record changes only when where it's drawn from does (a texture of its own
            // drawn again isn't a change): no upload for that.
            if m.gpu != gpu {
                self.mat_dirty.push(id);
            }
            m.gpu = gpu;
            // A level change of what showed before: its look changes (a continuous material's
            // changes every frame anyway).
            let continuous = m.params.uses_time() || matches!(m.key, MatKey::Video { .. }) || m.asset.animated();
            if !continuous && m.size != (0, 0) && m.size != size && m.seen == self.frame {
                self.stats.swaps += 1;
            }
            m.size = size;
            m.region = FULL;
            self.drop_tex(old);
        }
        self.stats.processed += 1;
        self.world_dirty = true;
        self.stats.processed_pixels += u64::from(done.0) * u64::from(done.1);
    }

    /// Group 1 for a texture drawn as the world's (the atlas, or an own-texture material's).
    fn tex_bind(&self, device: &wgpu::Device, view: &wgpu::TextureView) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("voidmesh world texture"), layout: &self.tex_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) }] })
    }

    fn schedule(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, px_per_world: f32) {
        let settled = self.still >= SETTLE_FRAMES;
        // Shown with less of it processed than shows (a clip a frame passed by): processed again
        // now, whatever the budgets, as drawing it would show what its texture held before.
        let mut forced: Vec<(u32, (u32, u32))> = Vec::new();
        let mut cold: Vec<(u32, (u32, u32))> = Vec::new();
        let mut moves: Vec<(u32, (u32, u32))> = Vec::new();
        let visible_count = self.visible_mats.len();
        for (k, &id) in self.visible_mats.iter().chain(&self.ahead_mats).enumerate() {
            let ahead = k >= visible_count;
            let Some(m) = self.mat(id) else { continue };
            if ahead && m.size != (0, 0) {
                continue;
            }
            let lacking = !ahead && !matches!(m.tex, Tex::None) && !holds(m.region, self.clips.get(&id).copied().unwrap_or(FULL));
            let media = (m.asset.width, m.asset.height);
            let continuous = m.params.uses_time() || matches!(m.key, MatKey::Video { .. });
            let projected = m.want * px_per_world;
            let desired = if continuous {
                process::screen_size(media, projected)
            } else {
                let tier = process::lod_size(media, projected);
                // A large original draws from its source level, chosen by what it shows: sized by
                // its projection (as `source_key` reads a size, overscan and all) rather than its
                // tier, a 900-pixel photo reads the 1024 level, not the 2048 one four times larger.
                if m.params.show_original && !atlas::Atlas::fits(tier.0, tier.1) { process::screen_size(media, projected * process::LOD_OVERSCAN) } else { tier }
            };
            if lacking {
                forced.push((id, desired));
            } else if m.size == desired {
                continue;
            } else if m.size == (0, 0) {
                cold.push((id, desired));
            } else if settled || {
                // A zoom in progress changes levels only where the texture is magnified, or
                // minified past any level a still settles at (sampled from one level, it shimmers):
                // within those, it waits for the zoom to settle, as on the web.
                let content = m.gpu.tile[2].max(m.gpu.tile[3]);
                projected > content || (desired.0 < m.size.0 && content > projected * MINIFIED)
            } {
                moves.push((id, desired));
            } else {
                self.stats.pending += 1;
            }
        }
        let mut chosen = forced;
        let must = chosen.len();
        let mut px = 0u64;
        for (id, size) in cold {
            let cost = u64::from(size.0) * u64::from(size.1);
            if chosen.len() - must >= COLD_COUNT || (px + cost > COLD_PIXELS && chosen.len() > must) {
                self.stats.pending += 1;
                continue;
            }
            px += cost;
            chosen.push((id, size));
        }
        let first = chosen.len();
        let (mut n, mut px) = (0, 0u64);
        // Promotions first, the blurriest first (the screen pixels a texture falls short by): a
        // large photo magnified shows it before a thumbnail does.
        let short = |id: u32| self.mat(id).map_or(0, |m| (m.want * px_per_world - m.gpu.tile[2].max(m.gpu.tile[3])) as i64);
        moves.sort_by_cached_key(|(id, size)| std::cmp::Reverse((i64::from(size.0) - self.mat(*id).map_or(0, |m| i64::from(m.size.0))).signum() * short(*id).max(1)));
        let (count, pixels) = if settled { (TRANSITION_COUNT, TRANSITION_PIXELS) } else { (ZOOM_COUNT, ZOOM_PIXELS) };
        for (id, size) in moves {
            let cost = u64::from(size.0) * u64::from(size.1);
            if n >= count || (px + cost > pixels && n > 0) {
                self.stats.pending += 1;
                continue;
            }
            n += 1;
            px += cost;
            chosen.push((id, size));
        }
        if chosen.is_empty() {
            return;
        }
        // A frame takes on at most `FRAME_BUDGET` of processing and `STAGE_BUDGET` of uploads: in
        // batches (sources are built and uploaded a batch at a time), the rest left for the next
        // frames. Always one batch, and what's forced.
        let started = std::time::Instant::now();
        let mut left = chosen.as_slice();
        // Media showing for the first time (a placeholder on screen) gets `FIRST_BUDGET`; LOD
        // changes, which only sharpen what shows, `FRAME_BUDGET`.
        let mut done = 0;
        let over = |done: usize| done >= must && started.elapsed() > if done < first { FIRST_BUDGET } else { FRAME_BUDGET };
        while !left.is_empty() {
            let (batch, rest) = left.split_at(left.len().min(BATCH));
            self.prepare_sources(device, queue, enc, batch);
            let rest_of_batch = self.build_tiles(device, enc, pipes, batch);
            // Processed a material at a time (several passes each): the budget holds between them.
            for (id, mut size) in rest_of_batch {
                let at = done + batch.iter().position(|b| b.0 == id).unwrap_or(0);
                if over(at) {
                    self.stats.pending += 1;
                    continue;
                }
                // Forced while its new size's source is still being built: processed at the size
                // it showed at, from the source that read, rather than left showing a stale part.
                if at < must
                    && let Some(m) = self.mat(id)
                    && matches!(m.key, MatKey::Image { .. })
                    && !self.sources.contains_key(&Self::source_key(m, size))
                {
                    let shown = (m.gpu.tile[2] as u32, m.gpu.tile[3] as u32);
                    if self.sources.contains_key(&Self::source_key(m, shown)) {
                        size = shown;
                    }
                }
                self.build(device, enc, pipes, id, size);
            }
            done += batch.len();
            left = rest;
            if over(done) || (done >= must && self.staging.frame_bytes > STAGE_BUDGET) {
                self.stats.pending += left.len();
                break;
            }
        }
    }

    /// Free what's past the budget: sources nothing processed lately, then textures of materials
    /// no one has seen for longest.
    fn evict(&mut self) {
        let frame = self.frame;
        // Sources only feed processing: an animated frame's goes once a frame passes without it,
        // a still's after a couple of seconds unused.
        self.sources.retain(|_, s| if s.animated { s.used == frame } else { frame - s.used < SOURCE_FRAMES });
        self.retired.extend(self.staged.drain().map(|(_, (b, _))| b));
        // Params hashes are kept by `Arc`: drop those no entity or material holds any more (a
        // slider drag makes a new one a frame).
        if frame.is_multiple_of(60) {
            self.hashes.retain(|_, (p, _)| Arc::strong_count(p) > 1);
        }
        // Textures of materials off screen are a warm cache, the least recently seen going first
        // past `UNSEEN_BUDGET`; what shows is never evicted.
        let tex_bytes = |t: &Tex| match t {
            Tex::Atlas(t) => t.bytes(),
            Tex::Own { bytes, .. } => *bytes,
            Tex::None => 0,
        };
        let mut unseen: Vec<(u64, u32, u64)> = self.mats.iter().enumerate().filter_map(|(i, m)| m.as_ref().filter(|m| m.seen != frame && !matches!(m.tex, Tex::None)).map(|m| (m.seen, i as u32, tex_bytes(&m.tex)))).collect();
        let mut cached: u64 = unseen.iter().map(|u| u.2).sum();
        if cached > UNSEEN_BUDGET {
            unseen.sort_unstable();
            for &(_, id, bytes) in &unseen {
                if cached <= UNSEEN_BUDGET {
                    break;
                }
                self.unload(id);
                cached -= bytes;
            }
        }
        let mut total = self.resident_bytes();
        if total <= BUDGET {
            return;
        }
        let mut old: Vec<(u64, SrcKey)> = self.sources.iter().filter(|(_, s)| s.used != frame).map(|(k, s)| (s.used, *k)).collect();
        old.sort_unstable();
        for (_, k) in old {
            if total <= BUDGET {
                break;
            }
            if let Some(s) = self.sources.remove(&k) {
                total -= texture_bytes(&s.tex);
            }
        }
        let mut unseen: Vec<(u64, u32)> = self.mats.iter().enumerate().filter_map(|(i, m)| m.as_ref().filter(|m| m.seen != frame && !matches!(m.tex, Tex::None)).map(|m| (m.seen, i as u32))).collect();
        unseen.sort_unstable();
        for (_, id) in unseen {
            if total <= BUDGET {
                break;
            }
            let Some(m) = self.mats[id as usize].as_mut() else { continue };
            match std::mem::replace(&mut m.tex, Tex::None) {
                Tex::Atlas(t) => {
                    total -= t.bytes();
                    self.atlas.free(t);
                }
                Tex::Own { bytes, .. } => total -= bytes,
                Tex::None => {}
            }
            m.size = (0, 0);
            m.gpu = GpuMat::default();
            self.mat_dirty.push(id);
        }
    }

    /// Free material `id`'s texture; it's processed again when it next shows.
    fn unload(&mut self, id: u32) {
        let Some(m) = self.mats.get_mut(id as usize).and_then(Option::as_mut) else { return };
        let old = std::mem::replace(&mut m.tex, Tex::None);
        m.size = (0, 0);
        m.gpu = GpuMat::default();
        self.drop_tex(old);
        self.mat_dirty.push(id);
    }

    fn resident_bytes(&self) -> u64 {
        let sources: u64 = self.sources.values().map(|s| texture_bytes(&s.tex)).sum();
        let own: u64 = self.mats.iter().flatten().map(|m| if let Tex::Own { bytes, .. } = m.tex { bytes } else { 0 }).sum();
        self.atlas.bytes() + sources + own
    }

    // ------------------------------------------------------------------ upload and draw

    fn upload(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder) {
        let inst_size = std::mem::size_of::<Inst>() as u64;
        let need = self.insts.len() as u64 * inst_size;
        let mut grew = false;
        if need > self.inst_buf.size() {
            self.inst_buf = storage_buffer(device, "voidmesh instances", (need * 3 / 2).next_power_of_two());
            self.dirty = (!self.insts.is_empty()).then_some((0, self.insts.len()));
            grew = true;
        }
        if let Some((a, b)) = self.dirty.take() {
            // Through a staging buffer and a GPU copy, as material changes: the frames in flight
            // still read this buffer, and a queue write into it would be staged by Rune (an
            // allocation a write, and the buffer pinned to that path for good).
            let bytes: &[u8] = bytemuck::cast_slice(&self.insts[a..b]);
            let r = self.staging.buffer(device, bytes.len() as u64, "voidmesh instance staging", self.frame);
            queue.write_buffer(&r, 0, bytes);
            enc.copy_buffer_to_buffer(&r, 0, &self.inst_buf, a as u64 * inst_size, bytes.len() as u64);
            self.stats.instance_bytes += (b - a) as u64 * inst_size;
            self.world_dirty = true;
        }
        let mat_size = std::mem::size_of::<GpuMat>() as u64;
        let need = self.mats.len() as u64 * mat_size;
        if need > self.mat_buf.size() {
            self.mat_buf = storage_buffer(device, "voidmesh materials", (need * 3 / 2).next_power_of_two());
            self.mat_dirty = (0..self.mats.len() as u32).collect();
            grew = true;
        }
        if !self.mat_dirty.is_empty() {
            self.mat_dirty.sort_unstable();
            self.mat_dirty.dedup();
            // Coalesced runs of changed entries, packed into one staging write, each copied into
            // place.
            let mut runs: Vec<(usize, usize)> = Vec::new();
            let mut i = 0;
            while i < self.mat_dirty.len() {
                let start = self.mat_dirty[i] as usize;
                let mut end = start + 1;
                while i + 1 < self.mat_dirty.len() && self.mat_dirty[i + 1] as usize <= end + 8 {
                    i += 1;
                    end = self.mat_dirty[i] as usize + 1;
                }
                runs.push((start, end.min(self.mats.len())));
                i += 1;
            }
            let mut bytes = std::mem::take(&mut self.staging_bytes);
            bytes.clear();
            for (a, b) in &runs {
                for m in &self.mats[*a..*b] {
                    bytes.extend_from_slice(bytemuck::bytes_of(&m.as_ref().map_or(GpuMat::default(), |m| m.gpu)));
                }
            }
            let r = self.staging.buffer(device, bytes.len() as u64, "voidmesh material staging", self.frame);
            queue.write_buffer(&r, 0, &bytes);
            self.staging_bytes = bytes;
            let mut at = 0;
            for (a, b) in runs {
                let len = (b - a) as u64 * mat_size;
                enc.copy_buffer_to_buffer(&r, at, &self.mat_buf, a as u64 * mat_size, len);
                at += len;
            }
            self.mat_dirty.clear();
            self.world_dirty = true;
        }
        if grew || self.bind.is_none() {
            self.bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("voidmesh world"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                    wgpu::BindGroupEntry { binding: 1, resource: self.inst_buf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: self.mat_buf.as_entire_binding() },
                ],
            }));
        }
        if self.atlas_gen != self.atlas.generation || self.atlas_bind.is_none() || grew {
            self.world_dirty = true;
        }
        if self.atlas_gen != self.atlas.generation || self.atlas_bind.is_none() {
            self.atlas_bind = Some(self.tex_bind(device, &self.atlas.view));
            self.atlas_gen = self.atlas.generation;
        }
    }

    /// Every pixel of `a` is opaque (videos are), from its proxy or its frame when that's as
    /// small: once an asset.
    fn asset_opaque(cache: &mut HashMap<u64, bool>, a: &Asset) -> bool {
        *cache.entry(a.id).or_insert_with(|| {
            if a.video.is_some() {
                return true;
            }
            if a.frames.len() != 1 {
                return false;
            }
            let px: &[u8] = match a.proxy() {
                Some(p) => &p.rgba,
                None if a.width.max(a.height) <= crate::media::PROXY_SIDE => &a.frames[0].rgba,
                None => return false,
            };
            px.as_chunks::<4>().0.iter().all(|c| c[3] == 255)
        })
    }

    /// The materials the camera is about to show: in the view extrapolated by its last move (at
    /// most a view's size), not visible yet. They're processed after the visible ones, so media
    /// arriving in a pan or zoom is ready when it shows rather than a frame or two after (its
    /// source is built off the frame).
    fn prefetch(&mut self, view: [f32; 4]) {
        self.ahead_mats.clear();
        let last = self.last_view.replace(view);
        let Some(last) = last else { return };
        let (w, h) = (view[2] - view[0], view[3] - view[1]);
        let d: [f32; 4] = std::array::from_fn(|i| (view[i] - last[i]).clamp(-w.max(h), w.max(h)));
        if d.iter().all(|v| *v == 0.0) {
            return;
        }
        // This view and the next together: what's in them and not visible is ahead.
        let next: [f32; 4] = std::array::from_fn(|i| view[i] + d[i]);
        let a = [view[0].min(next[0]), view[1].min(next[1]), view[2].max(next[2]), view[3].max(next[3])];
        let frame = self.frame;
        for (gi, g) in self.groups.iter().enumerate() {
            let b = g.bounds;
            if b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1] {
                continue;
            }
            // A few materials (shared media): marked at the group's largest side, as `visibility`
            // does, rather than an instance at a time.
            if g.mats.len() <= GROUP_MATS {
                for &(m, side) in &g.mats {
                    let Some(Some(mat)) = self.mats.get_mut(m as usize) else { continue };
                    if mat.seen == frame {
                        continue;
                    }
                    if mat.ahead != frame {
                        mat.ahead = frame;
                        mat.want = 0.0;
                        self.ahead_mats.push(m);
                    }
                    mat.want = mat.want.max(side);
                }
                continue;
            }
            for i in &self.insts[gi * GROUP..((gi + 1) * GROUP).min(self.insts.len())] {
                let r = i.rect;
                let (x1, y1) = (r[0] + r[2], r[1] + r[3]);
                if r[0] > a[2] || x1 < a[0] || r[1] > a[3] || y1 < a[1] {
                    continue;
                }
                let Some(Some(m)) = self.mats.get_mut(i.mat as usize) else { continue };
                if m.seen == frame {
                    continue;
                }
                if m.ahead != frame {
                    m.ahead = frame;
                    m.want = 0.0;
                    self.ahead_mats.push(i.mat);
                }
                m.want = m.want.max(r[2].max(r[3]));
            }
        }
    }

    /// For the one-pass materials visible this frame that are processed again every frame
    /// (flowing glass playing, a playing video), the part of each that shows: clipped to the view
    /// and shrunk by the opaque instances above it that cover a whole side, so a stack of
    /// overlapping entities processes what's seen of each rather than all of every one. An
    /// occluder is opaque media shown as it is or through an effect that keeps its alpha. A
    /// material that holds still isn't clipped: the next pan would show what it left out.
    fn occlusion(&mut self, view: [f32; 4], settled: bool) {
        self.clips.clear();
        let videos = &self.videos;
        let target = |m: &Material| {
            let moving = match m.key {
                MatKey::Video { entity, asset, .. } => videos.get(&(entity, asset)).is_some_and(|v| v.playing),
                MatKey::Image { .. } => m.params.animated(),
            };
            moving && process::one_pass(&m.params)
        };
        if !settled || !self.visible_mats.iter().any(|id| self.mat(*id).is_some_and(target)) {
            return;
        }
        let [vx0, vy0, vx1, vy1] = view;
        let mut vis: Vec<u32> = Vec::new();
        for (gi, g) in self.groups.iter().enumerate() {
            let b = g.bounds;
            if b[0] > vx1 || b[2] < vx0 || b[1] > vy1 || b[3] < vy0 {
                continue;
            }
            for slot in gi * GROUP..((gi + 1) * GROUP).min(self.insts.len()) {
                let r = self.insts[slot].rect;
                if !(r[0] > vx1 || r[0] + r[2] < vx0 || r[1] > vy1 || r[1] + r[3] < vy0) {
                    vis.push(slot as u32);
                }
            }
        }
        if vis.len() > OCCLUSION_INSTANCES {
            return;
        }
        let mut occluder = HashMap::new();
        for &slot in &vis {
            let i = &self.insts[slot as usize];
            let Some(m) = self.mats.get(i.mat as usize).and_then(Option::as_ref) else { continue };
            let opaque = i.progress == 0.0
                && (m.params.show_original || matches!(m.params.shader, crate::effects::Shader::Glass | crate::effects::Shader::Glitch))
                && Self::asset_opaque(&mut self.opaque_assets, &m.asset);
            occluder.insert(slot, opaque);
        }
        for (k, &slot) in vis.iter().enumerate() {
            let i = self.insts[slot as usize];
            if !self.mat(i.mat).is_some_and(target) {
                continue;
            }
            let r = i.rect;
            let mut v = [r[0].max(vx0), r[1].max(vy0), (r[0] + r[2]).min(vx1), (r[1] + r[3]).min(vy1)];
            for &o in &vis[k + 1..] {
                if v[0] >= v[2] || v[1] >= v[3] {
                    break;
                }
                if !occluder.get(&o).copied().unwrap_or(false) {
                    continue;
                }
                let q = self.insts[o as usize].rect;
                let q = [q[0], q[1], q[0] + q[2], q[1] + q[3]];
                if q[0] >= v[2] || q[2] <= v[0] || q[1] >= v[3] || q[3] <= v[1] {
                    continue;
                }
                let (full_x, full_y) = (q[0] <= v[0] && q[2] >= v[2], q[1] <= v[1] && q[3] >= v[3]);
                if full_x && full_y {
                    v[2] = v[0];
                } else if full_y && q[0] <= v[0] {
                    v[0] = q[2];
                } else if full_y && q[2] >= v[2] {
                    v[2] = q[0];
                } else if full_x && q[1] <= v[1] {
                    v[1] = q[3];
                } else if full_x && q[3] >= v[3] {
                    v[3] = q[1];
                }
            }
            let uv = if v[0] >= v[2] || v[1] >= v[3] {
                [0.0; 4]
            } else {
                [(v[0] - r[0]) / r[2], (v[1] - r[1]) / r[3], (v[2] - r[0]) / r[2], (v[3] - r[1]) / r[3]]
            };
            self.clips
                .entry(i.mat)
                .and_modify(|c| {
                    if uv[2] > uv[0] {
                        *c = if c[2] > c[0] { [c[0].min(uv[0]), c[1].min(uv[1]), c[2].max(uv[2]), c[3].max(uv[3])] } else { uv };
                    }
                })
                .or_insert(uv);
        }
    }

    /// What this frame draws of the visible materials that it shouldn't (`Stats::stale`, `soft`,
    /// `minified`).
    fn fidelity(&mut self, px_per_world: f32) {
        let (mut stale, mut soft, mut minified) = (0, 0, 0);
        for &id in &self.visible_mats {
            let Some(m) = self.mat(id) else { continue };
            if matches!(m.tex, Tex::None) {
                continue;
            }
            if !holds(m.region, self.clips.get(&id).copied().unwrap_or(FULL)) {
                stale += 1;
            }
            let content = m.gpu.tile[2].max(m.gpu.tile[3]);
            let native = process::render_size(m.asset.width, m.asset.height);
            let projected = m.want * px_per_world;
            if content < native.0.max(native.1) as f32 && projected > content * SOFT {
                soft += 1;
            }
            // Past the smallest tier: a speck's tier is larger than it shows by design.
            if content > process::LOD_TIERS[0] as f32 && content > projected * MINIFIED {
                minified += 1;
            }
        }
        self.stats.stale = stale;
        self.stats.soft = soft;
        self.stats.minified = minified;
    }

    /// Instances whose material draws from its own texture, visible this frame, in z order.
    fn collect_own(&mut self, view: [f32; 4]) {
        self.own_draws.clear();
        let own = |m: u32, mats: &[Option<Material>]| mats.get(m as usize).and_then(Option::as_ref).is_some_and(|m| m.gpu.state == 2);
        if !self.visible_mats.iter().any(|m| own(*m, &self.mats)) {
            return;
        }
        let [vx0, vy0, vx1, vy1] = view;
        for (gi, g) in self.groups.iter().enumerate() {
            let b = g.bounds;
            if b[0] > vx1 || b[2] < vx0 || b[1] > vy1 || b[3] < vy0 || !g.mats.iter().any(|(m, _)| own(*m, &self.mats)) {
                continue;
            }
            for slot in gi * GROUP..((gi + 1) * GROUP).min(self.insts.len()) {
                let i = &self.insts[slot];
                let r = i.rect;
                if own(i.mat, &self.mats) && !(r[0] > vx1 || r[0] + r[2] < vx0 || r[1] > vy1 || r[1] + r[3] < vy0) {
                    self.own_draws.push(slot as u32);
                }
            }
        }
    }

    /// Bring the GPU's view of the canvas up to date for this frame.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, s: &mut App, dpr: f32) {
        self.stats = Stats { rebuilt: false, ..Stats::default() };
        self.staging.begin(queue, self.frame);
        // Copies from these were recorded on the last frame, submitted before this one prepares.
        let retired = std::mem::take(&mut self.retired);
        if !retired.is_empty() {
            let pool = self.level_pool.clone();
            queue.on_submitted_work_done(move || pool_levels(&pool, retired));
        }
        let mut t = Trace::start();
        self.sync(s);
        t.lap("sync");
        self.update_videos(device, queue, enc, s, dpr);
        t.lap("videos");
        self.refresh_groups();
        t.lap("groups");
        let [_, _, cw, ch] = s.canvas;
        let a = s.cam.world([0.0, 0.0]);
        let b = s.cam.world([cw, ch]);
        let mut view = [a[0], a[1], b[0], b[1]];
        // A dragged selection shows what lies off by the drag too.
        if let Some([dx, dy]) = s.drag_offset() {
            view = [view[0].min(view[0] - dx), view[1].min(view[1] - dy), view[2].max(view[2] - dx), view[3].max(view[3] - dy)];
        }
        if s.cam.scale == self.last_scale {
            self.still = self.still.saturating_add(1);
        } else {
            self.still = 0;
            self.last_scale = s.cam.scale;
        }
        self.visibility(view);
        self.prefetch(view);
        self.occlusion(view, s.drag_offset().is_none());
        t.lap("visibility");
        self.schedule(device, queue, enc, pipes, s.cam.scale * dpr);
        t.lap("process");
        self.evict();
        if self.atlas.trim(device, enc) {
            self.world_dirty = true;
        }
        self.upload(device, queue, enc);
        t.lap("upload");
        self.collect_own(view);
        self.scratch.sweep();
        // What wasn't reused in two frames goes.
        self.pool_prev = std::mem::take(&mut self.pool);
        self.stats.materials = self.mat_index.len();
        self.stats.resident_bytes = self.resident_bytes() + self.scratch.bytes() + self.inst_buf.size() + self.mat_buf.size();
        self.stats.video_bytes = self.videos.values().filter_map(|v| v.tex.as_ref()).map(|(t, _)| texture_bytes(t)).sum::<u64>()
            + s.video_frames.values().filter_map(|f| f.gpu.as_ref()).map(|g| g.buf.size()).sum::<u64>()
            + crate::video::gpu_pool_bytes();
        self.stats.unready = self.visible_mats.iter().filter(|id| self.mat(**id).is_some_and(|m| matches!(m.tex, Tex::None))).count();
        self.fidelity(s.cam.scale * dpr);
        self.stats.staging_bytes = self.staging.bytes()
            + self.building.values().sum::<u64>()
            + self.built.values().map(|(_, p)| p.buf.size()).sum::<u64>()
            + self.level_pool.lock().map_or(0, |p| p.iter().map(wgpu::Buffer::size).sum::<u64>());
        t.lap("rest");
        t.finish(&self.stats);
        if t.on {
            let sources: u64 = self.sources.values().map(|s| texture_bytes(&s.tex)).sum();
            let own: u64 = self.mats.iter().flatten().map(|m| if let Tex::Own { bytes, .. } = m.tex { bytes } else { 0 }).sum();
            let mb = |b: u64| b / 1_048_576;
            eprintln!(
                "memory: atlas {} MB ({} layers, {} MB used), sources {} MB ({}), own {} MB, scratch {} MB, buffers {} MB",
                mb(self.atlas.bytes()),
                self.atlas.layers,
                mb(self.atlas.used_bytes),
                mb(sources),
                self.sources.len(),
                mb(own),
                mb(self.scratch.bytes()),
                mb(self.inst_buf.size() + self.mat_buf.size())
            );
        }
        self.frame += 1;
    }

    /// The world texture for the canvas, `size` device pixels at `dpr` per point under the
    /// camera: drawn again only when something in it or the camera changed, so a frame where
    /// only the UI moves composites it as it is.
    /// `background` draws first into the same pass (the grid, which moves with the camera too).
    #[allow(clippy::too_many_arguments)]
    pub fn world(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, s: &App, size: (u32, u32), dpr: f32, dark: bool, background: &mut dyn FnMut(&mut wgpu::RenderPass<'_>)) -> Option<&wgpu::TextureView> {
        let size = (size.0.max(1), size.1.max(1));
        let key = WorldKey { pan: s.cam.pan, scale: s.cam.scale, dpr, size, dark, marquee: marquee(s), drag: s.drag_offset() };
        if self.world.as_ref().is_none_or(|(t, _)| (t.width(), t.height()) != size) {
            let t = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("voidmesh world"),
                size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: WORLD_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let v = t.create_view(&Default::default());
            self.world = Some((t, v));
            self.world_gen += 1;
            self.world_dirty = true;
        }
        if self.world_dirty || self.world_for != Some(key) {
            self.ensure_pipeline(device, WORLD_FORMAT);
            let (w, h) = (size.0 as f32, size.1 as f32);
            let world = World {
                view: [w, h, 0.0, 0.0],
                clip: [0.0, 0.0, w, h],
                fade: [0; 4],
                cam: [s.cam.pan[0] * dpr, s.cam.pan[1] * dpr, s.cam.scale * dpr, super::RING_PT * dpr],
                // Blended in the sRGB encoding the processed textures hold; the composite
                // converts for the frame.
                misc: [1.0, 0.0, dpr, key.marquee.1 as f32],
                tex: [0.0; 4],
                marquee: key.marquee.0,
                drag: key.drag.map_or([0.0; 4], |o| [o[0], o[1], 1.0, 0.0]),
            };
            let view = &self.world.as_ref()?.1;
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("voidmesh world"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
                ..Default::default()
            });
            background(&mut pass);
            self.stats.draws = self.draw(&mut pass, WORLD_FORMAT, world);
            drop(pass);
            self.world_dirty = false;
            self.world_for = Some(key);
            self.stats.redrawn = true;
        }
        self.world.as_ref().map(|(_, v)| v)
    }

    pub fn world_view(&self) -> Option<&wgpu::TextureView> {
        self.world.as_ref().map(|(_, v)| v)
    }

    /// Process everything again from fresh sources (benchmarks' forced reprocessing).
    pub fn invalidate(&mut self) {
        for (id, m) in self.mats.iter_mut().enumerate() {
            let Some(m) = m else { continue };
            if let Tex::Atlas(t) = std::mem::replace(&mut m.tex, Tex::None) {
                self.atlas.free(t);
            }
            m.size = (0, 0);
            m.gpu = GpuMat::default();
            self.mat_dirty.push(id as u32);
        }
        self.sources.clear();
    }

    /// Every playing video has the frame due now decoded (or failed).
    pub fn videos_ready(&self, s: &App) -> bool {
        self.videos.iter().all(|((id, _), v)| s.entity(*id).is_none_or(|e| !e.playing || v.decoder.ready(e.play_t)))
    }

    /// Source levels queued with the workers: none left to finish.
    pub fn sources_idle(&mut self) -> bool {
        while let Ok((key, prepared)) = self.built_rx.try_recv() {
            self.building.remove(&key);
            if let Some(p) = prepared {
                self.built.insert(key, (self.frame, p));
            }
        }
        self.building.is_empty()
    }

    /// True while there's processing left that later frames will do.
    pub fn pending(&self) -> bool {
        self.stats.pending > 0 || !self.building.is_empty() || !self.built.is_empty()
    }

    /// Draw every entity into `pass`.
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>, format: wgpu::TextureFormat, world: World) -> usize {
        let (Some(pipe), Some(bind), Some(atlas)) = (self.pipelines.get(&format), self.bind.as_ref(), self.atlas_bind.as_ref()) else { return 0 };
        let n = self.insts.len() as u32;
        if n == 0 {
            return 0;
        }
        pass.set_pipeline(pipe);
        pass.set_bind_group(0, Some(bind), &[]);
        let mut draws = 0;
        let mut atlas_world = world;
        atlas_world.misc[1] = 0.0;
        atlas_world.tex = [1.0 / atlas::SIDE as f32, 1.0 / atlas::SIDE as f32, 0.0, 0.0];
        let mut own_world = world;
        own_world.misc[1] = 1.0;
        let mut bound_atlas = false;
        let atlas_draw = |pass: &mut wgpu::RenderPass<'_>, bound: &mut bool, a: u32, b: u32| {
            if !*bound {
                pass.set_bind_group(1, Some(atlas), &[]);
                pass.set_immediates(0, bytemuck::bytes_of(&atlas_world));
                *bound = true;
            }
            pass.draw(0..4, a..b);
        };
        let mut own = self.own_draws.iter().copied().peekable();
        for &(a, b) in &self.ranges {
            let mut start = a;
            while let Some(&slot) = own.peek() {
                if slot >= b {
                    break;
                }
                own.next();
                if slot < start {
                    continue;
                }
                if slot > start {
                    atlas_draw(pass, &mut bound_atlas, start, slot);
                    draws += 1;
                }
                if let Some(Tex::Own { bind: tex, .. }) = self.insts.get(slot as usize).and_then(|i| self.mat(i.mat)).map(|m| &m.tex) {
                    pass.set_bind_group(1, Some(tex), &[]);
                    pass.set_immediates(0, bytemuck::bytes_of(&own_world));
                    bound_atlas = false;
                    pass.draw(0..4, slot..slot + 1);
                    draws += 1;
                }
                start = slot + 1;
            }
            if start < b {
                atlas_draw(pass, &mut bound_atlas, start, b);
                draws += 1;
            }
        }
        draws
    }

    /// Process `e` by itself at `size`, or its native size (deletion dust's last image, an
    /// export's full-resolution result), from its source.
    #[allow(clippy::too_many_arguments)]
    pub fn render(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, e: &Entity, size: Option<(u32, u32)>) -> Option<process::Processed> {
        let media = (e.asset.width, e.asset.height);
        let size = size.unwrap_or_else(|| process::render_size(media.0, media.1));
        let out = process::Processed::new(device, size);
        if e.asset.video_path().is_some() {
            let (t, v) = self.videos.get(&(e.id, e.asset.id)).and_then(|v| v.tex.as_ref())?;
            let input = Input { texture: t, view: v, size: (t.width(), t.height()), levels: 1, media };
            process::run(device, enc, pipes, &mut self.scratch, &input, &e.params, e.fx_t as f32, &out.out, None);
        } else {
            let frame = e.asset.frame_at(e.play_t);
            let key = (e.asset.id, frame as u32, 0);
            if !self.sources.contains_key(&key) {
                let f = e.asset.frames.get(frame)?;
                let tex = process::upload_gpu_mips(device, queue, enc, pipes, e.asset.width, e.asset.height, &f.rgba);
                let view = tex.create_view(&Default::default());
                self.sources.insert(key, Source { levels: tex.mip_level_count(), tex, view, size: media, used: self.frame, animated: e.asset.animated() });
            }
            let src = self.sources.get(&key)?;
            let input = Input { texture: &src.tex, view: &src.view, size: src.size, levels: src.levels, media };
            process::run(device, enc, pipes, &mut self.scratch, &input, &e.params, e.fx_t as f32, &out.out, None);
        }
        Some(out)
    }

    /// The preview size `e` shows at under the camera now, at most an atlas tile.
    pub fn shown_size(s: &App, e: &Entity, dpr: f32) -> (u32, u32) {
        let projected = e.size[0].max(e.size[1]) * s.cam.scale * dpr;
        let (w, h) = process::lod_size((e.asset.width, e.asset.height), projected);
        let k = (atlas::MAX_TILE as f32 / w.max(h) as f32).min(1.0);
        (((w as f32 * k) as u32).max(1), ((h as f32 * k) as u32).max(1))
    }
}
