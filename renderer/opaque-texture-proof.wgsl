// Immutable preview textures only. Opacity is proved from every actual texel.
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> opaque: atomic<u32>;
var<workgroup> transparent: atomic<u32>;

@compute @workgroup_size(16, 16)
fn proveOpacity(@builtin(global_invocation_id) pixel: vec3u, @builtin(local_invocation_index) lane: u32) {
  if (lane == 0u) { atomicStore(&transparent, 0u); }
  workgroupBarrier();
  if (all(pixel.xy < textureDimensions(source))) {
    if (textureLoad(source, pixel.xy, 0).a != 1.0) { atomicStore(&transparent, 1u); }
  }
  workgroupBarrier();
  if (lane == 0u && atomicLoad(&transparent) != 0u) { atomicStore(&opaque, 0u); }
}
