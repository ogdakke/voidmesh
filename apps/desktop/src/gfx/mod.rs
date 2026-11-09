//! The compositor. Rune lays out and draws the UI; at each `El::effect` slot this paints the
//! canvas: the dot grid behind everything, and at the world slot every entity (`scene.rs`), in
//! one instanced draw from shared, preview-LOD processed textures. Processing runs before the UI
//! pass, only for what changed.

mod atlas;
mod dust;
mod export;
pub mod process;
pub mod scene;

use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use rune::compose::{Compositor, DeviceKey, Frame};
use rune::render::{EffectPhase, EffectSite, CLIP_WGSL};

use crate::state::App;
use process::Pipes;
use scene::Scene;

/// The canvas lensing slot (reads its backdrop: everything on the canvas below the chrome).
pub const LENS: u32 = 2;
/// The deletion dust layer, over the entities (`dust.rs`).
pub const DUST: u32 = 6;
/// Seconds deletion dust plays.
pub const DUST_SECONDS: f32 = dust::DISSOLVE + dust::LIFETIME;
/// Every entity, in one slot over the grid.
pub const WORLD: u32 = 7;

/// Selection ring width in points.
pub(crate) const RING_PT: f32 = 2.0;

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

struct Res {
    key: Option<DeviceKey>,
    pipes: Pipes,
    layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    module: wgpu::ShaderModule,
    /// The world texture onto the canvas.
    copy: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    grid: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    lens: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    /// The colour picker's area, hue and alpha tracks.
    picker: HashMap<(wgpu::TextureFormat, u32), wgpu::RenderPipeline>,
    /// A deleted entity's last image under the dissolve front.
    dissolve: HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    blank: wgpu::BindGroup,
}

/// An entity's own processed texture and its composite binding: deletion dust's last image.
pub struct EntityGpu {
    proc: process::Processed,
    bind: wgpu::BindGroup,
}

#[derive(Default)]
pub struct Gfx {
    res: Option<Res>,
    scene: Option<Scene>,
    exporter: export::Exporter,
    dust: Option<dust::Dust>,
    /// The world texture's composite binding, for its generation.
    world_bind: Option<(u64, wgpu::BindGroup)>,
    animating: bool,
}

impl Gfx {
    /// The canvas's counters from the last frame.
    pub fn stats(&self) -> Option<scene::Stats> {
        self.scene.as_ref().map(|s| s.stats)
    }
}

impl Compositor<App> for Gfx {
    fn features(&self) -> wgpu::Features {
        wgpu::Features::IMMEDIATES
    }

    fn animating(&self) -> bool {
        self.animating || self.exporter.busy()
    }

