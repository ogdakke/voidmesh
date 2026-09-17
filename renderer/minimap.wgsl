struct MinimapUniforms {
    screen: vec4f,       // center.xy, halfSize.xy px
    worldMinSize: vec4f, // min.xy, size.xy world coords
    viewportRect: vec4f, // x, y, width, height in world coords
    colors0: vec4f,      // map background rgb, opacity
    colors1: vec4f,      // entity rgb, entity opacity
    lens0: vec4f,        // resolution.xy, strength, edge width
    lens1: vec4f,        // falloff, dispersion, scale, reflection intensity
    lens2: vec4f,        // reflection focus, occlusion, vignette, backdrop blur
    shape: vec4f,        // border radius px, entityCount, padding
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> minimap: MinimapUniforms;
@group(0) @binding(3) var entityMap: texture_2d<f32>;

struct EntityMapUniforms {
    worldMinSize: vec4f,
}

struct EntityMapVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) selected: f32,
}

@group(0) @binding(4) var<uniform> entityMapUniforms: EntityMapUniforms;

@vertex
fn vs_entity_map(
    @builtin(vertex_index) vertexIndex: u32,
    @location(0) rect: vec4f,
    @location(1) selected: f32,
) -> EntityMapVertexOutput {
    var corners = array<vec2f, 6>(
        vec2f(-1.0, -1.0),
        vec2f(1.0, -1.0),
        vec2f(-1.0, 1.0),
        vec2f(-1.0, 1.0),
        vec2f(1.0, -1.0),
        vec2f(1.0, 1.0)
    );
    let a = (rect.xy - entityMapUniforms.worldMinSize.xy) /
        max(entityMapUniforms.worldMinSize.zw, vec2f(1.0)) * 2.0 - vec2f(1.0);
    let b = (rect.xy + rect.zw - entityMapUniforms.worldMinSize.xy) /
        max(entityMapUniforms.worldMinSize.zw, vec2f(1.0)) * 2.0 - vec2f(1.0);
    let center = (a + b) * 0.5;
    let halfSize = max(abs(b - a) * 0.5, vec2f(0.006));
    let orbPosition = center + corners[vertexIndex] * halfSize;

    var output: EntityMapVertexOutput;
    output.position = vec4f(orbPosition.x, -orbPosition.y, 0.0, 1.0);
    output.selected = selected;
    return output;
}

@fragment
fn fs_entity_map(input: EntityMapVertexOutput) -> @location(0) vec4f {
    return vec4f(1.0, input.selected, 0.0, 1.0);
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
    var positions = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f(3.0, -1.0),
        vec2f(-1.0, 3.0)
    );
    return vec4f(positions[vertexIndex], 0.0, 1.0);
}

