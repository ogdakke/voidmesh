//! Processing: source → adjustments → blur → effect → bloom → post, into a texture at a preview
//! LOD (`lod_size`) or, for export, the native resolution. The canvas (`scene.rs`) runs it once
//! per material (asset, frame and params), whatever number of entities show it, and only when
//! those inputs change; pan and zoom just redraw the cached result.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use std::sync::Arc;

use bytemuck::{Pod, Zeroable};

use crate::effects::{self, DotShape, Params, Shader};

/// Intermediate and processed textures hold sRGB-encoded values, as the web app's canvases do.
pub const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Longest side the pipeline renders at: the GPU's own texture limit (Rune's Metal device and
/// Apple GPUs allow 16384). Media renders at its native size up to that.
pub const MAX_SIDE: u32 = 16384;
const SLOT: u64 = 512;
const BLOOM_LEVELS: u32 = 5;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Uniforms {
    res: [f32; 2],
    scale: f32,
    intensity: f32,
    cell: f32,
    shape: u32,
    preserve: u32,
    kind: u32,
    pcount: u32,
    effect: u32,
    flags: u32,
    time: f32,
    x: [f32; 4],
    y: [f32; 4],
    adj: [f32; 4],
    post: [f32; 4],
    blur: [f32; 4],
    /// Flowing glass's per-frame constants: each turbulence octave's phase (8), then the wave
    /// field's two drifts. The same for every pixel, so worked out once here, not per pixel.
    flow: [[f32; 4]; 3],
    /// This pass's output region in its target (xy), a mip pass's source region (zw).
    origin: [f32; 4],
    palette: [[f32; 4]; 16],
}

const UNIFORM_SIZE: u64 = std::mem::size_of::<Uniforms>() as u64;
const _: () = assert!(UNIFORM_SIZE == 448 && UNIFORM_SIZE <= SLOT);

/// Pipelines and shared bindings for every entity's processing.
pub struct Pipes {
    pub layout: wgpu::BindGroupLayout,
    adjust: wgpu::RenderPipeline,
    down: wgpu::RenderPipeline,
    up: wgpu::RenderPipeline,
    bright: wgpu::RenderPipeline,
    /// Per effect, made on first use (`Pipes::effect`).
    effects: Arc<Specialized>,
    /// Every effect in one shader, reading which from the uniforms: what runs while an effect's
    /// own pipeline compiles in the background.
    general: wgpu::RenderPipeline,
    device: wgpu::Device,
    pipeline_layout: wgpu::PipelineLayout,
    post: wgpu::RenderPipeline,
    mip: wgpu::RenderPipeline,
    pub sampler: wgpu::Sampler,
    /// A 1×1 texture standing in for scratch a run doesn't use.
    blank: wgpu::Texture,
    atlas: wgpu::TextureView,
    dummy: wgpu::TextureView,
}

impl Pipes {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Pipes {
        let module = trusted_module(device, "voidmesh process", process_source(None));
        let tex_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("voidmesh process"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(UNIFORM_SIZE) },
                    count: None,
                },
                tex_entry(1),
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                tex_entry(3),
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipe = |entry: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_full"), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(entry), compilation_options: Default::default(), targets: &[Some(FORMAT.into())] }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("voidmesh linear"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let atlas = {
            let img = image::load_from_memory(include_bytes!("../../assets/ascii-atlas.png")).map(|i| i.to_rgba8());
            let (w, h, px) = match img {
                Ok(i) => (i.width(), i.height(), i.into_raw()),
                Err(_) => (1, 1, vec![0; 4]),
            };
            upload(device, queue, w, h, &px).create_view(&Default::default())
        };
        let blank = target(device, 1, 1, "voidmesh blank");
        let dummy = upload(device, queue, 1, 1, &[0, 0, 0, 0]).create_view(&Default::default());
        Pipes {
            layout,
            adjust: pipe("fs_adjust"),
            down: pipe("fs_down"),
            up: pipe("fs_up"),
            bright: pipe("fs_bright"),
            effects: Arc::new(Specialized { ready: std::array::from_fn(|_| std::sync::OnceLock::new()), asked: std::array::from_fn(|_| std::sync::atomic::AtomicBool::new(false)) }),
            general: pipe("fs_effect"),
            post: pipe("fs_post"),
            mip: pipe("fs_mip"),
            sampler,
            blank,
            atlas,
            dummy,
            device: device.clone(),
            pipeline_layout: pl.clone(),
        }
    }

    /// The effect pass for effect `id` (`Shader::gpu_id`) and its sub-kind (dither pattern,
    /// glass, glitch, ASCII set): a pipeline compiled for that pair alone. One shader holding
    /// every effect pays the heaviest one's register use in all of them; this way flowing glass
    /// doesn't carry frosted glass's Voronoi, as the web's per-effect pipelines don't.
    ///
    /// Compiling one takes tens of milliseconds, so it happens on a worker the first time it's
    /// asked for, and the general pipeline (same output, every effect in one) runs meanwhile:
    /// the alternative is a frame stalled on the compiler mid-gesture.
    pub fn effect(&self, id: u32, kind: u32) -> &wgpu::RenderPipeline {
        let i = (id as usize).min(EFFECTS - 1) * KINDS + (kind as usize).min(KINDS - 1);
        if let Some(p) = self.effects.ready[i].get() {
            return p;
        }
        if !self.effects.asked[i].swap(true, std::sync::atomic::Ordering::Relaxed) {
            let (device, layout, specialized) = (self.device.clone(), self.pipeline_layout.clone(), self.effects.clone());
            let (e, k) = ((i / KINDS) as u32, (i % KINDS) as u32);
            let spawned = std::thread::Builder::new().name("voidmesh-shader".into()).spawn(move || {
                let module = trusted_module(&device, "voidmesh effect", process_source(Some((e, k))));
                let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("fs_effect"),
                    layout: Some(&layout),
                    vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_full"), compilation_options: Default::default(), buffers: &[] },
                    fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_effect"), compilation_options: Default::default(), targets: &[Some(FORMAT.into())] }),
                    primitive: Default::default(),
                    depth_stencil: None,
                    multisample: Default::default(),
                    multiview_mask: None,
                    cache: None,
                });
                let _ = specialized.ready[e as usize * KINDS + k as usize].set(pipeline);
            });
            if spawned.is_err() {
                self.effects.asked[i].store(false, std::sync::atomic::Ordering::Relaxed);
            }
        }
        &self.general
    }
}