    fn render(&mut self, f: &mut Frame<'_, App>) {
        let started = std::time::Instant::now();
        let (device, queue, size) = (f.device, f.queue, f.size);
        let key = f.device_key();
        if self.res.as_ref().is_none_or(|r| r.key != Some(key)) {
            self.dust = None;
            let res = Res::new(device, queue, Some(key));
            self.scene = Some(Scene::new(device, &res.pipes));
            self.res = Some(res);
        }
        let (Some(res), Some(scene)) = (self.res.as_mut(), self.scene.as_mut()) else { return };

        let dark = f.rt.env.system_dark;
        let device_scale = f.rt.env.scale;
        let reduced_motion = f.rt.reduced_motion;
        let state = &mut f.rt.state;
        state.reduced_motion = reduced_motion;
        state.device_scale = device_scale;
        // Deletions turning to dust: each gets its last image, processed by itself.
        let dust = self.dust.get_or_insert_with(|| dust::Dust::new(device));
        for req in std::mem::take(&mut state.dust) {
            let Some(proc) = scene.render(device, queue, f.encoder, &res.pipes, &req.last, Some(req.size)) else { continue };
            let bind = composite_bind(device, &res.layout, &proc.view, &res.pipes.sampler);
            dust.start(device, queue, f.encoder, req.entity, req.rect, EntityGpu { proc, bind });
        }
        dust.overlays.retain(|o| state.entity(o.entity).is_none());
        let dusting = dust.step(queue, f.encoder);

        // Exports read back the entity processed at its native resolution.
        for req in std::mem::take(&mut state.exports) {
            match state.entity(req.entity).and_then(|e| scene.render(device, queue, f.encoder, &res.pipes, e, None)) {
                Some(p) => self.exporter.request(device, f.encoder, &p.out, req.path, state.loader.clone()),
                None => state.toast("Nothing to export"),
            }
        }
        self.exporter.poll(device);

        if state.bench.as_ref().is_some_and(|b| b.dirty) {
            scene.invalidate();
        }
        scene.prepare(device, queue, f.encoder, &res.pipes, state, device_scale);
        let world_px = ((state.canvas[2] * device_scale).round() as u32, (state.canvas[3] * device_scale).round() as u32);
        res.ensure(device, scene::WORLD_FORMAT);
        let (pan, sc) = (state.cam.pan, state.cam.scale);
        let res_ref = &*res;
        let drawn = scene.world(device, f.encoder, state, world_px, device_scale, dark, &mut |pass| grid_into(res_ref, pass, world_px, pan, sc, device_scale, dark)).is_some();
        if drawn && self.world_bind.as_ref().is_none_or(|(g, _)| *g != scene.world_gen) {
            self.world_bind = scene.world_view().map(|v| (scene.world_gen, composite_bind(device, &res.layout, v, &res.pipes.sampler)));
        }
        self.animating = state.animating() || scene.video_waiting || dusting || scene.pending();

        let cam = (state.cam.pan, state.cam.scale, state.canvas);
        // For the performance overlay: entities on screen, of all.
        let counts = (scene.stats.visible, state.entities.len());
        let lens = crate::state::Lensing::preset(state.lens);
        let picked = state.picker.as_ref().map(|k| (k.oklch, crate::color::to_rgba(k.oklch)));
        for fmt in [f.format, wgpu::TextureFormat::Rgba16Float] {
            res.ensure(device, fmt);
            if let Some(d) = self.dust.as_mut() {
                d.pipeline(device, fmt);
            }
        }

        let clear = f.rt.clear_color();
        f.ui.prepare(device, queue, &mut f.rt.text.atlas, &f.rt.instances, size);
        let world_bind = self.world_bind.as_ref().map(|(_, b)| b);
        let dust = self.dust.as_ref();
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
            if site.mark == LENS {
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
            } else if site.mark == DUST {
                let Some(d) = dust else { return };
                let (Some(dissolve), Some(particles)) = (res.dissolve.get(&site.format), d.get(site.format)) else { return };
                // World to this pass's pixels, through the camera (canvas points) and the scale.
                let (pan, s, canvas) = cam;
                let dpr = site.scale;
                let k = s * dpr;
                let off = [(pan[0] + canvas[0]) * dpr - site.origin[0], (pan[1] + canvas[1]) * dpr - site.origin[1]];
                let view = dust::View { k, srgb: base.b[0], pad: [0.0; 2], offset: off, size: [site.size[0] as f32, site.size[1] as f32] };
                for o in &d.overlays {
                    let p = o.progress();
                    if p > 0.0 && p < 1.0 {
                        let r = o.rect;
                        let slot = Slot { rect: [r[0] * k + off[0], r[1] * k + off[1], r[2] * k, r[3] * k], a: [p, o.seed, 0.0, 0.0], ..base };
                        pass.set_pipeline(dissolve);
                        pass.set_bind_group(0, Some(&o.gpu.bind), &[]);
                        pass.set_immediates(0, bytemuck::bytes_of(&slot));
                        pass.draw(0..6, 0..1);
                    }
                    pass.set_pipeline(particles);
                    pass.set_bind_group(0, Some(&o.render), &[]);
                    pass.set_immediates(0, bytemuck::bytes_of(&view));
                    pass.draw(0..6, 0..dust::Dust::COUNT);
                }
            } else if site.mark == WORLD {
                // The world texture, drawn for the canvas, over the slot.
                let (Some(pipe), Some(bind)) = (res.copy.get(&site.format), world_bind) else { return };
                let slot = Slot { a: [clip_holds(i.clip, i.fade, i.rect), 0.0, 0.0, 0.0], ..base };
                pass.set_pipeline(pipe);
                pass.set_bind_group(0, Some(bind), &[]);
                pass.set_immediates(0, bytemuck::bytes_of(&slot));
                pass.draw(0..6, 0..1);
            }
        });
        f.rt.state.perf.record(started.elapsed().as_secs_f32() * 1000.0, counts.0, counts.1);
        let stats = self.stats();
        if let Some(b) = f.rt.state.bench.as_mut() {
            b.record(started, f.update_ms, started.elapsed().as_secs_f64() * 1000.0, stats);
        }
    }
}

/// The canvas alone, the grid and every entity, into an offscreen target without Rune's UI:
/// what the benchmarks time, as the web's time its renderer without React.
pub struct Direct {
    res: Res,
    pub scene: Scene,
    world_bind: Option<(u64, wgpu::BindGroup)>,
}

impl Direct {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Direct {
        let res = Res::new(device, queue, None);
        let scene = Scene::new(device, &res.pipes);
        Direct { res, scene, world_bind: None }
    }

