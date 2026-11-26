// Every entity on the canvas in one instanced draw (`scene.rs`). Prepended with rune's CLIP_WGSL.
//
// Instances hold world rects in z order; each names a material, whose table entry says where its
// processed texture is: a tile of the atlas array (state 1), or a texture of its own bound for a
// draw of its own (state 2). The camera arrives as immediates, so pan and zoom touch no buffer.

struct World {
  view: vec4f,   // pass width, height, origin x, y (window pixels)
  clip: vec4f,   // the slot's clip rectangle in window pixels
  fade: vec4u,   // the slot's packed soft edges and radii
  cam: vec4f,    // world to pass pixels: offset x, y, scale; selection ring width in pixels
  misc: vec4f,   // x: 1 = frame blends in sRGB, y: 1 = drawing own-texture materials, z: device scale,
                 // w: marquee mode (0 none, 1 replace, 2 add, 3 subtract)
  tex: vec4f,    // xy: one over the atlas's size in texels
  marquee: vec4f, // an open marquee's world rect (x0, y0, x1, y1); mode in misc.w
  drag: vec4f,   // an ongoing drag: the selection's offset in world units (xy), z = 1 while it runs
}

var<immediate> w: World;

struct Inst {
  rect: vec4f,   // world x, y, width, height
  mat: u32,
  flags: u32,    // bit0 selected, bit1 playback hairline
  progress: f32, // playback position 0–1, for the hairline
  _pad: u32,
}

struct Mat {
  tile: vec4f,   // texels in level 0: x, y, width, height of the content
  layer: u32,
  levels: u32,
  state: u32,    // 0 none yet, 1 atlas, 2 own texture
  flags: u32,    // bit0 straight alpha (an original copied from its source)
}

@group(0) @binding(0) var smp: sampler;
@group(0) @binding(1) var<storage, read> insts: array<Inst>;
@group(0) @binding(2) var<storage, read> mats: array<Mat>;
// The atlas, or for an own-texture draw that texture as a one-layer array.
@group(1) @binding(0) var atlas: texture_2d_array<f32>;

struct V {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,                      // pixels from the image's top-left
  @location(1) uv: vec2f,                         // where in the texture
  @location(2) @interpolate(flat) bounds: vec4f,  // the texture area it may read: min, max
  @location(3) @interpolate(flat) a: vec4f,       // image size in pixels, mip level, layer
  @location(4) @interpolate(flat) b: vec4f,       // flags (instance | material << 8), progress, ring, clipped
}

