//! The compositor. Rune lays out and draws the UI; at each `El::effect` slot this paints the
//! canvas: the dot grid behind everything, and each entity's processed texture in its slot (laid
//! out at the entity's screen rect from the camera). Processing runs before the UI
//! pass, only for entities whose inputs changed.

mod export;
pub mod process;

use std::collections::HashMap;
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};
use rune::compose::{Compositor, DeviceKey, Frame};
use rune::render::{EffectPhase, EffectSite, CLIP_WGSL};

use crate::media::Asset;
use crate::state::App;
use process::{Pipes, Processed};

/// The canvas background slot.
pub const GRID: u32 = 1;
/// The canvas lensing slot (reads its backdrop: everything on the canvas below the chrome).
pub const LENS: u32 = 2;
/// Entity slots are marked `ENTITY + id`.
pub const ENTITY: u32 = 1 << 16;

/// Selection ring width in points.
const RING_PT: f32 = 2.0;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Slot {
    rect: [f32; 4],
    view: [f32; 4],
    clip: [f32; 4],
    fade: [u32; 4],
    a: [f32; 4],
    b: [f32; 4],
    c: [f32; 4],
    d: [f32; 4],
    e: [f32; 4],
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum SrcKey {
    /// Stills share one upload per asset.
    Asset(u64),
    /// Animated media keeps a texture per entity, which shows its own frame. Keyed with the
    /// asset too: an opened workspace reuses entity ids.
    Entity(u32, u64),
}

struct Source {
    frame: usize,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    used: bool,
}

/// A video entity's frames: its decoder, the seek it last followed and the frame on the GPU.
struct VideoSource {
    decoder: crate::video::Decoder,
    seek_gen: u32,
    /// Counts uploaded frames: the processing key's frame.
    frame: usize,
    tex: Option<(wgpu::Texture, wgpu::TextureView)>,
    /// A seek is waiting for its first frame (keep drawing until it lands).
    waiting: bool,
    used: bool,
}

/// Longest side video decodes at for the canvas: its own size, up to what the GPU holds.
const VIDEO_SIDE: u32 = process::MAX_SIDE;

struct Res {
    key: DeviceKey,
    pipes: Pipes,
    layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    module: wgpu::ShaderModule,
    entity: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    grid: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    lens: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    /// The colour picker's area, hue and alpha tracks.
    picker: HashMap<(wgpu::TextureFormat, u32), wgpu::RenderPipeline>,
    blank: wgpu::BindGroup,
}

struct EntityGpu {
    proc: Processed,
    bind: wgpu::BindGroup,
    used: bool,
}

#[derive(Default)]
pub struct Gfx {
    res: Option<Res>,
    sources: HashMap<SrcKey, Source>,
    /// By entity and asset, as `SrcKey::Entity`.
    videos: HashMap<(u32, u64), VideoSource>,
    scratch: process::ScratchPool,
    entities: HashMap<u32, EntityGpu>,
    exporter: export::Exporter,
    animating: bool,
}

impl Compositor<App> for Gfx {
    fn features(&self) -> wgpu::Features {
        wgpu::Features::IMMEDIATES
    }

    fn animating(&self) -> bool {
        self.animating || self.exporter.busy()
    }

    fn render(&mut self, f: &mut Frame<'_, App>) {
        let (device, queue, size) = (f.device, f.queue, f.size);
        let key = f.device_key();
        if self.res.as_ref().is_none_or(|r| r.key != key) {
            self.sources.clear();
            self.videos.clear();
            self.scratch = Default::default();
            self.entities.clear();
            self.res = Some(Res::new(device, queue, key));
        }
        let Some(res) = self.res.as_mut() else { return };

        // Process what changed.
        for s in self.sources.values_mut() {
            s.used = false;
        }
        for v in self.videos.values_mut() {
            v.used = false;
        }
        let mut video_waiting = false;
        for e in self.entities.values_mut() {
            e.used = false;
        }
        let dark = f.rt.env.system_dark;
        let device_scale = f.rt.env.scale;
        let state = &mut f.rt.state;
        state.device_scale = device_scale;
        for e in &state.entities {
            let asset = &e.asset;
            if let Some(path) = asset.video_path() {
                let v = self.videos.entry((e.id, asset.id)).or_insert_with(|| VideoSource {
                    decoder: crate::video::Decoder::new(path.to_path_buf(), e.play_t, VIDEO_SIDE, None),
                    seek_gen: e.seek_gen,
                    frame: 0,
                    tex: None,
                    waiting: true,
                    used: true,
                });
                v.used = true;
                if v.seek_gen != e.seek_gen {
                    v.decoder.seek(e.play_t);
                    v.seek_gen = e.seek_gen;
                    v.waiting = true;
                }
                if let Some(f) = v.decoder.frame_at(e.play_t) {
                    if v.tex.as_ref().is_none_or(|(t, _)| (t.width(), t.height()) != (f.width, f.height)) {
                        let t = process::upload(device, queue, f.width, f.height, &f.rgba);
                        let view = t.create_view(&Default::default());
                        v.tex = Some((t, view));
                    } else if let Some((t, _)) = &v.tex {
                        process::write(queue, t, f.width, f.height, &f.rgba);
                    }
                    v.frame = v.frame.wrapping_add(1);
                    v.waiting = false;
                    state.video_frames.insert((e.id, asset.id), f);
                }
                if v.decoder.error().is_some() {
                    v.waiting = false;
                }
                video_waiting |= v.waiting;
                let Some((_, view)) = &v.tex else { continue };
                let rsize = process::render_size(asset.width, asset.height);
                let gpu = self.entities.entry(e.id).or_insert_with(|| EntityGpu::new(device, &res.pipes, &res.layout, rsize));
                if gpu.proc.size != rsize {
                    *gpu = EntityGpu::new(device, &res.pipes, &res.layout, rsize);
                }
                gpu.used = true;
                let k = process::key(&e.params, asset.id ^ u64::from(e.id) << 40, v.frame, e.fx_t as f32);
                if gpu.proc.key != k {
                    gpu.proc.run(device, queue, f.encoder, &res.pipes, &mut self.scratch, view, (asset.width, asset.height), &e.params, e.fx_t as f32);
                    gpu.proc.key = k;
                }
                continue;
            }
            let frame = asset.frame_at(e.play_t);
            let skey = if asset.animated() { SrcKey::Entity(e.id, asset.id) } else { SrcKey::Asset(asset.id) };
            let src = self.sources.entry(skey).or_insert_with(|| new_source(device, queue, asset, frame));
            if src.frame != frame {
                process::write(queue, &src.texture, asset.width, asset.height, &asset.frames[frame].rgba);
                src.frame = frame;
            }
            src.used = true;
            let rsize = process::render_size(asset.width, asset.height);
            let gpu = self.entities.entry(e.id).or_insert_with(|| EntityGpu::new(device, &res.pipes, &res.layout, rsize));
            if gpu.proc.size != rsize {
                *gpu = EntityGpu::new(device, &res.pipes, &res.layout, rsize);
            }
            gpu.used = true;
            let k = process::key(&e.params, asset.id, frame, e.fx_t as f32);
            if gpu.proc.key != k {
                gpu.proc.run(device, queue, f.encoder, &res.pipes, &mut self.scratch, &src.view, (asset.width, asset.height), &e.params, e.fx_t as f32);
                gpu.proc.key = k;
            }
        }
        self.sources.retain(|_, s| s.used);
        self.videos.retain(|_, v| v.used);
        state.video_frames.retain(|k, _| self.videos.contains_key(k));
        self.scratch.sweep();
        self.entities.retain(|_, e| e.used);
        self.animating = state.animating() || video_waiting;

        // Exports read back processed textures.
        for req in std::mem::take(&mut state.exports) {
            match self.entities.get(&req.entity) {
                Some(g) => self.exporter.request(device, f.encoder, &g.proc.out, req.path, state.loader.clone()),
                None => state.toast("Nothing to export"),
            }
        }
        self.exporter.poll(device);

        let cam = (state.cam.pan, state.cam.scale, state.canvas);
        let selected: Vec<u32> = state.selection.iter().copied().collect();
        let lens = crate::state::Lensing::preset(state.lens);
        let picked = state.picker.as_ref().map(|k| (k.oklch, crate::color::to_rgba(k.oklch)));
        for fmt in [f.format, wgpu::TextureFormat::Rgba16Float] {
            res.ensure(device, fmt);
        }

        let clear = f.rt.clear_color();
        f.ui.prepare(device, queue, &mut f.rt.text.atlas, &f.rt.instances, size);
        let entities = &self.entities;
        f.ui.draw_with_backdrop(f.encoder, f.target, clear, &mut |phase, site: &EffectSite<'_>| {
            let EffectPhase::Draw(pass) = phase else { return };
            let i = site.instance;
            let base = Slot {
                rect: [i.rect[0] - site.origin[0], i.rect[1] - site.origin[1], i.rect[2], i.rect[3]],
                view: [site.size[0] as f32, site.size[1] as f32, site.origin[0], site.origin[1]],
                clip: i.clip,
                fade: i.fade,
                a: [0.0; 4],
                b: [if site.srgb_blend { 1.0 } else { 0.0 }, if dark { 1.0 } else { 0.0 }, 0.0, 0.0],
                c: [0.0; 4],
                d: [0.0; 4],
                e: [0.0; 4],
            };
            if site.mark == GRID {
                let Some(pipe) = res.grid.get(&site.format) else { return };
                let (pan, s, canvas) = cam;
                let dpr = site.scale;
                let wpp = 1.0 / (dpr * s);
                let c0 = [canvas[0] * dpr, canvas[1] * dpr];
                let w0 = [-c0[0] * wpp - pan[0] / s, -c0[1] * wpp - pan[1] / s];
                let slot = Slot { a: [w0[0], w0[1], wpp, dpr], ..base };
                pass.set_pipeline(pipe);
                pass.set_bind_group(0, Some(&res.blank), &[]);
                pass.set_immediates(0, bytemuck::bytes_of(&slot));
                pass.draw(0..6, 0..1);
            } else if site.mark == LENS {
                let (Some(pipe), Some(bd), Some(l)) = (res.lens.get(&site.format), site.backdrop, lens) else { return };
                let bind = composite_bind(device, &res.layout, bd, &res.pipes.sampler);
                let vignette = if dark { l.vignette_dark } else { l.vignette_light };
                let slot = Slot {
                    c: [l.strength, l.radius, l.falloff, l.dispersion],
                    d: [l.scale, l.reflection, l.focus, l.occlusion],
                    e: [vignette, 0.0, 0.0, 0.0],
                    ..base
                };
                pass.set_pipeline(pipe);
                pass.set_bind_group(0, Some(&bind), &[]);
                pass.set_immediates(0, bytemuck::bytes_of(&slot));
                pass.draw(0..6, 0..1);
            } else if let Some(pipe) = res.picker.get(&(site.format, site.mark)) {
                let Some((o, c)) = picked else { return };
                let slot = Slot { c: [o.h, c[0], c[1], c[2]], ..base };
                pass.set_pipeline(pipe);
                pass.set_bind_group(0, Some(&res.blank), &[]);
                pass.set_immediates(0, bytemuck::bytes_of(&slot));
                pass.draw(0..6, 0..1);
            } else if site.mark >= ENTITY {
                let id = site.mark - ENTITY;
                let (Some(g), Some(pipe)) = (entities.get(&id), res.entity.get(&site.format)) else { return };
                let sel = selected.contains(&id);
                // Grow the quad by the ring so it draws outside the image.
                let ring = RING_PT * site.scale;
                let ring = if sel { ring.max(1.0) } else { 0.0 };
                let r = base.rect;
                let slot = Slot { rect: [r[0] - ring, r[1] - ring, r[2] + 2.0 * ring, r[3] + 2.0 * ring], a: [ring, ring, if sel { 1.0 } else { 0.0 }, 0.0], ..base };
                pass.set_pipeline(pipe);
                pass.set_bind_group(0, Some(&g.bind), &[]);
                pass.set_immediates(0, bytemuck::bytes_of(&slot));
                pass.draw(0..6, 0..1);
            }
        });
    }
}

