//! Per-entity processing: source → adjustments → blur → effect → bloom → post, into a processed
//! texture at native media resolution. It runs only when its inputs change (params, GIF frame,
//! flowing-glass time); pan and zoom just redraw the cached result.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use bytemuck::{Pod, Zeroable};

use crate::effects::{self, DotShape, Params, Shader};

/// Intermediate and processed textures hold sRGB-encoded values, as the web app's canvases do.
pub const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Longest side the pipeline renders at: the GPU's own texture limit (Rune's Metal device and
/// Apple GPUs allow 16384). Media renders at its native size up to that.
pub const MAX_SIDE: u32 = 16384;
const SLOT: u64 = 512;
const SLOTS: u64 = 48;
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
    palette: [[f32; 4]; 16],
}

const _: () = assert!(std::mem::size_of::<Uniforms>() == 384);

/// Pipelines and shared bindings for every entity's processing.
pub struct Pipes {
    pub layout: wgpu::BindGroupLayout,
    adjust: wgpu::RenderPipeline,
    down: wgpu::RenderPipeline,
    up: wgpu::RenderPipeline,
    bright: wgpu::RenderPipeline,
    effect: wgpu::RenderPipeline,
    post: wgpu::RenderPipeline,
    mip: wgpu::RenderPipeline,
    pub sampler: wgpu::Sampler,
    atlas: wgpu::TextureView,
    dummy: wgpu::TextureView,
}

impl Pipes {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Pipes {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("voidmesh process"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/process.wgsl").into()),
        });
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
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(384) },
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
        let dummy = upload(device, queue, 1, 1, &[0, 0, 0, 0]).create_view(&Default::default());
        Pipes {
            layout,
            adjust: pipe("fs_adjust"),
            down: pipe("fs_down"),
            up: pipe("fs_up"),
            bright: pipe("fs_bright"),
            effect: pipe("fs_effect"),
            post: pipe("fs_post"),
            mip: pipe("fs_mip"),
            sampler,
            atlas,
            dummy,
        }
    }
}

