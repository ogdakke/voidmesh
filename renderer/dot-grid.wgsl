// Dot grid background shader for infinite canvas
// Renders a two-level repeating dot pattern with smooth crossfade between levels

struct GridUniforms {
  resolution: vec2f,      // Canvas dimensions in pixels
  offset: vec2f,          // Viewport offset in world coordinates
  zoom: f32,              // Current zoom level
  fineGridSize: f32,      // Current fine (minor) grid spacing in world units
  dotSize: f32,           // Dot radius in physical pixels (pre-multiplied by DPR)
  fadeFactor: f32,        // 0..1 crossfade for minor dots (0=invisible, 1=fully visible)
  backgroundColor: vec4f, // Background color RGBA
  dotColor: vec4f,        // Dot color RGBA
}

// Subdivision factor — coarse grid = fine grid * N
const N: f32 = 5.0;

@group(0) @binding(0) var<uniform> uniforms: GridUniforms;

// Vertex shader - generates a fullscreen triangle
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  // Positions for a triangle that covers the entire clip space
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

// Fragment shader - computes two-level dot pattern per-pixel
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  // Convert screen position to world coordinates
  let screenPos = fragCoord.xy;
  let worldPos = screenPos / uniforms.zoom + uniforms.offset;

  let dotRadius = uniforms.dotSize;
  let coarseGridSize = uniforms.fineGridSize * N;

  // Distance to nearest MAJOR (coarse) grid dot (at integer multiples of coarseGridSize)
  let majorGridPos = fract(worldPos / coarseGridSize + 0.5) - 0.5;
  let distMajor = length(majorGridPos) * coarseGridSize * uniforms.zoom;
  let majorAlpha = 1.0 - smoothstep(dotRadius - 0.5, dotRadius + 0.5, distMajor);

  // Distance to nearest MINOR (fine) grid dot (at integer multiples of fineGridSize)
  let minorGridPos = fract(worldPos / uniforms.fineGridSize + 0.5) - 0.5;
  let distMinor = length(minorGridPos) * uniforms.fineGridSize * uniforms.zoom;
  let minorAlpha = 1.0 - smoothstep(dotRadius - 0.5, dotRadius + 0.5, distMinor);

  // Minor-only contribution (subtract major to avoid double-counting shared positions)
  let minorOnlyAlpha = max(0.0, minorAlpha - majorAlpha);

  // Major dots always visible; minor-only dots fade with fadeFactor
  let alpha = majorAlpha + minorOnlyAlpha * uniforms.fadeFactor;

  // Blend dot color with background based on alpha
  let bgPremult = uniforms.backgroundColor.rgb * uniforms.backgroundColor.a;
  let dotPremult = uniforms.dotColor.rgb * uniforms.dotColor.a;

  let outRgb = mix(bgPremult, dotPremult, alpha);
  let outAlpha = mix(uniforms.backgroundColor.a, uniforms.dotColor.a, alpha);

  return vec4f(outRgb, outAlpha);
}
