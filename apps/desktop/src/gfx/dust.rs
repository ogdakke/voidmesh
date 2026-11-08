//! Deletion dust (the web's `renderer/disintegration-*`, FEATURES.md §3.4): a deleted entity's
//! processed texture becomes the snapshot a noisy front eats (`fs_dissolve`) while particles
//! spawned from its opaque pixels drift off on a wind (`dust.wgsl`). The compositor takes over
//! the entity's GPU texture when the deletion arrives, so nothing is copied, and drops it when
//! the dust has settled or an undo brings the entity back.

use std::time::Instant;

use bytemuck::{Pod, Zeroable};

use super::EntityGpu;

/// Particles per deletion.
const PARTICLES: u32 = 15_000;
/// Seconds the front takes to cross (the web's `DISSOLVE_DURATION_MS`).
pub const DISSOLVE: f32 = 2.8;
/// Seconds a particle lives once it leaves (`PARTICLE_LIFETIME_MS`).
pub const LIFETIME: f32 = 0.6;
/// Bytes per particle, as `Particle` in dust.wgsl.
const PARTICLE_SIZE: u64 = 48;

const SHADER: &str = include_str!("../shaders/dust.wgsl");

/// `Params` in dust.wgsl.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Params {
    position: [f32; 2],
    size: [f32; 2],
    seed: f32,
    count: u32,
    duration: f32,
    lifetime: f32,
    wind: [f32; 2],
    wind_strength: f32,
    scatter: f32,
    particle_size: f32,
    turbulence: f32,
    shrink: f32,
    cos_r: f32,
    sin_r: f32,
    elapsed: f32,
    dt: f32,
    wind_accel: f32,
    _pad: [f32; 4],
}

/// `View` in dust.wgsl: world to pass pixels.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct View {
    pub k: f32,
    pub srgb: f32,
    pub pad: [f32; 2],
    pub offset: [f32; 2],
    pub size: [f32; 2],
}

/// One deletion turning to dust.
pub struct Overlay {
    pub entity: u32,
    /// World rect at deletion.
    pub rect: [f32; 4],
    pub seed: f32,
    start: Instant,
    /// Seconds since `start` at the last update.
    elapsed: f32,
    /// The entity's processed texture and its composite bind group, taken over at deletion.
    pub gpu: EntityGpu,
    params: wgpu::Buffer,
    _particles: wgpu::Buffer,
    update: wgpu::BindGroup,
    pub render: wgpu::BindGroup,
}

impl Overlay {
    /// The front's progress: easeOutExpo over the dissolve, as the web's.
    pub fn progress(&self) -> f32 {
        let t = (self.elapsed / DISSOLVE).clamp(0.0, 1.0);
        if t >= 1.0 { 1.0 } else { 1.0 - 2f32.powf(-10.0 * t) }
    }

    fn done(&self) -> bool {
        self.elapsed >= DISSOLVE + LIFETIME
    }
}

pub struct Dust {
    spawn: wgpu::ComputePipeline,
    update: wgpu::ComputePipeline,
    spawn_layout: wgpu::BindGroupLayout,
    update_layout: wgpu::BindGroupLayout,
    render_layout: wgpu::BindGroupLayout,
    render_pipeline_layout: wgpu::PipelineLayout,
    render_module: wgpu::ShaderModule,
    render: std::collections::HashMap<wgpu::TextureFormat, wgpu::RenderPipeline>,
    pub overlays: Vec<Overlay>,
}

/// The prelude plus one `//@ name` section of dust.wgsl.
fn section(name: &str) -> String {
    let mut parts = SHADER.split("//@ ");
    let prelude = parts.next().unwrap_or_default();
    let body = parts.find_map(|p| p.strip_prefix(name)).unwrap_or_default();
    format!("{prelude}{body}")
}

fn entry(binding: u32, visibility: wgpu::ShaderStages, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility, ty, count: None }
}

fn buffer(ty: wgpu::BufferBindingType) -> wgpu::BindingType {
    wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None }
}