/// Specialized effect pipelines, by effect and sub-kind, as they finish compiling.
pub struct Specialized {
    ready: [std::sync::OnceLock<wgpu::RenderPipeline>; EFFECTS * KINDS],
    asked: [std::sync::atomic::AtomicBool; EFFECTS * KINDS],
}

/// A module from this app's own WGSL, compiled without runtime checks: no index clamps and no
/// loop counters, so the compiler can unroll the effects' fixed loops (flowing glass's eight
/// octaves) as it would native code. A browser can't opt out of these.
pub fn trusted_module(device: &wgpu::Device, label: &str, source: String) -> wgpu::ShaderModule {
    // SAFETY: the shaders are this crate's own, built in: their loops are bounded by constants,
    // and every array they index is indexed in range (palette entries below `pcount`, at most
    // sixteen; glyphs inside the atlas; kernel taps by their fixed counts).
    unsafe { device.create_shader_module_trusted(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(source.into()) }, wgpu::ShaderRuntimeChecks::unchecked()) }
}

/// Effects `fs_effect` switches between (`Shader::gpu_id`, 0 the original), and sub-kinds
/// (`Params::dither_kind` has the most).
const EFFECTS: usize = 8;
const KINDS: usize = 12;

/// `process.wgsl` with its effect and sub-kind fixed, or both read from the uniforms.
fn process_source(fixed: Option<(u32, u32)>) -> String {
    let src = include_str!("../shaders/process.wgsl");
    match fixed {
        Some((e, k)) => format!("const EFFECT_ID: u32 = {e}u;\nconst KIND_ID: u32 = {k}u;\n{}", src.replace("u.kind", "KIND_ID")),
        None => src.replace("switch (EFFECT_ID)", "switch (u.effect)"),
    }
}

/// A sampled RGBA8 texture (sRGB-encoded values, straight alpha), with `levels` mips from
/// `mips_rgba` when asked for more than one.
pub fn upload_mips(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, levels: &[Vec<u8>], base: &[u8]) -> wgpu::Texture {
    let t = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("voidmesh source"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1 + levels.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    write(queue, &t, w, h, base);
    for (i, px) in levels.iter().enumerate() {
        let level = i as u32 + 1;
        let (lw, lh) = ((w >> level).max(1), (h >> level).max(1));
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &t, mip_level: level, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            px,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(lw * 4), rows_per_image: Some(lh) },
            wgpu::Extent3d { width: lw, height: lh, depth_or_array_layers: 1 },
        );
    }
    t
}

/// A mipmapped source from its base level alone, its chain made by `fs_mip` passes on the GPU:
/// for large media, where a few passes beat a CPU pass over millions of pixels.
#[allow(clippy::too_many_arguments)]
pub fn upload_gpu_mips(device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, arena: &mut Arena, w: u32, h: u32, rgba: &[u8]) -> wgpu::Texture {
    let t = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("voidmesh source"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: levels_for(w, h),
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    write(queue, &t, w, h, rgba);
    mip_chain(device, enc, pipes, arena, &t);
    t
}

/// Levels 1… of `t`, each a box filter of the one above.
pub fn mip_chain(device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, arena: &mut Arena, t: &wgpu::Texture) {
    let mip_view = |level: u32| t.create_view(&wgpu::TextureViewDescriptor { base_mip_level: level, mip_level_count: Some(1), ..Default::default() });
    let (w, h) = (t.width(), t.height());
    for level in 1..t.mip_level_count() {
        let mut u = Uniforms::zeroed();
        u.res = [(w >> level).max(1) as f32, (h >> level).max(1) as f32];
        let (buffer, offset) = arena.slot(device, &u);
        let src = mip_view(level - 1);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipes.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &buffer, offset: 0, size: wgpu::BufferSize::new(UNIFORM_SIZE) }) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&pipes.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&pipes.dummy) },
            ],
        });
        let view = mip_view(level);
        let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("voidmesh mips"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
            ..Default::default()
        });
        rp.set_pipeline(&pipes.mip);
        rp.set_bind_group(0, Some(&bind), &[offset]);
        rp.draw(0..3, 0..1);
    }
}

