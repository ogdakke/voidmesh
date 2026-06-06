struct Uniforms {
  resolutionAndOrigin: vec4f,
  graphAndRing: vec4f,
  scaleAndPadding: vec4f,
  foreground: vec4f,
  background: vec4f,
  grid: vec4f,
  fill: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> samples: array<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
}

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

fn composite(over: vec4f, under: vec4f) -> vec4f {
  return over + under * (1.0 - over.a);
}

fn sampleAt(column: u32, sampleCount: u32, latestIndex: u32) -> f32 {
  let capacity = arrayLength(&samples);
  if (sampleCount == 0u || capacity == 0u) {
    return 0.0;
  }

  let count = min(sampleCount, capacity);
  let oldest = select(0u, latestIndex, count == capacity);
  let index = (oldest + min(column, count - 1u)) % capacity;
  return samples[index];
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let pixel = in.position.xy;
  let resolution = uniforms.resolutionAndOrigin.xy;
  let graphOrigin = uniforms.resolutionAndOrigin.zw;
  let graphSize = uniforms.graphAndRing.xy;
  let sampleCount = u32(uniforms.graphAndRing.z);
  let latestIndex = u32(uniforms.graphAndRing.w);
  let scaleMax = max(uniforms.scaleAndPadding.x, 1.0);
  let graphMax = graphOrigin + graphSize;

  var color = uniforms.background;

  let insideGraph =
    pixel.x >= graphOrigin.x &&
    pixel.y >= graphOrigin.y &&
    pixel.x < graphMax.x &&
    pixel.y < graphMax.y;

  if (!insideGraph) {
    return color;
  }

  let local = pixel - graphOrigin;
  let bottom = graphSize.y - 1.0;
  let topLine = abs(local.y - 0.5) < 0.75;
  let midLine = abs(local.y - graphSize.y * 0.5) < 0.55;
  let sixtyLineY = graphSize.y - clamp(60.0 / scaleMax, 0.0, 1.0) * graphSize.y;
  let sixtyLine = abs(local.y - sixtyLineY) < 0.55;

  if (topLine || midLine || sixtyLine) {
    color = composite(uniforms.grid, color);
  }

  if (sampleCount == 0u) {
    return color;
  }

  let sampleSpan = max(f32(sampleCount), 1.0);
  let column = min(u32(floor((local.x / max(graphSize.x, 1.0)) * sampleSpan)), sampleCount - 1u);
  let value = sampleAt(column, sampleCount, latestIndex);
  let normalized = clamp(value / scaleMax, 0.0, 1.0);
  let filledFromY = graphSize.y - normalized * graphSize.y;
  let edge = abs(local.y - filledFromY) < 1.0;

  if (local.y >= filledFromY && local.y <= bottom) {
    color = composite(uniforms.fill, color);
  }

  if (edge) {
    color = composite(uniforms.foreground, color);
  }

  _ = resolution;
  return color;
}
