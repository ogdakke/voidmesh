// Contact-space effects shared by image, SVG/GIF textures, and external video.
struct Contact {
  rect: vec4f, // Other card center and half size in world coordinates.
  pose: vec4f, // cos, sin, participant key, role (+lifted / -cover / 0 motion).
  metric: vec4f, // Crossing: pixel scale/depth/partner/span. Motion: pixel scale/RGB energy/wake energy/phase.
  axis: vec4f, // Separation direction away from other card; shared contact center.
}
struct Contacts {
  header: vec4f, // count, RGB strength, RGB decay progress, wake strength
  timeline: vec4f, // continuous lift depth, direction, event progress, wake decay progress
  tuning: vec4f, // RGB split in CSS pixels, wake width in CSS pixels, reserved
  items: array<Contact>,
}
@group(1) @binding(0) var<storage, read> contacts: Contacts;

fn crossingGrid(index: u32) -> vec2f {
  let corners = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(1,0), vec2f(1,1), vec2f(0,1));
  return corners[index % 6u];
}
fn contactDistance(local: vec2f, halfSize: vec2f) -> f32 {
  let q = abs(local) - halfSize;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}
fn contactNormal(local: vec2f, halfSize: vec2f) -> vec2f {
  let q = abs(local) - halfSize;
  let signXY = select(vec2f(-1.0), vec2f(1.0), local >= vec2f(0.0));
  if (q.x > 0.0 && q.y > 0.0) { return normalize(q) * signXY; }
  return select(vec2f(0.0, signXY.y), vec2f(signXY.x, 0.0), q.x > q.y);
}
fn contactRotate(v: vec2f, pose: vec2f) -> vec2f {
  return vec2f(v.x * pose.x - v.y * pose.y, v.x * pose.y + v.y * pose.x);
}
fn contactLocal(v: vec2f, pose: vec2f) -> vec2f {
  return vec2f(dot(v, pose), dot(v, vec2f(-pose.y, pose.x)));
}
struct ContactField {
  coverage: f32,
  passing: f32,
  role: f32,
  pixel: f32,
  distance: f32,
  normal: vec2f,
  rgbPulse: f32,
  wakePulse: f32,
  radius: f32,
  phase: f32,
  flow: vec2f,
  rgbFlow: vec2f,
  rgbRadius: f32,
  rgbWidth: f32,
}
// Select the strongest nearby contact. Deep stacks cannot amplify without bound.
fn crossingField(world: vec2f, key: u32) -> ContactField {
  var result: ContactField;
  var best = -1.0;
  let lift = contacts.timeline.x;
  for (var i = 0u; i < u32(contacts.header.x); i++) {
    let contact = contacts.items[i];
    if (u32(contact.pose.z) != key) { continue; }
    let local = contactLocal(world - contact.rect.xy, contact.pose.xy);
    let sd = contactDistance(local, contact.rect.zw);
    let pixel = contact.metric.x;
    let zWindow = 1.0 - smoothstep(0.02, 0.38, abs(lift - contact.metric.y));
    // Contact pressure peaks between resting layers.
    let passing = 4.0 * lift * (1.0 - lift) * max(zWindow, 0.4);
    let motion = contact.pose.w == 0.0;
    let rgbEcho = smoothstep(0.2, 0.75, contacts.timeline.z) * pow(1.0 - contacts.header.z, 2.0);
    let rgbPulse = select(passing + 0.22 * rgbEcho, contact.metric.y, motion);
    let wakePulse = select(smoothstep(0.0, 0.2, contacts.timeline.z) * pow(1.0 - contacts.timeline.w, 2.0), contact.metric.z, motion);
    let score = exp(-max(sd, 0.0) / max(120.0 * pixel, 1.0)) * max(rgbPulse, wakePulse);
    if (score <= 0.00001) { continue; }
    if (score <= best) { continue; }
    best = score;
    result.coverage = 1.0 - smoothstep(-24.0 * pixel, 24.0 * pixel, sd);
    result.passing = passing;
    result.role = select(contact.pose.w, -1.0, motion);
    result.pixel = pixel;
    result.distance = sd;
    result.normal = contactRotate(contactNormal(local, contact.rect.zw), contact.pose.xy);
    // Drag refraction comes from the advancing edge, in the direction of travel.
    // During a depth crossing both participants share one entry-to-exit direction.
    let rgbFlow = select(-contact.axis.xy * contact.pose.w * contacts.timeline.y, contact.axis.xy, motion);
    let coherence = min(length(rgbFlow), 1.0);
    let direction = rgbFlow / max(length(rgbFlow), 0.0001);
    let localDirection = contactLocal(direction, contact.pose.xy);
    let extent = dot(abs(localDirection), contact.rect.zw);
    // Bias the whole overlap toward its advancing side, without reducing the
    // effect to the mover's perimeter or introducing a seam at its center.
    let along = dot(world - contact.rect.xy, direction) / max(extent, pixel);
    let leading = mix(0.45, 1.0, smoothstep(-1.0, 1.0, along));
    let front = mix(-extent, extent, contacts.timeline.z);
    let frontWidth = max(24.0 * pixel, extent * 0.45);
    let frontDistance = dot(world - contact.rect.xy, direction) - front;
    let crossingWave = 0.25 + 0.75 * exp(-frontDistance * frontDistance / (2.0 * frontWidth * frontWidth));
    result.rgbPulse = rgbPulse * coherence * select(crossingWave, leading, motion);
    result.rgbFlow = direction;
    result.rgbRadius = select(0.0, contact.axis.z * (0.5 + contact.metric.y), motion);
    result.rgbWidth = select(18.0, 14.0 + 12.0 * contact.metric.y, motion);
    result.wakePulse = wakePulse;
    result.radius = select(6.0 + (contacts.timeline.z * 0.25 + contacts.timeline.w) * 96.0, 6.0 + contact.axis.z, motion);
    result.phase = select(0.0, contact.metric.w, motion);
    result.flow = select(result.normal * contacts.timeline.y, contact.axis.xy, motion);
  }
  return result;
}
struct CrossingPaint {
  slice: u32,
  selected: u32,
  debug: u32,
  border: vec2f,
}
fn crossingSample(uv: vec2f, paint: CrossingPaint) -> vec4f {
  let outside = any(uv < vec2f(0.0)) || any(uv > vec2f(1.0));
  if (paint.selected == 1u && outside && all(uv >= -paint.border) && all(uv <= vec2f(1.0) + paint.border)) {
    let blue = vec3f(59.0 / 255.0, 130.0 / 255.0, 246.0 / 255.0);
    return vec4f(select(blue, vec3f(1.0, 0.0, 0.0), paint.debug == 1u), 1.0);
  }
  let color = textureSample(entityTexture, entitySampler, clamp(uv, vec2f(0.0), vec2f(1.0)));
  return color * select(0.0, 1.0, all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)));
}
fn crossingMaterial(uv: vec2f, world: vec2f, key: u32, size: vec2f, pose: vec2f, paint: CrossingPaint) -> vec4f {
  if (contacts.header.x == 0.0) { return crossingSample(uv, paint); }
  let field = crossingField(world, key);
  if (field.pixel == 0.0) { return crossingSample(uv, paint); }
  let pixel = vec2f(field.pixel) / max(size, vec2f(1.0));
  let local = (uv - 0.5) * size;
  let ownDistance = contactDistance(local, size * 0.5);
  let seamDistance = max(ownDistance, field.distance);
  let worldNormal = select(field.normal, contactRotate(contactNormal(local, size * 0.5), pose), ownDistance > field.distance);
  let normal = contactLocal(worldNormal, pose);
  // A subtle displacement is shared by all three color samples. RGB refraction
  // stays coherent with the moving wake rather than compositing a second image.
  let waveDistance = abs(field.distance / field.pixel) - field.radius;
  let width = contacts.tuning.y;
  let packet = exp(-waveDistance * waveDistance / (2.0 * width * width)) * sin((waveDistance - field.phase) / (width * 0.643));
  let wakeAmplitude = field.wakePulse * contacts.header.w;
  let warp = contactLocal(field.flow, pose) * pixel * packet * wakeAmplitude * 9.0;

  let d = seamDistance / field.pixel - field.rgbRadius;
  let band = exp(-d * d / (2.0 * field.rgbWidth * field.rgbWidth));
  // Carry color through the overlap interior as well as its contact rim.
  let influence = max(band, 0.65 * field.coverage);
  let energy = field.rgbPulse * influence * contacts.header.y;
  let bend = normal * pixel * energy * 5.0 * field.role;
  let split = contactLocal(field.rgbFlow, pose) * pixel * energy * contacts.tuning.x;
  let base = crossingSample(uv + warp + bend, paint);
  let red = crossingSample(uv + warp + bend + split, paint);
  let blue = crossingSample(uv + warp + bend - split, paint);
  let rgb = vec3f(red.r * red.a, base.g * base.a, blue.b * blue.a) / max(base.a, 0.001);
  if (energy < 0.001) { return vec4f(rgb, base.a); }
  // A short exposure trail stretches detail behind the advancing contact.
  // Weight colors by alpha, but retain the material's own coverage: smearing
  // must not fill transparent cutouts or open another hole through the stack.
  let trail = contactLocal(field.rgbFlow, pose) * pixel * min(energy * 40.0, 24.0);
  let near = crossingSample(uv + warp + bend - trail * 0.33, paint);
  let middle = crossingSample(uv + warp + bend - trail * 0.67, paint);
  let far = crossingSample(uv + warp + bend - trail, paint);
  let coverage = base.a * 0.4 + near.a * 0.3 + middle.a * 0.2 + far.a * 0.1;
  let exposed = (base.rgb * base.a * 0.4 + near.rgb * near.a * 0.3 + middle.rgb * middle.a * 0.2 + far.rgb * far.a * 0.1) / max(coverage, 0.001);
  return vec4f(mix(rgb, exposed, min(energy * 1.5, 0.55)), base.a);
}