/// An empty sampled RGBA8 texture, one level, written later (`write_via`).
pub fn texture(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("voidmesh frame"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

/// A texture made from RGBA8 pixels (sRGB-encoded values, sampled as is), one level.
pub fn upload(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, rgba: &[u8]) -> wgpu::Texture {
    upload_mips(device, queue, w, h, &[], rgba)
}

/// One RGBA8 pixel spread into four 16-bit lanes, so four pixels sum in one add (SWAR).
#[inline(always)]
fn spread(v: u32) -> u64 {
    let v = u64::from(v);
    (v & 0xFF) | ((v & 0xFF00) << 8) | ((v & 0xFF_0000) << 16) | ((v & 0xFF00_0000) << 24)
}

#[inline(always)]
fn pack(v: u64) -> u32 {
    (v & 0xFF) as u32 | ((v >> 8) & 0xFF00) as u32 | ((v >> 16) & 0xFF_0000) as u32 | ((v >> 24) & 0xFF00_0000) as u32
}

/// `src` (`pw`×`ph` RGBA8) halved: each pixel the rounded mean of its 2×2 block (edge pixels
/// repeat on odd sizes), as the GPU's `fs_mip` filters.
pub fn half_rgba(pw: usize, ph: usize, src: &[u8]) -> (usize, usize, Vec<u8>) {
    let (nw, nh) = ((pw / 2).max(1), (ph / 2).max(1));
    let mut dst = vec![0u8; nw * nh * 4];
    let sy = usize::from(ph > 1);
    for (y, out) in dst.chunks_exact_mut(nw * 4).enumerate() {
        let r0 = &src[(y * 2) * pw * 4..][..pw * 4];
        let r1 = &src[(y * 2 + sy).min(ph - 1) * pw * 4..][..pw * 4];
        half_row(r0, r1, pw, out);
    }
    (nw, nh, dst)
}

/// One output row from two input rows of `pw` pixels: four pixels a step with NEON.
#[cfg(target_arch = "aarch64")]
fn half_row(r0: &[u8], r1: &[u8], pw: usize, out: &mut [u8]) {
    use std::arch::aarch64::*;
    // Whole 2×2 blocks, eight input pixels a row per step.
    let steps = if pw > 1 { pw / 8 } else { 0 };
    for i in 0..steps {
        // SAFETY: step `i` reads input pixels 8i..8i+8 of rows holding `pw` ≥ 8(i+1) pixels and
        // writes output pixels 4i..4i+4 of a row holding `pw / 2` of them; NEON is part of every
        // aarch64 target.
        unsafe {
            let a = vld2q_u32(r0.as_ptr().add(i * 32).cast());
            let b = vld2q_u32(r1.as_ptr().add(i * 32).cast());
            let (a0, a1, b0, b1) = (vreinterpretq_u8_u32(a.0), vreinterpretq_u8_u32(a.1), vreinterpretq_u8_u32(b.0), vreinterpretq_u8_u32(b.1));
            let lo = vaddq_u16(vaddl_u8(vget_low_u8(a0), vget_low_u8(a1)), vaddl_u8(vget_low_u8(b0), vget_low_u8(b1)));
            let hi = vaddq_u16(vaddl_u8(vget_high_u8(a0), vget_high_u8(a1)), vaddl_u8(vget_high_u8(b0), vget_high_u8(b1)));
            // A rounding narrowing shift: (sum + 2) >> 2, as the scalar path.
            vst1q_u8(out.as_mut_ptr().add(i * 16), vcombine_u8(vrshrn_n_u16::<2>(lo), vrshrn_n_u16::<2>(hi)));
        }
    }
    half_row_scalar(r0, r1, pw, out, steps * 4);
}

#[cfg(not(target_arch = "aarch64"))]
fn half_row(r0: &[u8], r1: &[u8], pw: usize, out: &mut [u8]) {
    half_row_scalar(r0, r1, pw, out, 0);
}

/// Output pixels from `from` on, a pixel at a time with the channels as 16-bit lanes of a `u64`.
fn half_row_scalar(r0: &[u8], r1: &[u8], pw: usize, out: &mut [u8], from: usize) {
    let px = |row: &[u8], x: usize| u32::from_le_bytes([row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]]);
    let sx = usize::from(pw > 1);
    for (x, o) in out.as_chunks_mut::<4>().0.iter_mut().enumerate().skip(from) {
        let (a, b) = (x * 2, x * 2 + sx);
        let sum = spread(px(r0, a)) + spread(px(r0, b)) + spread(px(r1, a)) + spread(px(r1, b)) + 0x0002_0002_0002_0002;
        *o = pack((sum >> 2) & 0x00FF_00FF_00FF_00FF).to_le_bytes();
    }
}

/// The mip chain below `rgba` (`w`×`h`), each level a 2×2 box of the one above, as the GPU's
/// `fs_mip` makes them: the reference `level_chain` is checked against.
#[cfg(test)]
pub fn mips_rgba(w: u32, h: u32, rgba: &[u8]) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = Vec::new();
    let (mut pw, mut ph) = (w as usize, h as usize);
    while pw > 1 || ph > 1 {
        let src: &[u8] = out.last().map_or(rgba, |v| v.as_slice());
        let (nw, nh, dst) = half_rgba(pw, ph, src);
        out.push(dst);
        (pw, ph) = (nw, nh);
    }
    out
}

/// Level `k` of `rgba` (`w`×`h`) and the levels below it, `levels` in all: a source prepared at
/// the size its preview needs rather than its full resolution.
pub fn level_chain(w: u32, h: u32, rgba: &[u8], k: u32, levels: u32) -> Vec<(u32, u32, Vec<u8>)> {
    let mut out: Vec<(u32, u32, Vec<u8>)> = Vec::with_capacity(levels as usize);
    let (mut pw, mut ph) = (w as usize, h as usize);
    let mut cur: Option<Vec<u8>> = None;
    for level in 0..k + levels {
        if level > 0 {
            let (nw, nh, dst) = half_rgba(pw, ph, cur.as_deref().unwrap_or(rgba));
            (pw, ph) = (nw, nh);
            cur = Some(dst);
        }
        if level >= k {
            out.push((pw as u32, ph as u32, cur.clone().unwrap_or_else(|| rgba.to_vec())));
        }
        if pw == 1 && ph == 1 && level >= k {
            break;
        }
    }
    out
}

/// The calling thread at the frame's own priority: a frame waits for every helper it starts, so
/// none may sit on an efficiency core behind the video decoders.
#[cfg(target_os = "macos")]
fn interactive() {
    const QOS_CLASS_USER_INTERACTIVE: u32 = 0x21;
    unsafe extern "C" {
        fn pthread_set_qos_class_self_np(qos: u32, relative: i32) -> i32;
    }
    // SAFETY: sets only the calling thread's scheduling class; it fails harmlessly if refused.
    unsafe {
        pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
    }
}

#[cfg(not(target_os = "macos"))]
fn interactive() {}