fn new_source(device: &wgpu::Device, queue: &wgpu::Queue, asset: &Arc<Asset>, frame: usize) -> Source {
    let texture = process::upload(device, queue, asset.width, asset.height, &asset.frames[frame].rgba);
    let view = texture.create_view(&Default::default());
    Source { frame, texture, view, used: true }
}

impl EntityGpu {
    fn new(device: &wgpu::Device, pipes: &Pipes, layout: &wgpu::BindGroupLayout, size: (u32, u32)) -> EntityGpu {
        let proc = Processed::new(device, size);
        let bind = composite_bind(device, layout, &proc.view, &pipes.sampler);
        EntityGpu { proc, bind, used: true }
    }
}

fn composite_bind(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, view: &wgpu::TextureView, sampler: &wgpu::Sampler) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("voidmesh composite"),
        layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
        ],
    })
}

impl Res {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue, key: DeviceKey) -> Res {
        let pipes = Pipes::new(device, queue);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("voidmesh composite"),
            source: wgpu::ShaderSource::Wgsl(format!("{CLIP_WGSL}\n{}", include_str!("../shaders/composite.wgsl")).into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("voidmesh composite"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("voidmesh composite"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: std::mem::size_of::<Slot>() as u32,
        });
        let blank_tex = process::upload(device, queue, 1, 1, &[0, 0, 0, 0]);
        let blank = composite_bind(device, &layout, &blank_tex.create_view(&Default::default()), &pipes.sampler);
        Res { key, pipes, layout, pipeline_layout, module, entity: HashMap::new(), grid: HashMap::new(), lens: HashMap::new(), picker: HashMap::new(), blank }
    }

    fn ensure(&mut self, device: &wgpu::Device, format: wgpu::TextureFormat) {
        if self.entity.contains_key(&format) {
            return;
        }
        let make = |entry: &str, blend: Option<wgpu::BlendState>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&self.pipeline_layout),
                vertex: wgpu::VertexState { module: &self.module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
                fragment: Some(wgpu::FragmentState {
                    module: &self.module,
                    entry_point: Some(entry),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend, write_mask: wgpu::ColorWrites::ALL })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let blend = Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING);
        self.entity.insert(format, make("fs_entity", blend));
        self.grid.insert(format, make("fs_grid", blend));
        self.lens.insert(format, make("fs_lens", blend));
        use crate::ui::palette_editor::{ALPHA_MARK, AREA_MARK, HUE_MARK};
        for (mark, entry) in [(AREA_MARK, "fs_area"), (HUE_MARK, "fs_hue"), (ALPHA_MARK, "fs_alpha")] {
            self.picker.insert((format, mark), make(entry, blend));
        }
    }
}
