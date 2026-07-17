struct LensUniforms {
    resolution: vec2f,
    strength: f32,
    radius: f32,
    falloff: f32,
    dispersion: f32,
    scale: f32,
    reflectionIntensity: f32,
    reflectionFocus: f32,
    occlusion: f32,
    vignette: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> lens: LensUniforms;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let uv = vec2f(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
    var out: VertexOutput;
    out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2f(uv.x, 1.0 - uv.y);
    return out;
}

fn lensCornerRadiusPx() -> f32 {
    let minDimension = min(lens.resolution.x, lens.resolution.y);
    let edgeWidthPx = lens.radius * minDimension * 0.5;
    let maxRadiusPx = min(32.0, minDimension * 0.045);
    return clamp(edgeWidthPx * 0.18, 8.0, maxRadiusPx);
}

fn lensSuperellipsePower() -> f32 {
    let minDimension = min(lens.resolution.x, lens.resolution.y);
    let maxRadiusPx = min(32.0, minDimension * 0.045);
    let radiusT = clamp((lensCornerRadiusPx() - 8.0) / max(maxRadiusPx - 8.0, 1.0), 0.0, 1.0);
    return mix(24.0, 5.0, radiusT);
}

fn superellipseMeasure(p: vec2f, halfSize: vec2f, power: f32) -> f32 {
    let n = abs(p) / max(halfSize, vec2f(0.0001));
    return pow(pow(n.x, power) + pow(n.y, power), 1.0 / power);
}

fn superellipseNormal(p: vec2f, halfSize: vec2f, power: f32) -> vec2f {
    let signP = select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0));
    let n = max(abs(p) / max(halfSize, vec2f(0.0001)), vec2f(0.0001));
    let grad = pow(n, vec2f(power - 1.0)) / max(halfSize, vec2f(0.0001));
    return normalize(signP * grad);
}

fn edgeMaskFromCenter(fromCenter: vec2f, halfSize: vec2f, power: f32) -> f32 {
    let measure = superellipseMeasure(fromCenter, halfSize, power);
    let normalizedDistance = clamp(1.0 - measure, 0.0, 1.0);
    return pow(1.0 - smoothstep(0.0, lens.radius, normalizedDistance), lens.falloff);
}

fn edgeMask(uv: vec2f, aspect: f32) -> f32 {
    let fromCenter = (uv - vec2f(0.5)) * vec2f(aspect, 1.0);
    let halfSize = vec2f(0.5 * aspect, 0.5);
    return edgeMaskFromCenter(fromCenter, halfSize, lensSuperellipsePower());
}

fn warpedUv(uv: vec2f, channelOffset: f32) -> vec2f {
    let aspect = lens.resolution.x / max(lens.resolution.y, 1.0);
    let centered = uv - vec2f(0.5);
    let aspectCentered = centered * vec2f(aspect, 1.0);
    let halfSize = vec2f(0.5 * aspect, 0.5);
    let power = lensSuperellipsePower();
    let edge = edgeMaskFromCenter(aspectCentered, halfSize, power);

    if edge <= 0.0001 {
        return uv;
    }

    let dir = superellipseNormal(aspectCentered, halfSize, power);
    let roll = edge * edge * lens.strength * 0.18;
    let stretch = edge * lens.strength * 0.08;
    let sampleAspect = aspectCentered - dir * (roll + channelOffset * edge * 0.0035);
    let sampleCentered = sampleAspect / vec2f(aspect, 1.0);
    return clamp(vec2f(0.5) + sampleCentered * (1.0 - stretch * lens.scale), vec2f(0.0), vec2f(1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let aspect = lens.resolution.x / max(lens.resolution.y, 1.0);
    let fromCenter = (in.uv - vec2f(0.5)) * vec2f(aspect, 1.0);
    let halfSize = vec2f(0.5 * aspect, 0.5);
    let power = lensSuperellipsePower();
    let edge = edgeMaskFromCenter(fromCenter, halfSize, power);
    let dispersion = lens.dispersion * edge;

    let uvR = warpedUv(in.uv, dispersion);
    let uvG = warpedUv(in.uv, 0.0);
    let uvB = warpedUv(in.uv, -dispersion);

    let r = textureSample(inputTexture, inputSampler, uvR).r;
    let gSample = textureSample(inputTexture, inputSampler, uvG);
    let b = textureSample(inputTexture, inputSampler, uvB).b;

    let vignette = 1.0 - edge * lens.strength * lens.vignette;
    var color = vec3f(r, gSample.g, b) * vignette;

    let normal2 = superellipseNormal(fromCenter, halfSize, power);
    let surfaceNormal = normalize(vec3f(-normal2 * edge * lens.strength * 0.75, 1.0));
    let lightDirection = normalize(vec3f(-0.38, -0.62, 0.9));
    let measure = superellipseMeasure(fromCenter, halfSize, power);
    let inward = clamp((1.0 - measure) / max(lens.radius, 0.0001), 0.0, 1.0);
    let edgeDepth = pow(1.0 - inward, 8.0);
    let shadowSide = 1.0 - max(dot(surfaceNormal, lightDirection), 0.0);
    let occlusion = clamp(lens.occlusion, 0.0, 1.0) * edgeDepth * (0.55 + shadowSide * 0.45);
    color *= 1.0 - occlusion * 0.96;

    let reflectionPower = mix(8.0, 96.0, clamp(lens.reflectionFocus, 0.0, 1.0));
    let specular = pow(max(dot(surfaceNormal, lightDirection), 0.0), reflectionPower) * edge * edge;
    let reflectionMask = clamp(lens.reflectionIntensity, 0.0, 1.0) * pow(edge, 2.35) * (0.18 + specular * 0.85);

    let uvNormal = normal2 / vec2f(aspect, 1.0);
    let nearUv1 = clamp(uvG - uvNormal * edge * 0.075, vec2f(0.0), vec2f(1.0));
    let nearUv2 = clamp(uvG - uvNormal * edge * 0.15, vec2f(0.0), vec2f(1.0));
    let nearUv3 = clamp(uvG - uvNormal * edge * 0.3, vec2f(0.0), vec2f(1.0));
    let localRadiance = (gSample.rgb * 0.55 +
        textureSample(inputTexture, inputSampler, nearUv1).rgb * 0.85 +
        textureSample(inputTexture, inputSampler, nearUv2).rgb * 1.1 +
        textureSample(inputTexture, inputSampler, nearUv3).rgb * 0.75) / 3.25;
    let radianceLuma = dot(localRadiance, vec3f(0.2126, 0.7152, 0.0722));
    let brightRolloff = 1.0 - smoothstep(0.62, 1.0, radianceLuma) * 0.42;
    color += localRadiance * reflectionMask * (radianceLuma * 1.45 * brightRolloff);

    return vec4f(color, gSample.a);
}
