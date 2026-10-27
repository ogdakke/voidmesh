struct ViewportUniforms {
    matrix_row0: vec4f,
    matrix_row1: vec4f,
    matrix_row2: vec4f,
    resolution: vec2f,
    zoom: f32,
    _padding: f32,
}

struct DebugRect {
    position: vec2f,
    size: vec2f,
    color: vec4f,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<storage, read> debugRects: array<DebugRect>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) size: vec2f,
    @location(2) @interpolate(flat) color: vec4f,
}

fn quadVertex(index: u32) -> vec2f {
    let vertices = array<vec2f, 6>(
        vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
        vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
    );
    return vertices[index];
}

@vertex
fn vs_main(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
    let rect = debugRects[instanceIndex];
    let uv = quadVertex(vertexIndex);
    let world = rect.position + uv * rect.size;
    var output: VertexOutput;
    output.position = vec4f(
        viewport.matrix_row0.x * world.x + viewport.matrix_row1.x * world.y + viewport.matrix_row2.x,
        viewport.matrix_row0.y * world.x + viewport.matrix_row1.y * world.y + viewport.matrix_row2.y,
        0.0,
        1.0,
    );
    output.uv = uv;
    output.size = rect.size;
    output.color = rect.color;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    let edge = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
    let edgePx = edge * min(input.size.x, input.size.y) * viewport.zoom;
    let line = 1.0 - smoothstep(1.25, 2.25, edgePx);
    if (line < 0.01) { discard; }
    return vec4f(input.color.rgb, input.color.a * line);
}