/// Run `f` over `jobs` on every core when there's enough work to pay for the threads.
pub fn parallel<T: Sync, R: Send + Default>(jobs: &[T], work: impl Fn(&T) -> u64 + Sync, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let total: u64 = jobs.iter().map(&work).sum();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(jobs.len()).max(1);
    if threads == 1 || total < 512 * 1024 {
        return jobs.iter().map(&f).collect();
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let slots: Vec<std::sync::Mutex<R>> = jobs.iter().map(|_| Default::default()).collect();
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                interactive();
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(job) = jobs.get(i) else { return };
                let r = f(job);
                if let Ok(mut s) = slots[i].lock() {
                    *s = r;
                }
            });
        }
    });
    slots.into_iter().map(|s| s.into_inner().unwrap_or_default()).collect()
}

pub fn write(queue: &wgpu::Queue, t: &wgpu::Texture, w: u32, h: u32, rgba: &[u8]) {
    queue.write_texture(
        t.as_image_copy(),
        rgba,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
}

/// `write` through a persistent buffer, for pixels that change every frame (video): Rune's
/// queue writes a buffer the GPU isn't reading in place, where a texture write stages a new
/// buffer each time. Rows are padded to the copy alignment when they need it.
#[allow(clippy::too_many_arguments)]
pub fn write_via(device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, staging: &mut Option<wgpu::Buffer>, t: &wgpu::Texture, w: u32, h: u32, rgba: &[u8]) {
    let row = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let size = u64::from(row) * u64::from(h);
    if staging.as_ref().is_none_or(|b| b.size() != size) {
        *staging = Some(device.create_buffer(&wgpu::BufferDescriptor { label: Some("voidmesh video"), size, usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
    }
    let Some(buf) = staging.as_ref() else { return };
    if row == w * 4 {
        queue.write_buffer(buf, 0, rgba);
    } else {
        let mut padded = vec![0u8; size as usize];
        for (dst, src) in padded.chunks_exact_mut(row as usize).zip(rgba.chunks_exact((w * 4) as usize)) {
            dst[..src.len()].copy_from_slice(src);
        }
        queue.write_buffer(buf, 0, &padded);
    }
    enc.copy_buffer_to_texture(
        wgpu::TexelCopyBufferInfo { buffer: buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
        t.as_image_copy(),
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
}

fn target(device: &wgpu::Device, w: u32, h: u32, label: &str) -> wgpu::Texture {
    target_mips(device, w, h, 1, label)
}

pub fn target_mips(device: &wgpu::Device, w: u32, h: u32, mips: u32, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
        mip_level_count: mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

/// Mip levels a preview texture keeps: one, as the web's. LOD tiers hold it within about 2.5×
/// of its size on screen, and the next tier replaces it past that.
pub const PREVIEW_LEVELS: u32 = 1;

pub fn levels_for(w: u32, h: u32) -> u32 {
    32 - w.max(h).max(1).leading_zeros()
}

/// Output size for media of `w`×`h`: native, or scaled so the longest side fits `MAX_SIDE`.
pub fn render_size(w: u32, h: u32) -> (u32, u32) {
    let m = w.max(h);
    if m <= MAX_SIDE {
        return (w.max(1), h.max(1));
    }
    let k = MAX_SIDE as f32 / m as f32;
    (((w as f32 * k).round() as u32).max(1), ((h as f32 * k).round() as u32).max(1))
}

/// Quantized maximum dimensions for preview LOD: the web's `imageLodTiers`, and two smaller ones
/// for overviews, where an entity a few pixels across needn't hold a 64-pixel texture.
pub const LOD_TIERS: [u32; 9] = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
/// Extra physical pixels kept around the projected size before promotion (`imageLodOverscan`).
pub const LOD_OVERSCAN: f32 = 1.25;

/// The size to process media of `media` at, for its longest side projecting to `projected`
/// device pixels: a quantized tier, or the native size once the projection reaches it (the web's
/// `getEntityRenderSize`).
pub fn lod_size(media: (u32, u32), projected: f32) -> (u32, u32) {
    let native = render_size(media.0, media.1);
    let max = native.0.max(native.1);
    let projected = projected * LOD_OVERSCAN;
    if projected >= max as f32 {
        return native;
    }
    let tier = LOD_TIERS.iter().copied().find(|t| *t as f32 >= projected).unwrap_or(max).min(max);
    let k = tier as f32 / max as f32;
    (((native.0 as f32 * k).round() as u32).max(1), ((native.1 as f32 * k).round() as u32).max(1))
}

/// The size to process media of `media` at that's processed again every frame (flowing glass,
/// video): its projection, in 32-pixel steps. Tiers exist so a cached
/// result survives small zooms; one that never survives a frame needn't pay their up to twice
/// as many pixels.
pub fn screen_size(media: (u32, u32), projected: f32) -> (u32, u32) {
    let native = render_size(media.0, media.1);
    let max = native.0.max(native.1) as f32;
    // At its size on screen: it's processed again before any zoom could magnify it.
    let want = (projected / 32.0).ceil() * 32.0;
    if want >= max {
        return native;
    }
    let k = want / max;
    (((native.0 as f32 * k).round() as u32).max(1), ((native.1 as f32 * k).round() as u32).max(1))
}

/// A hash of `p`'s every field: equal params, equal hash. Callers memoize it per `Arc`.
pub fn params_hash(p: &Params) -> u64 {
    let mut h = DefaultHasher::new();
    format!("{p:?}").hash(&mut h);
    h.finish()
}

/// This frame's uniform blocks: each pass takes a slot, and the blocks reach their buffers in
/// one write per buffer before the frame's commands run. Any number of processing runs can
/// share a frame; the buffers stay for the next.
#[derive(Default)]
pub struct Arena {
    bufs: Vec<wgpu::Buffer>,
    staged: Vec<Vec<u8>>,
    cur: usize,
}

const ARENA_SLOTS: u64 = 1024;

impl Arena {
    fn slot(&mut self, device: &wgpu::Device, u: &Uniforms) -> (wgpu::Buffer, u32) {
        if self.staged.get(self.cur).is_some_and(|s| s.len() as u64 >= SLOT * ARENA_SLOTS) {
            self.cur += 1;
        }
        if self.cur == self.bufs.len() {
            self.bufs.push(device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("voidmesh process uniforms"),
                size: SLOT * ARENA_SLOTS,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
            self.staged.push(Vec::new());
        }
        let st = &mut self.staged[self.cur];
        let offset = st.len() as u32;
        st.extend_from_slice(bytemuck::bytes_of(u));
        st.resize(st.len() + SLOT as usize - std::mem::size_of::<Uniforms>(), 0);
        (self.bufs[self.cur].clone(), offset)
    }

    /// Write what this frame staged; call once after encoding, before the frame submits.
    pub fn flush(&mut self, queue: &wgpu::Queue) {
        for (buf, st) in self.bufs.iter().zip(&mut self.staged) {
            if !st.is_empty() {
                queue.write_buffer(buf, 0, st);
                st.clear();
            }
        }
        self.cur = 0;
    }
}

/// The textures a run renders through: two at full size, then the blur and bloom chains (made
/// when a run needs them). They hold nothing between runs, so runs of one size share them.
pub struct Scratch {
    size: (u32, u32),
    /// Made when a run needs them: an effect alone (the common case) needs neither.
    full: [Option<wgpu::Texture>; 2],
    levels: Vec<wgpu::Texture>,
    bloom: Vec<wgpu::Texture>,
    /// A mipmapped output for runs whose result is copied elsewhere (atlas tiles).
    out: Option<wgpu::Texture>,
    /// The frame it was last used in.
    used: u64,
}

impl Scratch {
    fn bytes(&self) -> u64 {
        let px = |t: &wgpu::Texture| u64::from(t.width()) * u64::from(t.height()) * 4;
        self.full.iter().flatten().chain(&self.levels).chain(&self.bloom).chain(&self.out).map(px).sum::<u64>()
    }

    pub fn out(&mut self, device: &wgpu::Device) -> &wgpu::Texture {
        let (w, h) = self.size;
        self.out.get_or_insert_with(|| target_mips(device, w, h, levels_for(w, h).min(PREVIEW_LEVELS), "voidmesh out"))
    }
}

/// Scratch by size, kept while recently used and under a byte budget (the web's
/// `processingTextureBudgetBytes`), so steady processing doesn't reallocate.
#[derive(Default)]
pub struct ScratchPool {
    sets: Vec<Scratch>,
    frame: u64,
}

const SCRATCH_BUDGET: u64 = 128 * 1024 * 1024;
const SCRATCH_FRAMES: u64 = 120;

impl ScratchPool {
    pub fn get(&mut self, size: (u32, u32)) -> &mut Scratch {
        let i = match self.sets.iter().position(|s| s.size == size) {
            Some(i) => i,
            None => {
                self.sets.push(Scratch { size, full: [None, None], levels: Vec::new(), bloom: Vec::new(), out: None, used: 0 });
                self.sets.len() - 1
            }
        };
        let s = &mut self.sets[i];
        s.used = self.frame;
        s
    }

    pub fn bytes(&self) -> u64 {
        self.sets.iter().map(Scratch::bytes).sum()
    }

    /// Drop scratch unused for a while, and the least recently used past the budget. The GPU
    /// keeps what submitted work still reads.
    pub fn sweep(&mut self) {
        let frame = self.frame;
        self.sets.retain(|s| frame.saturating_sub(s.used) < SCRATCH_FRAMES);
        while self.bytes() > SCRATCH_BUDGET && self.sets.len() > 1 {
            let Some(i) = self.sets.iter().enumerate().filter(|(_, s)| s.used != frame).min_by_key(|(_, s)| s.used).map(|(i, _)| i) else { break };
            self.sets.remove(i);
        }
        self.frame += 1;
    }
}

/// A texture an entity's processing renders into, kept by itself: deletion dust's last image,
/// a large material's texture, an export's native-resolution result.
pub struct Processed {
    pub out: wgpu::Texture,
    pub view: wgpu::TextureView,
}

impl Processed {
    pub fn new(device: &wgpu::Device, size: (u32, u32)) -> Processed {
        let (w, h) = size;
        // Mipmapped, so a zoomed-out canvas samples a filtered level instead of aliasing.
        let out = target_mips(device, w, h, levels_for(w, h), "voidmesh processed");
        let view = out.create_view(&Default::default());
        Processed { out, view }
    }
}

/// A material processed by `run_tiles`: its source (the mip level it reads), effect and tile.
pub struct Tiled<'a> {
    pub src: wgpu::TextureView,
    pub params: &'a Params,
    pub time: f32,
    pub media: (u32, u32),
    pub at: [u32; 4],
}

/// `p` is its effect pass alone: neutral adjustments, no blur, nothing after the effect.
pub fn one_pass(p: &Params) -> bool {
    let neutral = p.show_original || (p.brightness == 0.5 && p.contrast == 0.5 && p.saturation == 0.5 && p.blur == 0.0);
    let post = p.post && !p.show_original && (p.grain && p.grain_intensity > 0.0 || p.chroma || p.bloom && p.bloom_intensity > 0.0);
    neutral && !post
}

/// The effects of `jobs` (each `one_pass`) rendered straight into their tiles of `atlas`'s layer
/// `layer`: one pass for all of them, then a pass a mip level below. No scratch textures and no
/// copies, where processing each alone takes passes and copies a material.
#[allow(clippy::too_many_arguments)]
pub fn run_tiles(device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, arena: &mut Arena, atlas: &wgpu::Texture, layer: u32, levels: u32, jobs: &[Tiled<'_>]) {
    let view = |level: u32| {
        atlas.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2), base_mip_level: level, mip_level_count: Some(1), base_array_layer: layer, array_layer_count: Some(1), ..Default::default() })
    };
    let bind = |arena: &mut Arena, u: &Uniforms, src: &wgpu::TextureView, aux: &wgpu::TextureView| {
        let (buffer, offset) = arena.slot(device, u);
        let g = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipes.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &buffer, offset: 0, size: wgpu::BufferSize::new(UNIFORM_SIZE) }) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&pipes.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(aux) },
            ],
        });
        (g, offset)
    };
    for level in 0..levels {
        let target = view(level);
        let above = (level > 0).then(|| view(level - 1));
        let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("voidmesh tiles"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &target, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
            ..Default::default()
        });
        for j in jobs {
            let [x, y, w, h] = j.at;
            let (lx, ly, lw, lh) = (x >> level, y >> level, (w >> level).max(1), (h >> level).max(1));
            let mut u = base_uniforms(j.params, (w, h), j.media, j.time);
            u.res = [lw as f32, lh as f32];
            u.origin = [lx as f32, ly as f32, (x >> level.saturating_sub(1)) as f32, (y >> level.saturating_sub(1)) as f32];
            let (g, offset) = match &above {
                None => bind(arena, &u, &j.src, &pipes.atlas),
                Some(a) => bind(arena, &u, a, &pipes.dummy),
            };
            rp.set_pipeline(if level == 0 { pipes.effect(u.effect, u.kind) } else { &pipes.mip });
            rp.set_bind_group(0, Some(&g), &[offset]);
            rp.set_viewport(lx as f32, ly as f32, lw as f32, lh as f32, 0.0, 1.0);
            rp.set_scissor_rect(lx, ly, lw, lh);
            rp.draw(0..3, 0..1);
        }
    }
}