fn sdBox(p: vec2f, b: vec2f) -> f32 {
    let q = abs(p) - b;
    return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

fn sdRoundRect(p: vec2f, halfSize: vec2f, radius: f32) -> f32 {
    let r = min(radius, min(halfSize.x, halfSize.y));
    let q = abs(p) - halfSize + vec2f(r);
    return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn signNotZero(v: vec2f) -> vec2f {
    return select(vec2f(-1.0), vec2f(1.0), v >= vec2f(0.0));
}

fn roundRectNormal(p: vec2f, halfSize: vec2f, radius: f32) -> vec2f {
    let eps = 1.0;
    let dx = sdRoundRect(p + vec2f(eps, 0.0), halfSize, radius) -
              sdRoundRect(p - vec2f(eps, 0.0), halfSize, radius);
    let dy = sdRoundRect(p + vec2f(0.0, eps), halfSize, radius) -
              sdRoundRect(p - vec2f(0.0, eps), halfSize, radius);
    return normalize(select(vec2f(0.0, -1.0), vec2f(dx, dy), abs(dx) + abs(dy) > 0.0001));
}

fn worldToOrb(world: vec2f) -> vec2f {
    let local = (world - minimap.worldMinSize.xy) / max(minimap.worldMinSize.zw, vec2f(1.0));
    return local * 2.0 - vec2f(1.0);
}

fn rectAlpha(rect: vec4f, orb: vec2f, feather: f32) -> f32 {
    let a = worldToOrb(rect.xy);
    let b = worldToOrb(rect.xy + rect.zw);
    let center = (a + b) * 0.5;
    let halfSize = max(abs(b - a) * 0.5, vec2f(0.006));
    let d = sdBox(orb - center, halfSize);
    return 1.0 - smoothstep(0.0, feather, d);
}

fn edgeMask(shapeDistance: f32, minHalfSize: f32) -> f32 {
    let inward = clamp(-shapeDistance / max(minHalfSize, 1.0), 0.0, 1.0);
    return pow(1.0 - smoothstep(0.0, minimap.lens0.w, inward), minimap.lens1.x);
}

fn warpedScreenUv(
    fragCoord: vec2f,
    local: vec2f,
    shapeNormal: vec2f,
    shapeDistance: f32,
    minHalfSize: f32,
    channelOffset: f32,
) -> vec2f {
    let edge = edgeMask(shapeDistance, minHalfSize);
    let dist = length(local);
    let dir = shapeNormal;
    let rollPx = dir * edge * edge * minimap.lens0.z * minHalfSize * 0.32;
    let bulgePx = -local * (1.0 - smoothstep(0.0, 0.92, dist)) * minimap.lens0.z * minHalfSize * 0.055;
    let chromaPx = dir * channelOffset * edge * edge * minHalfSize * 0.018;
    let samplePx = fragCoord - rollPx + bulgePx - chromaPx;
    return clamp(samplePx / max(minimap.lens0.xy, vec2f(1.0)), vec2f(0.0), vec2f(1.0));
}

fn sampleBackdrop(uv: vec2f) -> vec4f {
    let blur = minimap.lens2.w;
    if blur <= 0.001 {
        return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
    }

    let dims = vec2f(textureDimensions(inputTexture));
    let px = blur / max(dims, vec2f(1.0));
    return textureSampleLevel(inputTexture, inputSampler, uv, 0.0) * 0.36 +
        textureSampleLevel(inputTexture, inputSampler, clamp(uv + vec2f(px.x, 0.0), vec2f(0.0), vec2f(1.0)), 0.0) * 0.16 +
        textureSampleLevel(inputTexture, inputSampler, clamp(uv - vec2f(px.x, 0.0), vec2f(0.0), vec2f(1.0)), 0.0) * 0.16 +
        textureSampleLevel(inputTexture, inputSampler, clamp(uv + vec2f(0.0, px.y), vec2f(0.0), vec2f(1.0)), 0.0) * 0.16 +
        textureSampleLevel(inputTexture, inputSampler, clamp(uv - vec2f(0.0, px.y), vec2f(0.0), vec2f(1.0)), 0.0) * 0.16;
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
    let center = minimap.screen.xy;
    let halfSize = max(minimap.screen.zw, vec2f(1.0));
    let minHalfSize = min(halfSize.x, halfSize.y);
    let cornerRadius = clamp(minimap.shape.x, 0.0, minHalfSize);
    let fromCenterPx = fragCoord.xy - center;
    let local = fromCenterPx / halfSize;
    let dist = length(local);
    let shapeDistance = sdRoundRect(fromCenterPx, halfSize, cornerRadius);

    if shapeDistance > 0.0 {
        let shadowOffset = vec2f(minHalfSize * 0.2, minHalfSize * 0.4);
        let shadowDistance = sdRoundRect(fragCoord.xy - center - shadowOffset, halfSize, cornerRadius);
        let shadowAlpha = (1.0 - smoothstep(0.0, minHalfSize * 0.5, shadowDistance)) * 0.02;
        if shadowAlpha <= 0.001 {
            discard;
        }
        return vec4f(0.0, 0.0, 0.0, shadowAlpha);
    }

    let inside = 1.0 - smoothstep(-1.0, 0.0, shapeDistance);

    let edge = edgeMask(shapeDistance, minHalfSize);
    let rim = edge * inside;

    let normal2 = roundRectNormal(fromCenterPx, halfSize, cornerRadius);
    let glassWarp = normal2 * edge * edge * 0.16;
    let sampleOrb = local - glassWarp;

    let dispersion = minimap.lens1.y;
    let uvR = warpedScreenUv(fragCoord.xy, local, normal2, shapeDistance, minHalfSize, dispersion);
    let uvG = warpedScreenUv(fragCoord.xy, local, normal2, shapeDistance, minHalfSize, 0.0);
    let uvB = warpedScreenUv(fragCoord.xy, local, normal2, shapeDistance, minHalfSize, -dispersion);
    let r = sampleBackdrop(uvR).r;
    let gSample = sampleBackdrop(uvG);
    let b = sampleBackdrop(uvB).b;

    let vignette = 1.0 - edge * minimap.lens0.z * minimap.lens2.z;
    var color = vec3f(r, gSample.g, b) * vignette;
    var alpha = inside;

    let mapPane = minimap.colors0.rgb;
    color = mix(color, mapPane, minimap.colors0.a * inside);

    let entityUv = clamp((sampleOrb + vec2f(1.0)) * 0.5, vec2f(0.0), vec2f(1.0));
    let entitySample = textureSampleLevel(entityMap, inputSampler, entityUv, 0.0);
    let entityAlpha = clamp(entitySample.r, 0.0, 1.0);
    color = mix(color, minimap.colors1.rgb, entityAlpha * minimap.colors1.a);

    let selectedFill = clamp(entitySample.g, 0.0, 1.0);
    let selectedColor = vec3f(0.98, 0.98, 0.92);
    color = mix(color, selectedColor, selectedFill * 0.72);

    let feather = 1.25 / max(minHalfSize, 1.0);
    let viewportFill = rectAlpha(minimap.viewportRect, sampleOrb, feather);
    let viewportOuter = rectAlpha(minimap.viewportRect, sampleOrb, feather * 1.6);
    let viewportBorder = max(viewportOuter - viewportFill, 0.0);
    let viewportFillColor = vec3f(0.12, 0.12, 0.12);
    let viewportBorderColor = vec3f(0.0, 0.5, 1.0);
    color = mix(color, viewportFillColor, viewportFill * 0.04);
    color = mix(color, viewportBorderColor, viewportBorder * 0.9);

    let lightDirection = normalize(vec3f(-0.38, -0.62, 0.9));
    let surfaceNormal = normalize(vec3f(-normal2 * edge * minimap.lens0.z * 0.92, 1.0));
    let reflectionPower = mix(8.0, 96.0, clamp(minimap.lens2.x, 0.0, 1.0));
    let specular = pow(max(dot(surfaceNormal, lightDirection), 0.0), reflectionPower) * edge * edge;

    let shadowSide = 1.0 - max(dot(surfaceNormal, lightDirection), 0.0);
    let occlusion = clamp(minimap.lens2.y, 0.0, 1.0) * pow(edge, 3.0) * (0.55 + shadowSide * 0.45);
    color *= 1.0 - occlusion * 0.96;

    let reflectionMask = clamp(minimap.lens1.w, 0.0, 1.0) * pow(edge, 2.35) * (0.16 + specular * 0.86);
    let uvNormal = normal2 / max(minimap.lens0.xy / max(minimap.lens0.y, 1.0), vec2f(1.0));
    let nearUv1 = clamp(uvG - uvNormal * edge * 0.095, vec2f(0.0), vec2f(1.0));
    let nearUv2 = clamp(uvG - uvNormal * edge * 0.19, vec2f(0.0), vec2f(1.0));
    let nearUv3 = clamp(uvG - uvNormal * edge * 0.34, vec2f(0.0), vec2f(1.0));
    let localRadiance = (gSample.rgb * 0.45 +
    sampleBackdrop(nearUv1).rgb * 0.9 +
    sampleBackdrop(nearUv2).rgb * 1.05 +
    sampleBackdrop(nearUv3).rgb * 0.72) / 3.12;
    let radianceLuma = dot(localRadiance, vec3f(0.2126, 0.7152, 0.0722));
    let brightRolloff = 1.0 - smoothstep(0.62, 1.0, radianceLuma) * 0.42;
    color += localRadiance * reflectionMask * (radianceLuma * 1.45 * brightRolloff);
    color += vec3f(1.0) * (specular * minimap.lens1.w * 0.18);
    color += vec3f(1.0) * rim * 0.018;

    return vec4f(color, alpha);
}
