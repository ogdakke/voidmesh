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
    /// Animated media keeps a texture per entity, which shows its own frame.
    Entity(u32),
}

struct Source {
    frame: usize,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    used: bool,
}

struct Res {
    key: DeviceKey,
    pipes: Pipes,
    layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    module: wgpu::ShaderModule,
    entity: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    grid: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    lens: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
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
            self.entities.clear();
            self.res = Some(Res::new(device, queue, key));
        }
        let Some(res) = self.res.as_mut() else { return };

        // Process what changed.
        for s in self.sources.values_mut() {
            s.used = false;
        }
        for e in self.entities.values_mut() {
            e.used = false;
        }
        let dark = f.rt.env.system_dark;
        let device_scale = f.rt.env.scale;
        let state = &mut f.rt.state;
        state.device_scale = device_scale;
        for e in &state.entities {
            let asset = &e.asset;
            let frame = asset.frame_at(e.play_t);
            let skey = if asset.animated() { SrcKey::Entity(e.id) } else { SrcKey::Asset(asset.id) };
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
                gpu.proc.run(device, queue, f.encoder, &res.pipes, &src.view, (asset.width, asset.height), &e.params, e.fx_t as f32);
                gpu.proc.key = k;
            }
        }
        self.sources.retain(|_, s| s.used);
        self.entities.retain(|_, e| e.used);
        self.animating = state.animating();

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
        Res { key, pipes, layout, pipeline_layout, module, entity: HashMap::new(), grid: HashMap::new(), lens: HashMap::new(), blank }
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
    }
}