/// What a processing run reads: a mipmapped source and the media's native size.
pub struct Input<'a> {
    pub texture: &'a wgpu::Texture,
    pub view: &'a wgpu::TextureView,
    pub size: (u32, u32),
    pub levels: u32,
    pub media: (u32, u32),
}

/// Encode the whole pipeline from `input` into level 0 of `out` (its size is the render size),
/// then `out`'s mip chain.
#[allow(clippy::too_many_arguments)]
pub fn run(device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, arena: &mut Arena, scratch: &mut ScratchPool, input: &Input<'_>, p: &Params, time: f32, out: &wgpu::Texture) {
    let size = (out.width(), out.height());
    let sc = scratch.get(size);
    let (w, h) = size;
    let blur = if p.show_original { 0.0 } else { p.blur };
    let (n_blur, offset) = effects::blur_levels(blur * w.max(h) as f32 / input.media.0.max(input.media.1) as f32);
    let bloom = p.post && p.bloom && p.bloom_intensity > 0.0 && !p.show_original;
    while sc.levels.len() < n_blur as usize {
        let i = sc.levels.len() as u32 + 1;
        sc.levels.push(target(device, (w >> i).max(1), (h >> i).max(1), "voidmesh blur"));
    }
    if bloom && sc.bloom.is_empty() {
        sc.bloom = (1..=BLOOM_LEVELS).map(|i| target(device, (w >> i).max(1), (h >> i).max(1), "voidmesh bloom")).collect();
    }
    // A (adjusted, blurred) when adjustments or blur run, B when anything follows the effect.
    let neutral = p.show_original || (p.brightness == 0.5 && p.contrast == 0.5 && p.saturation == 0.5);
    let direct = neutral && n_blur == 0;
    let no_post = !bloom && !(p.post && !p.show_original && ((p.grain && p.grain_intensity > 0.0) || p.chroma));
    for (i, needed) in [(0, !direct), (1, !no_post)] {
        if needed && sc.full[i].is_none() {
            sc.full[i] = Some(target(device, w, h, "voidmesh scratch"));
        }
    }
    let full = [0, 1].map(|i| sc.full[i].clone().unwrap_or_else(|| pipes.blank.clone()));
    let (full, levels_t, bloom_t) = (&full, &sc.levels, &sc.bloom);
    let base = base_uniforms(p, size, input.media, time);
    let mut pass_to = |enc: &mut wgpu::CommandEncoder, pipe: &wgpu::RenderPipeline, src: &wgpu::TextureView, aux: &wgpu::TextureView, view: &wgpu::TextureView, size: (u32, u32), edit: &dyn Fn(&mut Uniforms)| {
        let mut u = base;
        u.res = [size.0 as f32, size.1 as f32];
        edit(&mut u);
        let (buffer, offset) = arena.slot(device, &u);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipes.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &buffer, offset: 0, size: wgpu::BufferSize::new(UNIFORM_SIZE) }) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(src) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&pipes.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(aux) },
            ],
        });
        let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("voidmesh process"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        rp.set_pipeline(pipe);
        rp.set_bind_group(0, Some(&bind), &[offset]);
        rp.draw(0..3, 0..1);
    };
    let mip_view = |t: &wgpu::Texture, level: u32| t.create_view(&wgpu::TextureViewDescriptor { base_mip_level: level, mip_level_count: Some(1), ..Default::default() });
    let mut pass = |enc: &mut wgpu::CommandEncoder, pipe: &wgpu::RenderPipeline, src: &wgpu::TextureView, aux: &wgpu::TextureView, out: &wgpu::Texture, edit: &dyn Fn(&mut Uniforms)| {
        pass_to(enc, pipe, src, aux, &mip_view(out, 0), (out.width(), out.height()), edit);
    };
    let dummy = &pipes.dummy;
    let view = |t: &wgpu::Texture| t.create_view(&Default::default());
    let texel = |t: &wgpu::Texture| [1.0 / t.width() as f32, 1.0 / t.height() as f32];

    // 1. Adjustments into A, reading the source level nearest this size. Neutral ones (and no
    // blur) are skipped: the effect reads that level itself, as the web skips its pass.
    let src_lod = ((input.size.0.max(input.size.1) as f32 / w.max(h) as f32).log2()).clamp(0.0, (input.levels.max(1) - 1) as f32);
    let src_level = input.texture.create_view(&wgpu::TextureViewDescriptor { base_mip_level: src_lod.floor() as u32, mip_level_count: Some(1), ..Default::default() });
    if !direct {
        pass(enc, &pipes.adjust, input.view, dummy, &full[0], &|u| u.blur[1] = src_lod);
    }
    // 2. Blur A in place through the level chain.
    if n_blur > 0 {
        let n = n_blur as usize;
        let mut prev = view(&full[0]);
        let mut prev_texel = texel(&full[0]);
        for t in &levels_t[..n] {
            pass(enc, &pipes.down, &prev, dummy, t, &|u| u.blur = [offset, 0.0, prev_texel[0], prev_texel[1]]);
            prev = view(t);
            prev_texel = texel(t);
        }
        for i in (0..n).rev() {
            let out = if i == 0 { &full[0] } else { &levels_t[i - 1] };
            pass(enc, &pipes.up, &prev, dummy, out, &|u| u.blur = [offset, 0.0, prev_texel[0], prev_texel[1]]);
            prev = view(out);
            prev_texel = texel(out);
        }
    }
    // 3. The effect, A into B, or straight into the output when nothing follows it.
    let effect_in = if direct { src_level } else { view(&full[0]) };
    let effect_out = if no_post { out } else { &full[1] };
    pass(enc, pipes.effect(base.effect, base.kind), &effect_in, &pipes.atlas, effect_out, &|_| {});
    // 4. Bloom from B through the bloom chain.
    if bloom {
        pass(enc, &pipes.bright, &view(&full[1]), dummy, &bloom_t[0], &|_| {});
        let spread = p.bloom_radius / 100.0 * 3.0;
        let mut prev = view(&bloom_t[0]);
        let mut prev_texel = texel(&bloom_t[0]);
        for t in &bloom_t[1..] {
            pass(enc, &pipes.down, &prev, dummy, t, &|u| u.blur = [spread, 0.0, prev_texel[0], prev_texel[1]]);
            prev = view(t);
            prev_texel = texel(t);
        }
        for i in (0..bloom_t.len() - 1).rev() {
            let out = &bloom_t[i];
            pass(enc, &pipes.up, &prev, dummy, out, &|u| u.blur = [spread, 0.0, prev_texel[0], prev_texel[1]]);
            prev = view(out);
            prev_texel = texel(out);
        }
    }
    // 5. Post into the output.
    if !no_post {
        let bloom_view = bloom_t.first().map(view);
        pass(enc, &pipes.post, &view(&full[1]), bloom_view.as_ref().filter(|_| bloom).unwrap_or(dummy), out, &|u| {
            if !bloom {
                u.post[3] = 0.0;
            }
        });
    }
    drop(pass);
    // 6. The mip chain, each level a box filter of the one above.
    for level in 1..out.mip_level_count() {
        let src = mip_view(out, level - 1);
        let size = ((w >> level).max(1), (h >> level).max(1));
        pass_to(enc, &pipes.mip, &src, dummy, &mip_view(out, level), size, &|_| {});
    }
}