// Partition the lifted material between draws below/above each covering card.
// For alpha a, a lower slice with weight w and remaining weight r above it uses
// a*w/(1-a*r). Source-over then preserves the original alpha exactly, including
// transparent partners and feathered edges. Covering cards keep their own alpha.
fn crossingAlpha(world: vec2f, key: u32, alpha: f32, slice: u32) -> f32 {
  if (slice == 0u) { return alpha; }
  var previous = 1.0;
  var below = 1.0;
  var above = 0.0;
  var found = slice == 1u;
  for (var i = 0u; i < u32(contacts.header.x); i++) {
    let contact = contacts.items[i];
    if (contact.pose.w <= 0.0 || u32(contact.pose.z) != key) { continue; }
    let lift = contacts.timeline.x;
    let depth = lift - contact.metric.y;
    let activity = 4.0 * lift * (1.0 - lift);
    let along = dot(world - contact.axis.zw, contact.axis.xy) / contact.metric.w;
    let across = dot(world - contact.axis.zw, vec2f(-contact.axis.y, contact.axis.x)) / contact.metric.w;
    let ripple = 0.12 * sin(across * 8.0 - lift * 6.0) * min(contacts.header.w, 1.0);
    let travel = depth + (along + ripple) * activity * 0.28;
    let width = min(0.14, min(contact.metric.y, 1.0 - contact.metric.y) * 0.8);
    // A pixel cannot pass a higher layer before it passes the lower layers.
    let passage = min(previous, smoothstep(-width, width, travel));
    if (found) { above = passage; break; }
    if (slice == i + 2u) { below = passage; found = true; }
    previous = passage;
  }
  return alpha * max(below - above, 0.0) / max(1.0 - alpha * above, 0.000001);
}
fn crossingColor(uv: vec2f, world: vec2f, key: u32, size: vec2f, pose: vec2f, paint: CrossingPaint) -> vec4f {
  let color = crossingMaterial(uv, world, key, size, pose, paint);
  return vec4f(color.rgb, crossingAlpha(world, key, color.a, paint.slice));
}
