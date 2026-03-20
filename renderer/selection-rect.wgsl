// Selection rectangle shader for drag-to-select
// Renders multiple semi-transparent rectangles with solid borders

// Maximum number of rectangles we can render in one pass
const MAX_RECTS: u32 = 4u;

// Per-rectangle data (must be 16-byte aligned)
struct RectData {
  // Rectangle bounds in world coordinates (x, y, width, height)
  rect: vec4f,
  // Fill color (RGBA, straight alpha)
  fillColor: vec4f,
  // Border color (RGBA, straight alpha)
  borderColor: vec4f,
  // Border width in screen pixels (padded to vec4 for alignment)
  borderWidth: vec4f, // only .x is used
}

struct Uniforms {
  // Canvas resolution in pixels
  resolution: vec2f,
  // Viewport offset in world coordinates
  offset: vec2f,
  // Viewport zoom level
  zoom: f32,
  // Number of active rectangles (0-4)
  rectCount: u32,
  // Padding for 16-byte alignment
  _padding: vec2f,
  // Rectangle data array
  rects: array<RectData, MAX_RECTS>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
}

// Fullscreen triangle vertex shader
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );

  var out: VertexOutput;
  out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  return out;
}

// Compute the contribution of a single rectangle at the given world position
fn computeRectColor(worldPos: vec2f, rectData: RectData) -> vec4f {
  let rectMin = rectData.rect.xy;
  let rectSize = rectData.rect.zw;

  if (rectSize.x <= 0.0 || rectSize.y <= 0.0) {
    return vec4f(0.0);
  }

  let rectMax = rectMin + rectSize;
  let bw = rectData.borderWidth.x / uniforms.zoom;

  // Outer bounds (border extends outward from rectangle edge)
  let outerMin = rectMin - vec2f(bw);
  let outerMax = rectMax + vec2f(bw);

  // Outside everything — early out
  if (worldPos.x < outerMin.x || worldPos.x > outerMax.x ||
      worldPos.y < outerMin.y || worldPos.y > outerMax.y) {
    return vec4f(0.0);
  }

  // Inside fill region
  let inFill = worldPos.x >= rectMin.x && worldPos.x <= rectMax.x &&
               worldPos.y >= rectMin.y && worldPos.y <= rectMax.y;

  let fill = rectData.fillColor;
  let border = rectData.borderColor;

  if (inFill) {
    let a = fill.a;
    return vec4f(fill.rgb * a, a);
  }

  // In border region (between outer and inner bounds)
  let a = border.a;
  return vec4f(border.rgb * a, a);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  // Use @builtin(position) directly — exact pixel coordinates, no interpolation
  let screenPos = in.position.xy;
  let worldPos = screenPos / uniforms.zoom + uniforms.offset;

  var finalColor = vec4f(0.0);

  for (var i = 0u; i < uniforms.rectCount && i < MAX_RECTS; i++) {
    let rectColor = computeRectColor(worldPos, uniforms.rects[i]);
    finalColor = rectColor + finalColor * (1.0 - rectColor.a);
  }

  if (finalColor.a < 0.001) {
    discard;
  }

  return finalColor;
}
