// Slug text vertex shader adapted for voidmesh viewport matrix
// Based on Eric Lengyel's Slug algorithm (MIT License, 2017)

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
    return SlugUnpackResult(bnd, vgly);
}

struct ViewportUniforms {
    matrix_row0: vec4f,
    matrix_row1: vec4f,
    matrix_row2: vec4f,
    resolution: vec2f,
    zoom: f32,
    _padding: f32,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;

struct VertexInput {
    @location(0) pos: vec4<f32>,
    @location(1) tex: vec4<f32>,
    @location(2) jac: vec4<f32>,
    @location(3) bnd: vec4<f32>,
    @location(4) col: vec4<f32>,
};

struct VertexStruct {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) texcoord: vec2<f32>,
    @location(2) @interpolate(flat) banding: vec4<f32>,
    @location(3) @interpolate(flat) glyph: vec4<i32>,
};

@vertex
fn main(attrib: VertexInput) -> VertexStruct {
    var vresult: VertexStruct;

    // Dilate glyph quad outward by ~1 pixel to prevent edge clipping.
    // Expand along the vertex normal in world space, then adjust
    // em-space coords via the inverse Jacobian.
    let n = normalize(attrib.pos.zw);
    let pixelSize = 1.0 / viewport.zoom;
    let d = n * pixelSize;

    let worldPos = attrib.pos.xy + d;
    vresult.texcoord = vec2<f32>(
        attrib.tex.x + dot(d, attrib.jac.xy),
        attrib.tex.y + dot(d, attrib.jac.zw)
    );

    // Apply viewport transform (world to clip space)
    let m0 = viewport.matrix_row0;
    let m1 = viewport.matrix_row1;
    let m2 = viewport.matrix_row2;

    let clipPos = vec2f(
        m0.x * worldPos.x + m1.x * worldPos.y + m2.x,
        m0.y * worldPos.x + m1.y * worldPos.y + m2.y
    );

    vresult.position = vec4f(clipPos, 0.0, 1.0);

    // Unpack glyph metadata
    let unpackResult = SlugUnpack(attrib.tex, attrib.bnd);
    vresult.banding = unpackResult.vbnd;
    vresult.glyph = unpackResult.vgly;
    vresult.color = attrib.col;
    return vresult;
}