    /// Encode a frame of `s` into `target` (`size` device pixels, `dpr` per point).
    #[allow(clippy::too_many_arguments)]
    pub fn frame(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, enc: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, format: wgpu::TextureFormat, size: (u32, u32), s: &mut App, dpr: f32) {
        if s.bench.as_ref().is_some_and(|b| b.dirty) {
            self.scene.invalidate();
        }
        self.scene.prepare(device, queue, enc, &self.res.pipes, s, dpr);
        self.res.ensure(device, format);
        self.res.ensure(device, scene::WORLD_FORMAT);
        let (pan, sc) = (s.cam.pan, s.cam.scale);
        let res = &self.res;
        let Some(view) = self.scene.world(device, enc, s, size, dpr, false, &mut |pass| grid_into(res, pass, size, pan, sc, dpr, false)).cloned() else { return };
        if self.world_bind.as_ref().is_none_or(|(g, _)| *g != self.scene.world_gen) {
            self.world_bind = Some((self.scene.world_gen, composite_bind(device, &self.res.layout, &view, &self.res.pipes.sampler)));
        }
        let (w, h) = (size.0 as f32, size.1 as f32);
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("voidmesh canvas"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
            ..Default::default()
        });
        let slot = Slot { rect: [0.0, 0.0, w, h], view: [w, h, 0.0, 0.0], clip: [0.0, 0.0, w, h], fade: [0; 4], a: [1.0, 0.0, 0.0, 0.0], b: [1.0, 0.0, 0.0, 0.0], c: [0.0; 4], d: [0.0; 4], e: [0.0; 4] };
        if let (Some(pipe), Some((_, bind))) = (self.res.copy.get(&format), self.world_bind.as_ref()) {
            pass.set_pipeline(pipe);
            pass.set_bind_group(0, Some(bind), &[]);
            pass.set_immediates(0, bytemuck::bytes_of(&slot));
            pass.draw(0..6, 0..1);
        }
    }
}

/// The grid's draw into the world texture (`size` device pixels, the canvas's top-left at 0).
fn grid_into(res: &Res, pass: &mut wgpu::RenderPass<'_>, size: (u32, u32), pan: [f32; 2], scale: f32, dpr: f32, dark: bool) {
    let Some(pipe) = res.grid.get(&scene::WORLD_FORMAT) else { return };
    let (w, h) = (size.0 as f32, size.1 as f32);
    let wpp = 1.0 / (dpr * scale);
    // Two levels of dots five times apart, the finer fading in as the zoom nears the next level.
    let lv = (1.0 / wpp).ln() / 5f32.ln();
    let level = lv.floor();
    let fine = 25.0 * 5f32.powf(-level);
    let minor = (lv - level).powi(5);
    let slot = Slot {
        rect: [0.0, 0.0, w, h],
        view: [w, h, 0.0, 0.0],
        clip: [0.0, 0.0, w, h],
        fade: [0; 4],
        a: [-pan[0] / scale, -pan[1] / scale, wpp, dpr],
        b: [1.0, if dark { 1.0 } else { 0.0 }, 0.0, 0.0],
        c: [fine, minor, 1.5 * dpr * 0.5, 0.0],
        d: [0.0; 4],
        e: [0.0; 4],
    };
    pass.set_pipeline(pipe);
    pass.set_bind_group(0, Some(&res.blank), &[]);
    pass.set_immediates(0, bytemuck::bytes_of(&slot));
    pass.draw(0..6, 0..1);
}

/// `fs_copy`'s flag: the slot's clip has hard edges and holds `rect` (window pixels).
fn clip_holds(clip: [f32; 4], fade: [u32; 4], rect: [f32; 4]) -> f32 {
    let inside = rect[0] >= clip[0] && rect[1] >= clip[1] && rect[0] + rect[2] <= clip[2] && rect[1] + rect[3] <= clip[3];
    if fade == [0; 4] && inside { 1.0 } else { 0.0 }
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
    fn new(device: &wgpu::Device, queue: &wgpu::Queue, key: Option<DeviceKey>) -> Res {
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
        Res { key, pipes, layout, pipeline_layout, module, copy: HashMap::new(), grid: HashMap::new(), lens: HashMap::new(), picker: HashMap::new(), dissolve: HashMap::new(), blank }
    }

    fn ensure(&mut self, device: &wgpu::Device, format: wgpu::TextureFormat) {
        if self.copy.contains_key(&format) {
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
        self.copy.insert(format, make("fs_copy", blend));
        self.grid.insert(format, make("fs_grid", blend));
        self.lens.insert(format, make("fs_lens", blend));
        self.dissolve.insert(format, make("fs_dissolve", blend));
        use crate::ui::palette_editor::{ALPHA_MARK, AREA_MARK, HUE_MARK};
        for (mark, entry) in [(AREA_MARK, "fs_area"), (HUE_MARK, "fs_hue"), (ALPHA_MARK, "fs_alpha")] {
            self.picker.insert((format, mark), make(entry, blend));
        }
    }
}