/// The shader's `hash21`, on the CPU.
fn hash21(x: f32, y: f32) -> f32 {
    ((x * 127.1 + y * 311.7).sin() * 43_758.547).rem_euclid(1.0)
}

/// Flowing glass's constants at `time` for wavelength `wl`: per turbulence octave
/// `0.3 t + i + drift_i / 2` (its phase offset, `drift_i` a smooth random walk), then the wave
/// field's slow drifts.
fn flowing_constants(time: f32, wl: f32) -> [[f32; 4]; 3] {
    let st = time * 0.07;
    let (sf, f) = (st.floor(), st - st.floor());
    let sm = f * f * (3.0 - 2.0 * f);
    let mut ph = [0.0f32; 8];
    for (i, v) in ph.iter_mut().enumerate() {
        let key = i as f32 * 17.3;
        let a = hash21(key, sf);
        let drift = (a + (hash21(key, sf + 1.0) - a) * sm) * std::f32::consts::TAU;
        *v = 0.3 * time + i as f32 + drift * 0.5;
    }
    let d1 = (time * 0.13).sin() * wl * 0.1;
    let d2 = (time * 0.09 + 2.7).sin() * wl * 0.07;
    [[ph[0], ph[1], ph[2], ph[3]], [ph[4], ph[5], ph[6], ph[7]], [d1, d2, 0.0, 0.0]]
}