@vertex
fn vs_world(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> V {
  let inst = insts[ii];
  let m = mats[inst.mat];
  var o: V;
  // Off screen, or not this draw's: a degenerate triangle outside the clip volume.
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
  let want = select(1u, 2u, w.misc.y > 0.5);
  if (m.state != want) {
    return o;
  }
  let k = w.cam.z;
  // A dragged selection draws where the drag has taken it; its positions change when it ends.
  let moved = w.drag.z > 0.5 && (inst.flags & 1u) != 0u;
  let at = inst.rect.xy + select(vec2f(0.0), w.drag.xy, moved);
  let r = vec4f(at * k + w.cam.xy, inst.rect.zw * k);
  // Selected, or what an open marquee makes of it: the flags hold the selection it started from.
  var selected = (inst.flags & 1u) != 0u;
  let mode = u32(w.misc.w);
  if (mode != 0u) {
    let m = w.marquee;
    let hit = inst.rect.x < m.z && inst.rect.x + inst.rect.z > m.x && inst.rect.y < m.w && inst.rect.y + inst.rect.w > m.y;
    selected = select(select(selected || hit, selected && !hit, mode == 3u), hit, mode == 1u);
  }
  let ring = select(0.0, max(w.cam.w, 1.0), selected);
  let q = vec4f(r.xy - ring, r.zw + 2.0 * ring);
  if (q.x > w.view.x || q.y > w.view.y || q.x + q.z < 0.0 || q.y + q.w < 0.0) {
    return o;
  }
  // A strip: (0, 0), (1, 0), (0, 1), (1, 1).
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u));
  let px = q.xy + c * q.zw;
  o.pos = vec4f(px.x / w.view.x * 2.0 - 1.0, 1.0 - px.y / w.view.y * 2.0, 0.0, 1.0);
  let local = px - r.xy;
  o.local = local;
  // Texels per pixel picks the nearest level, as the web samples a tier near its screen size.
  let tpp = max(m.tile.z / max(r.z, 1e-6), m.tile.w / max(r.w, 1e-6));
  let lod = clamp(round(log2(max(tpp, 1e-6))), 0.0, f32(max(m.levels, 1u) - 1u));
  let inv = select(w.tex.xy, 1.0 / max(m.tile.zw, vec2f(1.0)), want == 2u);
  o.uv = (m.tile.xy + local / max(r.zw, vec2f(1e-6)) * m.tile.zw) * inv;
  // Half a texel of the sampled level inside the content, so filtering never reads a neighbour.
  let inset = min(vec2f(0.5 * exp2(lod)), m.tile.zw * 0.5);
  o.bounds = vec4f((m.tile.xy + inset) * inv, (m.tile.xy + m.tile.zw - inset) * inv);
  o.a = vec4f(r.zw, lod, f32(m.layer));
  // A hard-edged clip that holds the whole quad cuts nothing: skip it per fragment.
  let hard = all(w.fade == vec4u(0u));
  let win = q.xy + w.view.zw;
  let inside = all(win >= w.clip.xy) && all(win + q.zw <= w.clip.zw);
  o.b = vec4f(f32(inst.flags | (m.flags << 8u)), inst.progress, ring, select(1.0, 0.0, hard && inside));
  return o;
}

fn to_linear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

// Premultiplied, sRGB-encoded in; in the frame's encoding out.
fn encode(c: vec4f) -> vec4f {
  if (w.misc.x == 0.0 && c.a > 0.0) {
    return vec4f(to_linear(c.rgb / c.a) * c.a, c.a);
  }
  return c;
}

const RING: vec3f = vec3f(0.231, 0.510, 0.965);
const TRACK: vec4f = vec4f(0.0, 0.0, 0.0, 0.35);
const FILL: vec4f = vec4f(0.9, 0.9, 0.9, 0.9);

@fragment
fn fs_world(in: V) -> @location(0) vec4f {
  let size = in.a.xy;
  let p = in.local;
  let flags = u32(in.b.x);
  var c = textureSampleLevel(atlas, smp, clamp(in.uv, in.bounds.xy, in.bounds.zw), u32(in.a.w), in.a.z);
  if ((flags & (1u << 8u)) != 0u) {
    c = vec4f(c.rgb * c.a, c.a);
  }
  // Coverage of the image rect, antialiased on its edges.
  let d = max(-p, p - size);
  let outside = max(d.x, d.y);
  c *= clamp(0.5 - outside, 0.0, 1.0);
  // Playback position along the bottom edge, two points tall.
  if ((flags & 2u) != 0u) {
    let bar = 2.0 * w.misc.z;
    if (p.y >= size.y - bar && p.y < size.y && p.x >= 0.0 && p.x < size.x) {
      let col = select(TRACK, FILL, p.x < size.x * in.b.y);
      c = col + c * (1.0 - col.a);
    }
  }
  let ring_w = in.b.z;
  if (ring_w > 0.0) {
    // The ring sits outside the image, `ring_w` pixels wide.
    let ring = clamp(outside + 0.5, 0.0, 1.0) * clamp(ring_w - outside + 0.5, 0.0, 1.0);
    c = c + vec4f(RING, 1.0) * ring * (1.0 - c.a);
  }
  if (in.b.w != 0.0) {
    return encode(c) * clip_alpha(in.pos.xy + w.view.zw, w.clip, w.fade);
  }
  return encode(c);
}
