// ===================================================
// Reference vertex shader for the Slug algorithm ported to WGSL
// This code is made available under the MIT License.
// Copyright 2017, by Eric Lengyel.
// ===================================================

// The per-vertex input data consists of 5 attributes all having 4 floating-point components:
//
// 0 - pos
// 1 - tex
// 2 - jac
// 3 - bnd
// 4 - col

// pos.xy = object-space vertex coordinates.
// pos.zw = object-space normal vector.

// tex.xy = em-space sample coordinates.

// tex.z = location of glyph data in band texture (interpreted as integer):

// | 31                         24 | 23                         16 | 15                          8 | 7                           0 |
// +---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+
// |           y coordinate of glyph data in band texture          |           x coordinate of glyph data in band texture          |
// +---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+

// tex.w = max band indexes and flags (interpreted as integer):

// | 31                         24 | 23                         16 | 15                          8 | 7                           0 |
// +---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+
// | 0   0   0 | E | 0   0   0   0 |           band max y          | 0   0   0   0   0   0   0   0 |           band max x          |
// +---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+---+

// jac = inverse Jacobian matrix entries (00, 01, 10, 11).
// bnd = (band scale x, band scale y, band offset x, band offset y).
// col = vertex color (red, green, blue, alpha).

struct SlugUnpackResult {
    vbnd: vec4<f32>,
    vgly: vec4<i32>,
}

fn SlugUnpack(tex: vec4<f32>, bnd: vec4<f32>) -> SlugUnpackResult {
    let g = vec2<u32>(bitcast<u32>(tex.z), bitcast<u32>(tex.w));
    let vgly = vec4<i32>(
        i32(g.x & 0xFFFFu),
        i32(g.x >> 16u),
        i32(g.y & 0xFFFFu),
        i32(g.y >> 16u)
    );
    let vbnd = bnd;
    return SlugUnpackResult(vbnd, vgly);
}

struct SlugDilateResult {
    texcoord: vec2<f32>,
    vpos: vec2<f32>,
}

fn SlugDilate(pos: vec4<f32>, tex: vec4<f32>, jac: vec4<f32>, m0: vec4<f32>, m1: vec4<f32>, m3: vec4<f32>, dim: vec2<f32>) -> SlugDilateResult {
    let n = normalize(pos.zw);
    let s = dot(m3.xy, pos.xy) + m3.w;
    let t = dot(m3.xy, n);

    let u = (s * dot(m0.xy, n) - t * (dot(m0.xy, pos.xy) + m0.w)) * dim.x;
    let v = (s * dot(m1.xy, n) - t * (dot(m1.xy, pos.xy) + m1.w)) * dim.y;

    let s2 = s * s;
    let st = s * t;
    let uv = u * u + v * v;
    let d = pos.zw * (s2 * (st + sqrt(uv)) / (uv - st * st));

    let vpos = pos.xy + d;
    let texcoord = vec2<f32>(tex.x + dot(d, jac.xy), tex.y + dot(d, jac.zw));
    return SlugDilateResult(texcoord, vpos);
}

struct ParamStruct {
    slug_matrix: array<vec4<f32>, 4>,                // The four rows of the MVP matrix.
    slug_viewport: vec4<f32>,                        // The viewport dimensions, in pixels.
    text_color: vec4<f32>,                           // Per-draw text color.
};

@group(0) @binding(0) var<uniform> params: ParamStruct;

struct VertexInput {
    @location(0) pos: vec4<f32>,                     // attrib[0]
    @location(1) tex: vec4<f32>,                     // attrib[1]
    @location(2) jac: vec4<f32>,                     // attrib[2]
    @location(3) bnd: vec4<f32>,                     // attrib[3]
    @location(4) col: vec4<f32>,                     // attrib[4]
};

struct VertexStruct {
    @builtin(position) position: vec4<f32>,              // Clip-space vertex position.
    @location(0) color: vec4<f32>,                       // Vertex color.
    @location(1) texcoord: vec2<f32>,                    // Em-space sample coordinates.
    @location(2) @interpolate(flat) banding: vec4<f32>,  // Band scale and offset, constant over glyph.
    @location(3) @interpolate(flat) glyph: vec4<i32>,    // (glyph data x coord, glyph data y coord, band max x, band max y and flags), constant over glyph.
};

@vertex
fn main(attrib: VertexInput) -> VertexStruct {
    var vresult: VertexStruct;

    // Apply dynamic dilation to vertex position. Returns new em-space sample position.

    let dilateResult = SlugDilate(attrib.pos, attrib.tex, attrib.jac, params.slug_matrix[0], params.slug_matrix[1], params.slug_matrix[3], params.slug_viewport.xy);
    vresult.texcoord = dilateResult.texcoord;
    let p = dilateResult.vpos;

    // Apply MVP matrix to dilated vertex position.

    vresult.position.x = p.x * params.slug_matrix[0].x + p.y * params.slug_matrix[0].y + params.slug_matrix[0].w;
    vresult.position.y = p.x * params.slug_matrix[1].x + p.y * params.slug_matrix[1].y + params.slug_matrix[1].w;
    vresult.position.z = p.x * params.slug_matrix[2].x + p.y * params.slug_matrix[2].y + params.slug_matrix[2].w;
    vresult.position.w = p.x * params.slug_matrix[3].x + p.y * params.slug_matrix[3].y + params.slug_matrix[3].w;

    // Unpack or pass through remaining vertex data.

    let unpackResult = SlugUnpack(attrib.tex, attrib.bnd);
    vresult.banding = unpackResult.vbnd;
    vresult.glyph = unpackResult.vgly;
    _ = attrib.col;
    vresult.color = params.text_color;
    return vresult;
}