impl Dust {
    pub fn new(device: &wgpu::Device) -> Dust {
        use wgpu::{BufferBindingType as B, ShaderStages as S};
        let module = |name: &str| device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("voidmesh dust"), source: wgpu::ShaderSource::Wgsl(section(name).into()) });
        let layout = |entries: &[wgpu::BindGroupLayoutEntry]| device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("voidmesh dust"), entries });
        let spawn_layout = layout(&[
            entry(0, S::COMPUTE, buffer(B::Uniform)),
            entry(1, S::COMPUTE, wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }),
            entry(2, S::COMPUTE, buffer(B::Storage { read_only: false })),
        ]);
        let update_layout = layout(&[entry(0, S::COMPUTE, buffer(B::Uniform)), entry(1, S::COMPUTE, buffer(B::Storage { read_only: false }))]);
        let render_layout = layout(&[entry(0, S::VERTEX, buffer(B::Storage { read_only: true })), entry(1, S::VERTEX, buffer(B::Uniform))]);
        let compute = |layout: &wgpu::BindGroupLayout, name: &str| {
            let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("voidmesh dust"), bind_group_layouts: &[Some(layout)], immediate_size: 0 });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pl),
                module: &module(name),
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let spawn = compute(&spawn_layout, "spawn");
        let update = compute(&update_layout, "update");
        let render_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("voidmesh dust render"),
            bind_group_layouts: &[Some(&render_layout)],
            immediate_size: std::mem::size_of::<View>() as u32,
        });
        Dust { spawn, update, spawn_layout, update_layout, render_layout, render_pipeline_layout, render_module: module("render"), render: Default::default(), overlays: Vec::new() }
    }

    /// The particle pipeline for target `format`.
    pub fn pipeline(&mut self, device: &wgpu::Device, format: wgpu::TextureFormat) {
        if self.render.contains_key(&format) {
            return;
        }
        let p = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("voidmesh dust"),
            layout: Some(&self.render_pipeline_layout),
            vertex: wgpu::VertexState { module: &self.render_module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState {
                module: &self.render_module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        self.render.insert(format, p);
    }

    pub fn get(&self, format: wgpu::TextureFormat) -> Option<&wgpu::RenderPipeline> {
        self.render.get(&format)
    }

    /// Start entity `entity`'s dust from its GPU state (taken over), at world rect `rect`.
    pub fn start(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder, entity: u32, rect: [f32; 4], gpu: EntityGpu) {
        let seed = rand_seed(entity) * 1000.0;
        let max_dim = rect[2].max(rect[3]);
        let params = Params {
            position: [rect[0], rect[1]],
            size: [rect[2], rect[3]],
            seed,
            count: PARTICLES,
            duration: DISSOLVE,
            lifetime: LIFETIME,
            wind: [0.7, -0.4],
            wind_strength: max_dim * 0.3,
            scatter: max_dim * 0.04,
            particle_size: max_dim * 0.004,
            turbulence: max_dim * 0.08,
            shrink: 0.8,
            cos_r: 1.0,
            sin_r: 0.0,
            elapsed: 0.0,
            dt: 0.0,
            wind_accel: max_dim * 0.2,
            _pad: [0.0; 4],
        };
        let params_buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("voidmesh dust params"), size: std::mem::size_of::<Params>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        queue.write_buffer(&params_buf, 0, bytemuck::bytes_of(&params));
        let particles = device.create_buffer(&wgpu::BufferDescriptor { label: Some("voidmesh dust particles"), size: u64::from(PARTICLES) * PARTICLE_SIZE, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false });
        let level0 = gpu.proc.out.create_view(&wgpu::TextureViewDescriptor { base_mip_level: 0, mip_level_count: Some(1), ..Default::default() });
        let bind = |layout: &wgpu::BindGroupLayout, entries: &[wgpu::BindGroupEntry]| device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("voidmesh dust"), layout, entries });
        let spawn = bind(
            &self.spawn_layout,
            &[
                wgpu::BindGroupEntry { binding: 0, resource: params_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&level0) },
                wgpu::BindGroupEntry { binding: 2, resource: particles.as_entire_binding() },
            ],
        );
        let update = bind(&self.update_layout, &[wgpu::BindGroupEntry { binding: 0, resource: params_buf.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: particles.as_entire_binding() }]);
        let render = bind(&self.render_layout, &[wgpu::BindGroupEntry { binding: 0, resource: particles.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: params_buf.as_entire_binding() }]);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("voidmesh dust spawn"), timestamp_writes: None });
        pass.set_pipeline(&self.spawn);
        pass.set_bind_group(0, Some(&spawn), &[]);
        pass.dispatch_workgroups(PARTICLES.div_ceil(64), 1, 1);
        drop(pass);
        self.overlays.push(Overlay { entity, rect, seed, start: Instant::now(), elapsed: 0.0, gpu, params: params_buf, _particles: particles, update, render });
    }

    /// Advance every overlay's particles to now, dropping finished ones. True while any plays.
    pub fn step(&mut self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder) -> bool {
        self.overlays.retain(|o| !o.done());
        for o in &mut self.overlays {
            let elapsed = o.start.elapsed().as_secs_f32();
            let dt = (elapsed - o.elapsed).clamp(0.0, 0.1);
            o.elapsed = elapsed;
            // `elapsed` and `dt` sit 17 floats in.
            queue.write_buffer(&o.params, 17 * 4, bytemuck::cast_slice(&[elapsed, dt]));
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("voidmesh dust update"), timestamp_writes: None });
            pass.set_pipeline(&self.update);
            pass.set_bind_group(0, Some(&o.update), &[]);
            pass.dispatch_workgroups(PARTICLES.div_ceil(64), 1, 1);
        }
        !self.overlays.is_empty()
    }

    pub const COUNT: u32 = PARTICLES;
}

/// A seed in 0–1 that differs per deletion.
fn rand_seed(entity: u32) -> f32 {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let h = (u64::from(t) ^ (u64::from(entity) << 32)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    (h >> 40) as f32 / (1u64 << 24) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_section_builds_on_the_prelude() {
        for name in ["spawn", "update", "render"] {
            let src = section(name);
            assert!(src.contains("struct Particle") && src.contains(&format!("fn {}", if name == "render" { "vs" } else { name })), "{name}");
        }
        assert!(!section("spawn").contains("fn update"));
    }

    #[test]
    fn the_params_layout_matches_the_shader() {
        assert_eq!(std::mem::size_of::<Params>(), 96);
        assert_eq!(std::mem::offset_of!(Params, elapsed), 17 * 4);
        assert_eq!(std::mem::size_of::<View>(), 32);
    }
}