/// A texture made from RGBA8 pixels (sRGB-encoded values, sampled as is).
pub fn upload(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, rgba: &[u8]) -> wgpu::Texture {
    let t = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("voidmesh source"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    write(queue, &t, w, h, rgba);
    t
}

pub fn write(queue: &wgpu::Queue, t: &wgpu::Texture, w: u32, h: u32, rgba: &[u8]) {
    queue.write_texture(
        t.as_image_copy(),
        rgba,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
}

fn target(device: &wgpu::Device, w: u32, h: u32, label: &str) -> wgpu::Texture {
    target_mips(device, w, h, 1, label)
}

fn target_mips(device: &wgpu::Device, w: u32, h: u32, mips: u32, label: &str) -> wgpu::Texture {
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

/// Output size for media of `w`×`h`: native, or scaled so the longest side fits `MAX_SIDE`.
pub fn render_size(w: u32, h: u32) -> (u32, u32) {
    let m = w.max(h);
    if m <= MAX_SIDE {
        return (w.max(1), h.max(1));
    }
    let k = MAX_SIDE as f32 / m as f32;
    (((w as f32 * k).round() as u32).max(1), ((h as f32 * k).round() as u32).max(1))
}

/// What the processed texture depends on; a change re-runs the pipeline.
pub fn key(params: &Params, source: u64, frame: usize, time: f32) -> u64 {
    let mut h = DefaultHasher::new();
    source.hash(&mut h);
    frame.hash(&mut h);
    format!("{params:?}").hash(&mut h);
    if params.uses_time() {
        time.to_bits().hash(&mut h);
    }
    h.finish()
}

/// The textures a run renders through: two at full size, then the blur and bloom chains. They
/// hold nothing between runs, so entities of one size share them (`Scratch::get`), and only the
/// processed texture stays per entity: a large image costs about one texture, not three.
pub struct Scratch {
    size: (u32, u32),
    full: [wgpu::Texture; 2],
    levels: Vec<wgpu::Texture>,
    bloom: Vec<wgpu::Texture>,
    /// Used since the last `sweep`.
    used: bool,
}

/// Shared scratch by size, swept of sizes nothing processed lately.
#[derive(Default)]
pub struct ScratchPool(Vec<Scratch>);

impl ScratchPool {
    pub fn get(&mut self, device: &wgpu::Device, size: (u32, u32)) -> &mut Scratch {
        let i = match self.0.iter().position(|s| s.size == size) {
            Some(i) => i,
            None => {
                let (w, h) = size;
                self.0.push(Scratch {
                    size,
                    full: [target(device, w, h, "voidmesh a"), target(device, w, h, "voidmesh b")],
                    levels: (1..=8).map(|i| target(device, (w >> i).max(1), (h >> i).max(1), "voidmesh blur")).collect(),
                    bloom: (1..=BLOOM_LEVELS).map(|i| target(device, (w >> i).max(1), (h >> i).max(1), "voidmesh bloom")).collect(),
                    used: false,
                });
                self.0.len() - 1
            }
        };
        let s = &mut self.0[i];
        s.used = true;
        s
    }

    /// Free scratch no run used since the last sweep (call once per frame, after encoding;
    /// the GPU keeps what submitted work still reads).
    pub fn sweep(&mut self) {
        self.0.retain(|s| s.used);
        for s in &mut self.0 {
            s.used = false;
        }
    }
}

/// One entity's GPU state: its processed texture.
pub struct Processed {
    pub key: u64,
    pub size: (u32, u32),
    pub out: wgpu::Texture,
    pub view: wgpu::TextureView,
    uniforms: wgpu::Buffer,
}

impl Processed {
    pub fn new(device: &wgpu::Device, size: (u32, u32)) -> Processed {
        let (w, h) = size;
        // Mipmapped, so a zoomed-out canvas samples a filtered level instead of aliasing.
        let mips = 32 - w.max(h).max(1).leading_zeros();
        let out = target_mips(device, w, h, mips, "voidmesh processed");
        let view = out.create_view(&Default::default());
        Processed {
            key: u64::MAX,
            size,
            out,
            view,
            uniforms: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("voidmesh process uniforms"),
                size: SLOT * SLOTS,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
        }
    }

    /// Encode the whole pipeline from `source` into `self.out`, through `scratch` of this size.
    #[allow(clippy::too_many_arguments)]
    pub fn run(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, pipes: &Pipes, scratch: &mut ScratchPool, source: &wgpu::TextureView, media: (u32, u32), p: &Params, time: f32) {
        let sc = scratch.get(device, self.size);
        let (full, levels_t, bloom_t) = (&sc.full, &sc.levels, &sc.bloom);
        let base = base_uniforms(p, self.size, media, time);
        let mut slot = 0u64;
        let mut pass_to = |enc: &mut wgpu::CommandEncoder, pipe: &wgpu::RenderPipeline, input: &wgpu::TextureView, aux: &wgpu::TextureView, view: &wgpu::TextureView, size: (u32, u32), edit: &dyn Fn(&mut Uniforms)| {
            let mut u = base;
            u.res = [size.0 as f32, size.1 as f32];
            edit(&mut u);
            let offset = slot * SLOT;
            slot = (slot + 1).min(SLOTS - 1);
            queue.write_buffer(&self.uniforms, offset, bytemuck::bytes_of(&u));
            let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipes.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.uniforms, offset: 0, size: wgpu::BufferSize::new(384) }) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(input) },
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
            rp.set_bind_group(0, Some(&bind), &[offset as u32]);
            rp.draw(0..3, 0..1);
        };
        let mip_view = |t: &wgpu::Texture, level: u32| t.create_view(&wgpu::TextureViewDescriptor { base_mip_level: level, mip_level_count: Some(1), ..Default::default() });
        let mut pass = |enc: &mut wgpu::CommandEncoder, pipe: &wgpu::RenderPipeline, input: &wgpu::TextureView, aux: &wgpu::TextureView, out: &wgpu::Texture, edit: &dyn Fn(&mut Uniforms)| {
            pass_to(enc, pipe, input, aux, &mip_view(out, 0), (out.width(), out.height()), edit);
        };
        let dummy = &pipes.dummy;
        let view = |t: &wgpu::Texture| t.create_view(&Default::default());
        let texel = |t: &wgpu::Texture| [1.0 / t.width() as f32, 1.0 / t.height() as f32];

        // 1. Adjustments into A.
        pass(enc, &pipes.adjust, source, dummy, &full[0], &|_| {});
        // 2. Blur A in place through the level chain.
        let blur = if p.show_original { 0.0 } else { p.blur };
        let (levels, offset) = effects::blur_levels(blur * self.size.0.max(self.size.1) as f32 / media.0.max(media.1) as f32);
        if levels > 0 {
            let n = levels as usize;
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
        // 3. The effect, A into B.
        pass(enc, &pipes.effect, &view(&full[0]), &pipes.atlas, &full[1], &|_| {});
        // 4. Bloom from B through the bloom chain.
        let bloom = p.post && p.bloom && p.bloom_intensity > 0.0 && !p.show_original;
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
        // 5. Post into the processed texture.
        let bloom_view = view(&bloom_t[0]);
        pass(enc, &pipes.post, &view(&full[1]), if bloom { &bloom_view } else { dummy }, &self.out, &|u| {
            if !bloom {
                u.post[3] = 0.0;
            }
        });
        drop(pass);
        // 6. The mip chain, each level a box filter of the one above.
        for level in 1..self.out.mip_level_count() {
            let src = mip_view(&self.out, level - 1);
            let size = ((self.size.0 >> level).max(1), (self.size.1 >> level).max(1));
            pass_to(enc, &pipes.mip, &src, dummy, &mip_view(&self.out, level), size, &|_| {});
        }
    }
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
    fn media_renders_at_native_size_up_to_the_gpu_limit() {
        assert_eq!(render_size(12_000, 8_000), (12_000, 8_000));
        assert_eq!(render_size(32_768, 16_384), (16_384, 8_192));
    }
}
