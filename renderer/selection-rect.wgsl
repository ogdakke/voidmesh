// Selection rectangle shader for drag-to-select
// Renders multiple semi-transparent rectangles with solid borders

// Maximum number of rectangles we can render in one pass
const MAX_RECTS: u32 = 4u;

// Per-rectangle data (must be 16-byte aligned)
struct RectData {
  // Rectangle bounds in world coordinates (x, y, width, height)
  rect: vec4f,
  // Fill color (RGBA, premultiplied alpha)
  fillColor: vec4f,
  // Border color (RGBA, premultiplied alpha)
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
  @location(0) fragCoord: vec2f,
}

// Fullscreen triangle vertex shader
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Generate fullscreen triangle covering clip space
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );

  var out: VertexOutput;
  out.position = vec4f(pos[vertexIndex], 0.0, 1.0);
  // Convert to pixel coordinates for fragment shader
  out.fragCoord = (pos[vertexIndex] * 0.5 + 0.5) * uniforms.resolution;
  // Flip Y since WebGPU has origin at top-left
  out.fragCoord.y = uniforms.resolution.y - out.fragCoord.y;
  return out;
}

// Compute the contribution of a single rectangle at the given world position
fn computeRectColor(worldPos: vec2f, rectData: RectData, aaWidth: f32) -> vec4f {
  let rectPos = rectData.rect.xy;
  let rectSize = rectData.rect.zw;

  // Skip if rectangle has no size
  if (rectSize.x <= 0.0 || rectSize.y <= 0.0) {
    return vec4f(0.0);
  }

  // Compute distance to rectangle edge (signed distance field)
  // Positive = outside, negative = inside
  let halfSize = rectSize * 0.5;
  let center = rectPos + halfSize;
  let localPos = worldPos - center;
  let d = abs(localPos) - halfSize;
  let outsideDist = length(max(d, vec2f(0.0)));
  let insideDist = min(max(d.x, d.y), 0.0);
  let dist = outsideDist + insideDist;

  // Convert border width from screen pixels to world units
  let borderWidthWorld = rectData.borderWidth.x / uniforms.zoom;

  // Compute alpha for fill (inside rectangle)
  let fillAlpha = 1.0 - smoothstep(-aaWidth, aaWidth, dist);

  // Compute alpha for border (on the edge)
  let innerEdge = -borderWidthWorld;
  let borderAlpha = smoothstep(innerEdge - aaWidth, innerEdge + aaWidth, dist)
                  * (1.0 - smoothstep(-aaWidth, aaWidth, dist));

  // Combine fill and border (border takes precedence)
  let fillContrib = rectData.fillColor * fillAlpha * (1.0 - borderAlpha);
  let borderContrib = rectData.borderColor * borderAlpha;

  return fillContrib + borderContrib;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  // Convert screen position to world coordinates
  let screenPos = in.fragCoord;
  let worldPos = screenPos / uniforms.zoom + uniforms.offset;

  // Anti-aliasing width: 1 screen pixel in world units
  let aaWidth = 1.0 / uniforms.zoom;

  // Accumulate color from all active rectangles using alpha blending
  var finalColor = vec4f(0.0);

  for (var i = 0u; i < uniforms.rectCount && i < MAX_RECTS; i++) {
    let rectColor = computeRectColor(worldPos, uniforms.rects[i], aaWidth);
    // Alpha blend: out = src + dst * (1 - src.a)
    finalColor = rectColor + finalColor * (1.0 - rectColor.a);
  }

  // Discard fully transparent pixels
  if (finalColor.a < 0.001) {
    discard;
  }

  return finalColor;
}