fn base_uniforms(p: &Params, size: (u32, u32), media: (u32, u32), time: f32) -> Uniforms {
    // Spatial params are in media pixels; scale them to the render size.
    let k = size.0.max(size.1) as f32 / media.0.max(media.1).max(1) as f32;
    let palette = if p.shader.uses_palette() { p.gpu_palette() } else { vec![[0.0, 0.0, 0.0, 1.0], [1.0; 4]] };
    let mut pal = [[0.0f32; 4]; 16];
    for (i, c) in palette.iter().enumerate().take(16) {
        pal[i] = *c;
    }
    let shader = if p.show_original { 0 } else { p.shader.gpu_id() };
    let (kind, x, y) = match p.shader {
        Shader::Dithering => (p.dither_kind, [0.0; 4], [0.0; 4]),
        Shader::Ascii => (p.ascii_kind, [0.0; 4], [0.0; 4]),
        Shader::Blobs => (0, [p.eagerness, 0.0, 0.0, 0.0], [0.0; 4]),
        Shader::Glass => (p.glass_kind, [p.glass_angle, p.caustic, p.frostiness, p.highlight], [p.dispersion, p.flow, 0.0, 0.0]),
        Shader::Glitch => (p.glitch_kind, [p.glitch_angle, 0.0, 0.0, 0.0], [0.0; 4]),
        _ => (0, [0.0; 4], [0.0; 4]),
    };
    let flags = u32::from(p.ascii_invert) | (u32::from(!p.preserve_colors) << 1);
    let post_on = p.post && !p.show_original;
    Uniforms {
        res: [size.0 as f32, size.1 as f32],
        scale: p.scale,
        intensity: p.intensity,
        cell: (p.size * k).max(1.0),
        shape: match p.shape {
            DotShape::Circle => 0,
            DotShape::Square => 1,
            DotShape::RectV => 2,
        },
        preserve: u32::from(p.preserve_colors),
        kind,
        pcount: palette.len().min(16) as u32,
        effect: shader,
        flags,
        time,
        x,
        y: [y[0], y[1], p.bloom_threshold, p.bloom_softness],
        // Show Original bypasses everything, adjustments included.
        adj: if p.show_original { [0.5, 0.5, 0.5, 0.0] } else { [p.brightness, p.contrast, p.saturation, 0.0] },
        post: [
            p.grain_size * k,
            if post_on && p.grain { p.grain_intensity } else { 0.0 },
            if post_on && p.chroma { p.chroma_offset * k } else { 0.0 },
            p.bloom_intensity,
        ],
        blur: [0.0; 4],
        flow: if p.uses_time() { flowing_constants(time, (p.size * k).max(1.0)) } else { [[0.0; 4]; 3] },
        origin: [0.0; 4],
        palette: pal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_original_bypasses_adjustments_effect_and_post() {
        let p = Params { show_original: true, brightness: 0.9, contrast: 0.1, saturation: 0.0, chroma: true, ..Params::default() };
        let u = base_uniforms(&p, (100, 100), (100, 100), 0.0);
        assert_eq!(u.adj, [0.5, 0.5, 0.5, 0.0], "neutral adjustments");
        assert_eq!(u.effect, 0);
        assert_eq!((u.post[1], u.post[2]), (0.0, 0.0), "no grain or chromatic aberration");
    }

    #[test]
    fn lod_follows_the_webs_tiers() {
        assert_eq!(lod_size((1034, 1435), 10.0), (12, 16), "a speck takes the smallest tier");
        assert_eq!(lod_size((1034, 1435), 40.0), (46, 64));
        assert_eq!(lod_size((1024, 1024), 300.0), (512, 512));
        assert_eq!(lod_size((1024, 1024), 900.0), (1024, 1024), "native once the projection reaches it");
        assert_eq!(lod_size((100, 50), 10.0), (16, 8));
        assert_eq!(lod_size((40, 20), 300.0), (40, 20), "never above native");
    }

    #[test]
    #[ignore = "a timing, not a check: cargo test --release -- --ignored level_chain_speed --nocapture"]
    fn level_chain_speed() {
        let px = vec![90u8; 2048 * 1365 * 4];
        for k in [1, 3, 5] {
            let t = std::time::Instant::now();
            let n = 20;
            for _ in 0..n {
                std::hint::black_box(level_chain(2048, 1365, &px, k, 4));
            }
            eprintln!("level {k}: {:.2} ms", t.elapsed().as_secs_f64() * 1e3 / n as f64);
        }
        let t = std::time::Instant::now();
        std::hint::black_box(half_rgba(2048, 1365, &px));
        eprintln!("one halving: {:.2} ms", t.elapsed().as_secs_f64() * 1e3);
    }

    #[test]
    fn simd_halving_matches_the_scalar_mean() {
        let px: Vec<u8> = (0..67 * 9 * 4).map(|i| ((i * 37 + i / 7) % 256) as u8).collect();
        let (nw, nh, fast) = half_rgba(67, 9, &px);
        let mut slow = vec![0u8; nw * nh * 4];
        for (y, out) in slow.chunks_exact_mut(nw * 4).enumerate() {
            let r0 = &px[(y * 2) * 67 * 4..][..67 * 4];
            let r1 = &px[((y * 2 + 1).min(8)) * 67 * 4..][..67 * 4];
            half_row_scalar(r0, r1, 67, out, 0);
        }
        assert_eq!(fast, slow);
    }

    #[test]
    fn level_chains_match_full_chains() {
        let px: Vec<u8> = (0..37 * 23 * 4).map(|i| (i * 7 % 251) as u8).collect();
        let full = mips_rgba(37, 23, &px);
        let from2 = level_chain(37, 23, &px, 2, 3);
        assert_eq!(from2.len(), 3);
        assert_eq!((from2[0].0, from2[0].1), (9, 5));
        assert_eq!(from2[0].2, full[1]);
        assert_eq!(from2[2].2, full[3]);
        assert_eq!(level_chain(37, 23, &px, 0, 1)[0].2, px);
    }

    #[test]
    fn mips_average_two_by_two_blocks() {
        let px: Vec<u8> = [[0u8, 0, 0, 255], [255, 255, 255, 255], [255, 255, 255, 255], [0, 0, 0, 255], [10, 20, 30, 40], [10, 20, 30, 40]].concat();
        let m = mips_rgba(3, 2, &px);
        assert_eq!(m.len(), 1);
        // The rounded mean of black, white, black and a translucent dark pixel.
        assert_eq!(&m[0], &[66, 69, 71, 201]);
        let big = mips_rgba(1034, 1435, &vec![7u8; 1034 * 1435 * 4]);
        assert_eq!(big.len() as u32, levels_for(1034, 1435) - 1);
        assert_eq!(big.last().map(Vec::len), Some(4));
    }

    #[test]
    fn media_renders_at_native_size_up_to_the_gpu_limit() {
        assert_eq!(render_size(12_000, 8_000), (12_000, 8_000));
        assert_eq!(render_size(32_768, 16_384), (16_384, 8_192));
    }
}
